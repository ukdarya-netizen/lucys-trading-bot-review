/**
 * The executor (owner 2026-11-02: rewritten from scratch).
 *
 * A signal is entered the moment it arrives, for every account in parallel:
 *   isolated + 10x on the symbol → one limit IOC order (cap ±0.5%) with the
 *   source stop attached → read the position → if liquidation is not beyond
 *   the stop, add isolated margin until it is (or close if that cannot be
 *   done) → place the take (+5/+8/+10 %) for take strategies.
 * Source commands (move_stop, close, partial close, cancel_entry) are applied
 * as they arrive; the source position sync is polled as a backup.
 * Every 20 s each account is reconciled with the exchange: closes by stop /
 * take / liquidation / by hand are booked with the real exit, a missing stop
 * or take is placed again, an entry interrupted by a restart is adopted.
 * Work on one symbol never waits for another symbol or another account.
 * Nihilist (owner 2026-11-03) has its own settings (ex_source_settings): on/
 * off, size, subscribers, and a strategy — "source" (Nihilist leads by its
 * commands) or one the bot manages itself on the live price (manage()).
 */
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { BingXError, decimalAt, exSymbol, type BingX, type Order, type Position } from "./bingx";
import { LEVERAGE, marginFor, type Account } from "./accounts";
import {
  SIGNAL_TTL_MS, closeSide, entryLimitPrice, entryQuantity, liquidationSafe, manageStep, movePct, nihilistStrategy, openSide, pnl, posSide, stopValid,
  takeFor, takePrice, topUpAmount, type Side,
} from "./plan";
import {
  activeTrades, createTrade, event, getBtcSettings, getSourceSettings, symbolBusy, tradeById, tradesForSignal, updateTrade, type Trade,
} from "./store";
import { fmt, pct, type Sender } from "./telegram";
import { closeLine, resultLine, stopCloseKey, stopKindFor, stopMoveLine, type StopKind } from "./texts";

export type SignalIn = {
  sourceSignalId: string; source: string; symbol: string; side: Side; pattern: string | null;
  signalAt: number; stop: number; receivedAt: number;
  /** When the source released the signal (its message). Freshness is counted from here,
   *  never from the candle / detection time in signalAt (owner 2026-11-03). */
  releasedAt: number;
  /** Source's holding time in hours (Nihilist exitRules.maxHoldHours), null when none. */
  maxHoldH?: number | null;
};
export type CommandIn = {
  commandId: string; sourceSignalId: string; symbol: string; type: "close" | "move_stop" | "cancel_entry";
  seq: number | null; at: number; reason: string; stopPrice: number | null; fraction: number | null;
};

type Runtime = { acct: Account; ex: BingX; locks: Map<string, Promise<unknown>>; hedge?: boolean };

export const REASON_TEXT: Record<string, string> = {
  stale: "сигнал дошёл позже 10 минут после сообщения источника",
  already_in_position: "по монете уже открыта позиция",
  no_contract: "монеты нет на BingX",
  symbol_scale_mismatch: "на BingX монета с другим числом нулей, но цены не сходятся — не торгуем",
  pattern_not_in_strategy: "паттерн не в стратегии",
  stop_beyond_price: "цена уже за стопом",
  no_funds: "не хватает свободной маржи",
  below_min_quantity: "размер меньше минимального лота",
  below_min_notional: "сумма меньше минимальной на бирже",
  not_filled: "цена ушла больше чем на 0,5% — ордер не исполнился",
  entry_rejected: "биржа отклонила ордер",
  entry_not_found: "ордер не найден на бирже",
  source_cancelled: "сигнал отменён источником",
  source_disabled: "торговля по этому источнику выключена в настройках",
  account_paused: "новые входы по счёту остановлены в кабинете",
  btc_disabled: "торговля биткоином по этому источнику выключена в настройках",
  one_way_mode: "на счёте BingX включён односторонний режим позиций, а нужен раздельный (Hedge) — переключите в настройках фьючерсов BingX",
  error: "ошибка",
};

export function createExecutor(deps: {
  loadAccounts: () => Promise<Account[]>;
  entryAllowed: (account: Account, releasedAt: number, source: string) => Promise<boolean>;
  bingx: (a: Account) => BingX;
  send: Sender;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const runtimes = new Map<string, Runtime>();

  async function refreshAccounts(): Promise<Runtime[]> {
    const list = await deps.loadAccounts();
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) {
      const rt = runtimes.get(a.id);
      if (!rt || rt.acct.key !== a.key || rt.acct.secret !== a.secret) runtimes.set(a.id, { acct: a, ex: deps.bingx(a), locks: rt?.locks ?? new Map() });
      else rt.acct = a;
    }
    for (const id of [...runtimes.keys()]) if (!ids.has(id)) runtimes.delete(id);
    return [...runtimes.values()];
  }

  /** Serializes the work of one account on one symbol; other symbols run in parallel. */
  function withLock<T>(rt: Runtime, symbol: string, fn: () => Promise<T>): Promise<T> {
    const prev = rt.locks.get(symbol) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    rt.locks.set(symbol, next.catch(() => undefined));
    return next;
  }

  // Every message names the signal source (owner 2026-11-03: two bots — CAB and Nihilist).
  const SRC: Record<string, string> = { cab: "CAB", nihilist: "Нигилист" };
  const head = (rt: Runtime, t: { symbol: string; source?: string }) =>
    `${t.source ? `${SRC[t.source] ?? t.source} · ` : ""}${t.symbol.replace(/-?USDT$/, "")} · ${rt.acct.label}`;
  const say = (text: string) => deps.send(text).catch(() => undefined);
  // Price factor of a trade whose symbol differs on BingX (source price × factor = BingX price).
  const factors = new Map<number, number>();
  async function factorOf(t: { id: number }): Promise<number> {
    const known = factors.get(t.id);
    if (known !== undefined) return known;
    const r = await pool.query("SELECT detail FROM ex_events WHERE trade_id = $1 AND kind = 'symbol_mapped' ORDER BY id DESC LIMIT 1", [t.id]);
    const f = Number(r.rows[0]?.detail?.factor);
    const v = Number.isFinite(f) && f > 0 ? f : 1;
    factors.set(t.id, v);
    return v;
  }
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
  const hasEvent = async (tradeId: number, kind: string) =>
    ((await pool.query("SELECT 1 FROM ex_events WHERE trade_id = $1 AND kind = $2 LIMIT 1", [tradeId, kind])).rowCount ?? 0) > 0;

  async function skip(rt: Runtime, t: Trade, reason: string, notify = true, detail = ""): Promise<void> {
    await updateTrade(t.id, { status: "skipped", reason });
    await event(rt.acct.id, t, "skipped", { reason, detail });
    if (notify) await say(`${head(rt, t)}\nПозиция не открыта.\nПричина: ${REASON_TEXT[reason] ?? reason}${detail ? ` (${detail})` : ""}`);
  }
  async function fail(rt: Runtime, t: Trade, reason: string, detail = ""): Promise<void> {
    await updateTrade(t.id, { status: "failed", reason });
    await event(rt.acct.id, t, "failed", { reason, detail });
    await say(`${head(rt, t)}\nПозиция не открыта.\nПричина: ${REASON_TEXT[reason] ?? reason}${detail ? ` (${detail})` : ""}`);
  }

  const clientId = (rt: Runtime, sourceSignalId: string) =>
    `ex${createHash("sha1").update(`${rt.acct.id}|${sourceSignalId}`).digest("hex").slice(0, 24)}`;

  async function findPosition(rt: Runtime, t: Trade, p: "entry" | "protect" | "normal" = "protect"): Promise<Position | null> {
    const list = await rt.ex.positions(t.symbol, p);
    return list.find((x) => x.symbol === exSymbol(t.symbol) && x.positionSide === posSide(t.side)) ?? null;
  }

  // ---------------- entry ----------------
  async function enter(rt: Runtime, sigIn: SignalIn): Promise<void> {
    const a = rt.acct;
    if (sigIn.releasedAt < a.startedAt) return;
    // Owner 2026-11-06: an account opens trades only for its own bots (the owner sets an account per bot).
    if (!a.sources.has(sigIn.source)) return;
    if (!await deps.entryAllowed(a, sigIn.releasedAt, sigIn.source).catch(() => false)) return;
    // Another number of zeros on BingX (1000000MOG ↔ MOG, LUNC): BingX's symbol, prices rescaled.
    // A network error here is not «no such coin»: go on with the symbol as sent (the entry reports its own error).
    const mapped = await rt.ex.resolveSymbol(sigIn.symbol, "entry").catch(() => ({ symbol: sigIn.symbol, factor: 1 }));
    const sig: SignalIn = mapped && mapped.symbol !== sigIn.symbol
      ? { ...sigIn, symbol: mapped.symbol, stop: sigIn.stop * mapped.factor }
      : sigIn;
    // Nihilist: its own settings (owner 2026-11-03) — on/off, size, strategy, subscribers apart from CAB.
    // Every source has its own settings (owner 2026-11-03): on/off, size, subscribers; Nihilist also its strategy.
    const src = await getSourceSettings(sig.source);
    // A subscriber trades only the sources they chose, and only those the owner opened to subscribers.
    if (a.subscriberId !== null && (!a.sources.has(sig.source) || !src.subscribers)) return;
    const nh = sig.source === "nihilist" ? src : null;
    const mgmt = nh ? nihilistStrategy(nh.strategy) : null;
    const t = await createTrade({
      account_id: a.id, source: sig.source, source_signal_id: sig.sourceSignalId, symbol: sig.symbol, side: sig.side,
      // Nihilist manages its own exits (break-even +5%, trailing from +15%, holding time) by commands:
      // the account's take is not applied to it (owner 2026-11-03).
      // Nihilist: the take of its strategy (none when Nihilist leads); CAB: the account's take.
      pattern: sig.pattern, env: a.env, take_pct: mgmt ? (mgmt.id === "source" ? null : mgmt.take) : takeFor(a.strategy, sig.symbol), signal_at: new Date(sig.signalAt),
      received_at: new Date(sig.receivedAt), stop_price: sig.stop, mgmt: mgmt?.id ?? null, max_hold_h: sig.maxHoldH ?? null,
    });
    if (!t) return; // already handled
    try {
      // The owner's per-bot on/off is checked in entryAllowed (owner 2026-11-06); src.enabled is no longer a gate.
      if (now() - sig.releasedAt > SIGNAL_TTL_MS) return skip(rt, t, "stale");
      if (sig.source === "cab" && a.strategy.patterns && (!sig.pattern || !a.strategy.patterns.has(sig.pattern))) return skip(rt, t, "pattern_not_in_strategy", false);
      if (!mapped) return skip(rt, t, "no_contract", true, `${exSymbol(sigIn.symbol)} на BingX не найден ни с каким числом нулей`);
      if (sig.symbol !== sigIn.symbol) {
        await event(a.id, t, "symbol_mapped", { from: sigIn.symbol, to: sig.symbol, factor: mapped.factor, sourceStop: sigIn.stop, stop: sig.stop });
        factors.set(t.id, mapped.factor);
      }
      if (await symbolBusy(a.id, sig.symbol, sig.side, t.id)) return skip(rt, t, "already_in_position");
      // Bitcoin: its own settings per user and source (owner 2026-11-03) — 50x unless changed.
      const btc = isBtc(sig.symbol)
        ? (await getBtcSettings(a.subscriberId === null ? "owner" : `sub-${a.subscriberId}`)).find((x) => x.source === sig.source) ?? null
        : null;
      if (btc && !btc.enabled) return skip(rt, t, "btc_disabled", false);
      const leverage = btc ? btc.leverage : LEVERAGE;

      // Hedge mode once per account (checked again after a failure).
      if (!rt.hedge) {
        rt.hedge = await rt.ex.ensureHedgeMode("entry").catch(() => false);
        if (!rt.hedge) return skip(rt, t, "one_way_mode");
      }
      const [c, q, bal] = await Promise.all([
        rt.ex.contract(sig.symbol, "entry"), rt.ex.ticker(sig.symbol, "entry"), rt.ex.balance("entry"),
        rt.ex.ensureIsolated(sig.symbol, posSide(sig.side), leverage, "entry"),
      ]);
      const price = sig.side === "long" ? q.ask : q.bid;
      if (!stopValid(sig.side, sig.stop, price)) return skip(rt, t, "stop_beyond_price", true, `цена ${fmt(price)}, стоп ${fmt(sig.stop)}`);
      // A wrong number of zeros would put the stop absurdly far: never trade on it.
      if (sig.symbol !== sigIn.symbol && Math.abs(price - sig.stop) / price > 0.5) {
        return skip(rt, t, "symbol_scale_mismatch", true, `${sigIn.symbol} → ${sig.symbol}: цена ${fmt(price)}, стоп после пересчёта ${fmt(sig.stop)}`);
      }
      // The owner's account takes Nihilist's own size; a subscriber keeps the size of their cabinet.
      const margin = btc && btc.allocationMode && btc.allocationValue
        ? marginFor({ ...a, allocation: { mode: btc.allocationMode, value: btc.allocationValue } }, bal.equity)
        : a.subscriberId === null ? marginFor({ ...a, allocation: { mode: src.allocationMode, value: src.allocationValue } }, bal.equity) : marginFor(a, bal.equity);
      if (!(margin > 0) || margin > bal.available) return skip(rt, t, "no_funds", true, `нужно ${margin.toFixed(2)}, свободно ${fmt(bal.available)}`);
      // The exchange's cap on position value at this leverage (101209): the size is cut to it, never rejected.
      const cap = await rt.ex.maxPositionValue(sig.symbol, posSide(sig.side), "entry").catch(() => null);
      const wanted = margin * leverage;
      const capped = cap !== null && wanted > cap * 0.98;
      const size = entryQuantity({ marginUsd: capped ? (cap! * 0.98) / leverage : margin, leverage }, price, c);
      if (capped) await event(a.id, t, "size_capped", { wanted, cap });
      await updateTrade(t.id, { leverage });
      if ("error" in size) return skip(rt, t, size.error);

      const cid = clientId(rt, sig.sourceSignalId);
      const params = {
        symbol: exSymbol(sig.symbol), side: openSide(sig.side), positionSide: posSide(sig.side), type: "LIMIT", timeInForce: "IOC",
        price: entryLimitPrice(sig.side, q, c), quantity: size.qty, clientOrderId: cid,
        stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: Number(decimalAt(sig.stop, c.pricePrecision)), workingType: "MARK_PRICE" }),
      };
      let order: Order | null = null;
      // Recheck after exchange preparation; a pause also stops work queued before the click.
      if (!await deps.entryAllowed(a, sig.releasedAt, sig.source).catch(() => false)) {
        return skip(rt, t, "account_paused", false);
      }
      await updateTrade(t.id, { client_order_id: cid, entry_sent_at: new Date(now()) });
      try {
        order = await rt.ex.placeOrder(params, "entry");
      } catch (e) {
        if (!(e instanceof BingXError) || !e.ambiguous) return fail(rt, t, "entry_rejected", e instanceof Error ? e.message : "");
        // The order may be on the exchange: look for it by its id, never send a second one.
        for (let i = 0; i < 4 && !order; i++) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
          order = await rt.ex.queryOrder(sig.symbol, { clientOrderId: cid }, "entry").catch(() => null);
        }
        if (!order) {
          await updateTrade(t.id, { status: "unknown", reason: "entry_ambiguous" });
          await event(a.id, t, "entry_ambiguous", { message: e.message });
          return; // the reconciler adopts the position if it exists, else fails the trade
        }
      }
      if (!(order.executedQty > 0) || !["FILLED", "PARTIALLY_FILLED"].includes(order.status)) {
        const again = order.orderId ? await rt.ex.queryOrder(sig.symbol, { orderId: order.orderId }, "entry").catch(() => null) : null;
        if (again) order = again;
      }
      await updateTrade(t.id, { entry_order_id: order.orderId || null });
      if (!(order.executedQty > 0)) return fail(rt, t, "not_filled");
      await event(a.id, t, "entry_filled", { orderId: order.orderId, qty: order.executedQty, avg: order.avgPrice });
      await protect(rt, (await tradeById(t.id))!, true);
    } catch (e) {
      log("executor: entry failed", e);
      const cur = await tradeById(t.id);
      if (cur && cur.entry_sent_at) {
        // An order may exist: let the reconciler decide from the exchange.
        await updateTrade(t.id, { status: "unknown", reason: "entry_error" });
        await event(a.id, t, "entry_error", { message: errText(e) });
        await say(`${head(rt, cur)}\nОрдер на вход отправлен, но настройка позиции прервалась: ${errText(e)}\nБот сверит позицию с биржей и закончит защиту в течение минуты.`);
      } else if (cur) {
        await fail(rt, cur, "error", e instanceof Error ? e.message.slice(0, 160) : "");
      }
    }
  }

  // ---------------- protection after the fill ----------------
  async function protect(rt: Runtime, t: Trade, announce: boolean): Promise<void> {
    const pos = await findPosition(rt, t);
    if (!pos) { await updateTrade(t.id, { status: "closing" }); return; } // closed already (stop in the first seconds): reconcile books it
    let cur = await updateTrade(t.id, {
      status: "open", qty: pos.qty, initial_qty: t.initial_qty ?? pos.qty, entry_price: pos.avgPrice,
      opened_at: t.opened_at ?? new Date(now()), liquidation_price: pos.liquidationPrice, margin: pos.margin,
    });
    await ensureStop(rt, cur, pos);
    const kept = await keepLiquidationBeyondStop(rt, cur, pos);
    if (!kept) return;
    const added = kept.added;
    const p = kept.pos;
    cur = kept.trade;
    let takeError = "";
    if (cur.take_pct) {
      try { await ensureTake(rt, cur, p); } catch (e) {
        takeError = errText(e);
        await event(rt.acct.id, cur, "take_error", { message: takeError });
      }
    }
    cur = (await tradeById(t.id))!;
    await event(rt.acct.id, cur, "opened", { entry: cur.entry_price, qty: cur.qty, stop: cur.stop_price, take: cur.take_price, liq: cur.liquidation_price, added });
    if (announce) {
      const capEv = await pool.query("SELECT detail FROM ex_events WHERE trade_id = $1 AND kind = 'size_capped' ORDER BY id DESC LIMIT 1", [cur.id]).catch(() => ({ rows: [] as any[] }));
      const capDetail = capEv.rows[0]?.detail as { wanted?: number; cap?: number } | undefined;
      const capNote = capDetail?.cap ? `Размер урезан до лимита биржи для этого плеча: позиция до ${fmt(capDetail.cap)} USDT (хотели ${fmt(capDetail.wanted)})` : "";
      const mapEv = await pool.query("SELECT detail FROM ex_events WHERE trade_id = $1 AND kind = 'symbol_mapped' ORDER BY id DESC LIMIT 1", [cur.id]).catch(() => ({ rows: [] as any[] }));
      const mapDetail = mapEv.rows[0]?.detail as { from?: string; to?: string; factor?: number } | undefined;
      const mapNote = mapDetail?.from ? `Сигнал по ${mapDetail.from.replace(/USDT$/, "")}, на BingX — ${String(mapDetail.to).replace(/USDT$/, "")}: цены пересчитаны (×${mapDetail.factor})` : "";
      const late = cur.entry_sent_at ? (cur.entry_sent_at.getTime() - cur.received_at.getTime()) / 1000 : null;
      await say([
        `${head(rt, cur)}`,
        `Открыт ${cur.side === "long" ? "лонг" : "шорт"}: вход ${fmt(cur.entry_price)}, объём ${fmt(cur.qty)}`,
        `Стоп ${fmt(cur.stop_price)} (${pct(movePct(cur.side, cur.entry_price!, cur.stop_price!))}) · ликвидация ${fmt(cur.liquidation_price)}`,
        `Маржа ${fmt(cur.margin, 4)}${added ? ` (долито ${added.toFixed(2)})` : ""} · плечо ${cur.leverage ?? LEVERAGE}x`,
        capNote,
        mapNote,
        cur.take_price ? `Тейк ${fmt(cur.take_price)} (+${cur.take_pct}%)`
          : takeError ? `Тейк +${cur.take_pct}% не выставлен: ${takeError}. Бот повторит через 20 с` : "Тейка нет: выход по стопу и командам источника",
        cur.mgmt && cur.mgmt !== "source" ? `Ведёт торговый бот: ${nihilistStrategy(cur.mgmt).label}` : cur.mgmt === "source" ? "Ведёт Нигилист: его стопы и закрытия" : "",
        late !== null ? `Ордер отправлен через ${late.toFixed(1)} с после получения сигнала` : "",
      ].filter(Boolean).join("\n"));
    }
  }

  /**
   * Liquidation must stay beyond the stop for the whole life of the position, not only at the open:
   * funding fees and fees are taken from the isolated margin and pull the liquidation price towards
   * the stop (BingX "SL Failure Warning", owner 2026-11-07, GTCUSDT). Add isolated margin (no cap,
   * owner rule) or close. Returns null when the position was closed.
   */
  async function keepLiquidationBeyondStop(rt: Runtime, t: Trade, pos: Position): Promise<{ trade: Trade; pos: Position; added: number } | null> {
    if (!t.stop_price) return { trade: t, pos, added: 0 };
    const c = await rt.ex.contract(t.symbol, "protect");
    let added = 0;
    let p = pos;
    for (let i = 0; i < 3; i++) {
      const amount = topUpAmount({
        side: t.side, qty: p.qty, stop: t.stop_price, liquidation: p.liquidationPrice, entry: p.avgPrice,
        minIncrease: p.minIncreaseMargin, pricePrecision: c.pricePrecision,
      });
      if (Number(amount) <= 0) break;
      const bal = await rt.ex.balance("protect");
      if (Number(amount) > bal.available) { await closeMarket(rt, t, "no_margin_for_stop"); return null; }
      await rt.ex.addMargin(t.symbol, posSide(t.side), amount, "protect");
      added += Number(amount);
      await event(rt.acct.id, t, "margin_added", { amount, liquidationBefore: p.liquidationPrice });
      const again = await findPosition(rt, t);
      if (!again) break;
      p = again;
    }
    if (!liquidationSafe(t.side, p.liquidationPrice, t.stop_price, p.avgPrice)) { await closeMarket(rt, t, "liquidation_before_stop"); return null; }
    const trade = added > 0 || p.liquidationPrice !== t.liquidation_price
      ? await updateTrade(t.id, { margin_added: (t.margin_added ?? 0) + added, liquidation_price: p.liquidationPrice, margin: p.margin })
      : t;
    return { trade, pos: p, added };
  }

  async function protectiveOrders(rt: Runtime, t: Trade): Promise<{ stops: Order[]; takes: Order[] }> {
    const list = await rt.ex.openOrders(t.symbol, "protect");
    const mine = list.filter((o) => o.positionSide === posSide(t.side) && o.side === closeSide(t.side));
    return { stops: mine.filter((o) => o.type === "STOP_MARKET" || o.type === "STOP"), takes: mine.filter((o) => o.type === "TAKE_PROFIT_MARKET" || o.type === "TAKE_PROFIT") };
  }

  async function placeStop(rt: Runtime, t: Trade, qty: number, stop: number): Promise<Order> {
    const c = await rt.ex.contract(t.symbol, "protect");
    return rt.ex.placeOrder({
      symbol: exSymbol(t.symbol), side: closeSide(t.side), positionSide: posSide(t.side), type: "STOP_MARKET",
      quantity: decimalAt(qty, c.quantityPrecision, "floor"), stopPrice: decimalAt(stop, c.pricePrecision), workingType: "MARK_PRICE",
    }, "protect");
  }

  async function ensureStop(rt: Runtime, t: Trade, pos: Position): Promise<void> {
    const { stops } = await protectiveOrders(rt, t);
    if (stops.length) return;
    const q = await rt.ex.ticker(t.symbol, "protect");
    const price = t.side === "long" ? q.bid : q.ask;
    // The stop is already passed: close at market, named like a fill of that stop.
    if (!stopValid(t.side, t.stop_price!, price)) { await closeMarket(rt, t, "stop_market"); return; }
    await placeStop(rt, t, pos.qty, t.stop_price!);
    await event(rt.acct.id, t, "stop_placed", { stop: t.stop_price });
  }

  async function ensureTake(rt: Runtime, t: Trade, pos: Position): Promise<void> {
    if (!t.take_pct || !t.entry_price) return;
    const { takes } = await protectiveOrders(rt, t);
    if (takes.length) return;
    const c = await rt.ex.contract(t.symbol, "protect");
    const tp = takePrice(t.side, t.entry_price, t.take_pct, c);
    await rt.ex.placeOrder({
      symbol: exSymbol(t.symbol), side: closeSide(t.side), positionSide: posSide(t.side), type: "TAKE_PROFIT_MARKET",
      quantity: decimalAt(pos.qty, c.quantityPrecision, "floor"), stopPrice: tp, workingType: "MARK_PRICE",
    }, "protect");
    await updateTrade(t.id, { take_price: Number(tp) });
  }

  async function replaceStop(rt: Runtime, t: Trade, newStop: number, why: string): Promise<void> {
    const pos = await findPosition(rt, t);
    if (!pos) return;
    const q = await rt.ex.ticker(t.symbol, "protect");
    const price = t.side === "long" ? q.bid : q.ask;
    const kind: StopKind = stopKindFor(why, t.side, t.entry_price, newStop);
    if (!stopValid(t.side, newStop, price)) {
      // The new stop is already behind the price: close at market, named like a fill of that stop.
      await updateTrade(t.id, { stop_price: newStop, stop_kind: kind });
      await closeMarket(rt, (await tradeById(t.id))!, "stop_market");
      return;
    }
    const { stops } = await protectiveOrders(rt, t);
    await placeStop(rt, t, pos.qty, newStop); // new first: never a moment without a stop
    for (const o of stops) await rt.ex.cancelOrder(t.symbol, o.orderId);
    const cur = await updateTrade(t.id, { stop_price: newStop, stop_kind: kind });
    await event(rt.acct.id, cur, "stop_moved", { stop: newStop, why, kind });
    await say(`${head(rt, cur)}\n${stopMoveLine(kind, movePct(cur.side, cur.entry_price!, newStop), cur.source)}\nНовый стоп: ${fmt(newStop)}`);
  }

  /** Market close of all (or `qty` of) the position. Booking happens in finalize(). */
  async function closeMarket(rt: Runtime, t: Trade, reason: string, qty?: number): Promise<void> {
    const pos = await findPosition(rt, t);
    if (!pos) { await updateTrade(t.id, { status: "closing", pending_close_reason: t.pending_close_reason ?? reason }); await finalize(rt, (await tradeById(t.id))!); return; }
    const c = await rt.ex.contract(t.symbol, "protect");
    const amount = qty === undefined ? pos.qty : Math.min(qty, pos.qty);
    const full = qty === undefined || amount >= pos.qty - 10 ** -c.quantityPrecision / 2;
    if (full) await updateTrade(t.id, { status: "closing", pending_close_reason: reason });
    await rt.ex.placeOrder({
      symbol: exSymbol(t.symbol), side: closeSide(t.side), positionSide: posSide(t.side), type: "MARKET",
      quantity: decimalAt(amount, c.quantityPrecision, "floor"),
    }, "protect");
    await event(rt.acct.id, t, full ? "close_sent" : "partial_close_sent", { reason, qty: amount });
    if (full) { await finalize(rt, (await tradeById(t.id))!); return; }
    // Partial: resize the stop and the take to what is left.
    const left = await findPosition(rt, t);
    if (!left) return;
    const { stops, takes } = await protectiveOrders(rt, t);
    for (const o of [...stops, ...takes]) await rt.ex.cancelOrder(t.symbol, o.orderId);
    const cur = await updateTrade(t.id, { qty: left.qty });
    await placeStop(rt, cur, left.qty, cur.stop_price!);
    if (cur.take_pct) await ensureTake(rt, cur, left);
    const q = await rt.ex.ticker(t.symbol, "normal").catch(() => null);
    const at = q && cur.entry_price ? movePct(cur.side, cur.entry_price, q.last) : null;
    await say([
      `${head(rt, cur)}`,
      `${closeLine(reason, { source: cur.source })}: закрыто ${fmt(amount)} из ${fmt(cur.initial_qty)}${at !== null ? ` при ${pct(at)} от входа` : ""}.`,
      `Осталось ${fmt(left.qty)}, стоп ${fmt(cur.stop_price)} (${pct(movePct(cur.side, cur.entry_price!, cur.stop_price!))} от входа).`,
    ].join("\n"));
  }

  /** Books a position that is gone from the exchange: real exit from the fills. */
  async function finalize(rt: Runtime, t: Trade): Promise<void> {
    if (t.status === "closed") return;
    const pos = await findPosition(rt, t, "normal");
    if (pos) return; // still open
    const since = (t.opened_at ?? t.entry_sent_at ?? t.received_at).getTime() - 1_000;
    // Owner 2026-11-06 (a position closed by hand stayed "open"): when BingX keeps refusing the order
    // history while the position is gone, the trade is booked closed after 3 minutes without the exit price,
    // instead of hanging open forever and blocking the account.
    const histFail: { error: string | null } = { error: null };
    const hist = await rt.ex.history(t.symbol, since, "normal").catch((e) => {
      if (now() - t.updated_at.getTime() < 180_000) throw e;
      histFail.error = errText(e);
      return [] as Order[];
    });
    const histError = histFail.error;
    const closing = hist.filter((o) => o.positionSide === posSide(t.side) && o.side === closeSide(t.side) && o.executedQty > 0 && o.avgPrice > 0)
      .sort((a, b) => a.updateTime - b.updateTime);
    if (!closing.length && now() - t.updated_at.getTime() < 60_000) return; // history can lag: next pass
    if (histError) await event(rt.acct.id, t, "history_unavailable", { message: histError });
    const qty = closing.reduce((s, o) => s + o.executedQty, 0);
    const exit = qty > 0 ? closing.reduce((s, o) => s + o.avgPrice * o.executedQty, 0) / qty : null;
    const last = closing[closing.length - 1];
    const type = (last?.type ?? "").toUpperCase();
    const entry = t.entry_price ?? exit ?? 0;
    // Named from what really happened: the order that closed it, why the stop stood there, the real exit.
    const lastPct = last && entry ? movePct(t.side, entry, last.avgPrice) : null;
    const reason = type.includes("LIQ") ? "liquidation"
      : type.startsWith("TAKE_PROFIT") ? "take"
        : type.startsWith("STOP") || t.pending_close_reason === "stop_market" ? stopCloseKey((t.stop_kind ?? "initial") as StopKind, lastPct)
          : t.pending_close_reason ?? "manual";
    const result = exit !== null ? closing.reduce((s, o) => s + pnl(t.side, entry, o.avgPrice, o.executedQty), 0) : null;
    // Leftover protective orders of this side.
    const open = await rt.ex.openOrders(t.symbol, "normal").catch(() => [] as Order[]);
    for (const o of open.filter((o) => o.positionSide === posSide(t.side))) await rt.ex.cancelOrder(t.symbol, o.orderId);
    const cur = await updateTrade(t.id, {
      status: "closed", closed_at: new Date(last?.updateTime || now()), exit_price: exit, pnl: result,
      pnl_pct: exit !== null && entry ? movePct(t.side, entry, exit) : null, close_reason: reason,
    });
    await event(rt.acct.id, cur, "closed", { reason, exit, pnl: result });
    const asset = rt.acct.env === "vst" ? "VST" : "USDT";
    await say([
      `${head(rt, cur)} · ${cur.side === "long" ? "лонг" : "шорт"}`,
      `Позиция закрыта. ${closeLine(reason, { source: cur.source, takePct: cur.take_pct })}.`,
      `Вход ${fmt(cur.entry_price)} → выход ${fmt(last?.avgPrice ?? exit)}${closing.length > 1 ? ` (средний выход по всем частям ${fmt(exit)})` : ""}`,
      resultLine(cur.pnl_pct, result, asset) + (cur.partial_done || closing.length > 1 ? " — с учётом частичных закрытий" : ""),
      histError ? `Цену выхода BingX не отдал (${histError}) — результат не посчитан, сверьте на бирже.` : "",
    ].filter(Boolean).join("\n"));
  }

  // ---------------- commands from the source ----------------
  async function applyCommand(rt: Runtime, t: Trade, cmd: CommandIn): Promise<void> {
    if (cmd.seq !== null && cmd.seq <= t.last_command_seq) return; // already applied (or older)
    const done = () => updateTrade(t.id, { last_command_seq: cmd.seq ?? t.last_command_seq });
    if (["closed", "skipped", "failed"].includes(t.status)) { await done(); return; }
    await event(rt.acct.id, t, "command", { ...cmd });
    // The bot manages this Nihilist trade itself: Nihilist's stop moves and closes are not followed,
    // except a close at the end of the holding time (the same limit as the bot's own).
    if (ownMgmt(t) && (cmd.type === "move_stop" || (cmd.type === "close" && cmd.reason !== "expired"))) { await done(); return; }
    if (cmd.type === "cancel_entry") {
      if (t.status === "opening") await skip(rt, t, "source_cancelled");
      else await closeMarket(rt, t, `source:${cmd.reason || "cancel"}`);
    } else if (cmd.type === "move_stop" && cmd.stopPrice !== null) {
      if (t.status === "open") await replaceStop(rt, t, cmd.stopPrice, cmd.reason);
      else await updateTrade(t.id, { stop_price: cmd.stopPrice });
    } else if (cmd.type === "close" && (t.status === "unknown" || t.status === "opening")) {
      await updateTrade(t.id, { pending_close_reason: `source:${cmd.reason || "close"}` }); // closed as soon as the entry is found
    } else if (cmd.type === "close") {
      const f = cmd.fraction ?? 1;
      if (f >= 0.999 || !t.initial_qty) await closeMarket(rt, t, `source:${cmd.reason || "close"}`);
      else await closeMarket(rt, t, `source:${cmd.reason || "close"}`, t.initial_qty * f);
    }
    await done();
  }

  // ---------------- own management of Nihilist trades ----------------
  /**
   * Every reconcile pass (20 s) for a trade the bot manages itself: the peak
   * from the live price, then holding time, partial fixation, break-even and
   * trailing per the trade's strategy (plan.ts manageStep).
   */
  async function manage(rt: Runtime, t: Trade): Promise<void> {
    if (t.status !== "open" || !t.entry_price || t.stop_price === null) return;
    const m = nihilistStrategy(t.mgmt);
    if (t.max_hold_h && t.opened_at && now() - t.opened_at.getTime() >= t.max_hold_h * 3_600_000) { await closeMarket(rt, t, "timeout"); return; }
    const q = await rt.ex.ticker(t.symbol, "normal");
    if (!(q.last > 0)) return;
    const peak = Math.max(t.peak_pct ?? 0, movePct(t.side, t.entry_price, q.last));
    let cur = peak > (t.peak_pct ?? 0) ? await updateTrade(t.id, { peak_pct: peak }) : t;
    const step = manageStep({ side: cur.side, entry: cur.entry_price!, stop: cur.stop_price!, peakPct: peak, partialDone: cur.partial_done, beMoved: cur.be_moved, m });
    const initialQty = cur.initial_qty;
    if (step.partial && m.partial && initialQty) {
      cur = await updateTrade(cur.id, { partial_done: true });
      await closeMarket(rt, cur, "take_partial", initialQty * m.partial.share);
      cur = (await tradeById(cur.id))!;
      if (cur.status !== "open") return;
    }
    if (step.be && !cur.be_moved) cur = await updateTrade(cur.id, { be_moved: true });
    if (step.stop !== null) await replaceStop(rt, cur, step.stop, step.be && !t.be_moved && !(m.trail && peak >= m.trail.act) ? "breakeven" : "trailing");
  }
  const ownMgmt = (t: Trade) => Boolean(t.mgmt && t.mgmt !== "source");
  const isBtc = (symbol: string) => /^BTC-?USDT$/.test(symbol);

  // ---------------- reconciliation ----------------
  async function reconcile(rt: Runtime): Promise<void> {
    const trades = await activeTrades(rt.acct.id);
    if (!trades.length) return;
    const all = await rt.ex.positions(undefined, "normal");
    // One request for the open orders of every symbol in this pass (BingX limits openOrders: 100410).
    await rt.ex.prefetchOpenOrders(trades.map((t) => t.symbol)).catch(() => undefined);
    await Promise.all(trades.map((t) => withLock(rt, t.symbol, async () => {
      const cur = await tradeById(t.id);
      if (!cur || !["opening", "open", "closing", "unknown"].includes(cur.status)) return;
      const pos = all.find((p) => p.symbol === exSymbol(cur.symbol) && p.positionSide === posSide(cur.side)) ?? null;
      const age = now() - (cur.entry_sent_at ?? cur.received_at).getTime();
      if (cur.status === "opening" || cur.status === "unknown") {
        if (age < 30_000 && cur.status === "opening") return; // entry still running
        if (pos) {
          await event(rt.acct.id, cur, "adopted", { qty: pos.qty });
          await protect(rt, cur, true);
          const after = await tradeById(cur.id);
          // The source closed it while we did not know the entry: close now.
          if (after?.status === "open" && after.pending_close_reason?.startsWith("source")) await closeMarket(rt, after, after.pending_close_reason);
          return;
        }
        if (age > 120_000 || cur.status === "opening") {
          const order = cur.client_order_id ? await rt.ex.queryOrder(cur.symbol, { clientOrderId: cur.client_order_id }).catch(() => null) : null;
          if (order && order.executedQty > 0) { await updateTrade(cur.id, { status: "closing", entry_price: order.avgPrice, qty: order.executedQty, initial_qty: order.executedQty, opened_at: new Date(order.time || now()) }); await finalize(rt, (await tradeById(cur.id))!); return; }
          await fail(rt, cur, "entry_not_found");
        }
        return;
      }
      if (!pos) { await finalize(rt, cur); return; }
      if (cur.status === "closing") {
        // Close sent but the position is still there after a minute: send it again.
        if (now() - cur.updated_at.getTime() > 60_000) await closeMarket(rt, cur, cur.pending_close_reason ?? "source");
        return;
      }
      // Opened but never announced (protection broke off): finish it the same way, with the message.
      if (!(await hasEvent(cur.id, "opened"))) { await protect(rt, cur, true); return; }
      if (Math.abs(pos.qty - (cur.qty ?? 0)) > 1e-12) await updateTrade(cur.id, { qty: pos.qty });
      await ensureStop(rt, cur, pos);
      const kept = await keepLiquidationBeyondStop(rt, (await tradeById(cur.id))!, pos);
      if (!kept) return;
      if (kept.added > 0) {
        await say(`${head(rt, kept.trade)}\nЛиквидация подошла к стопу (комиссии и фандинг съели маржу): долито ${kept.added.toFixed(2)} USDT\nСтоп ${fmt(kept.trade.stop_price)} · ликвидация теперь ${fmt(kept.pos.liquidationPrice)}`);
      }
      if (cur.take_pct) await ensureTake(rt, cur, pos);
      if (ownMgmt(cur)) await manage(rt, (await tradeById(cur.id))!);
    }).catch(async (e) => {
      log("executor: reconcile trade failed", e);
      // Kept for the owner (a repeated error is stored once a minute at most).
      const last = await pool.query("SELECT 1 FROM ex_events WHERE trade_id = $1 AND kind = 'reconcile_error' AND created_at > now() - interval '1 minute'", [t.id]).catch(() => ({ rowCount: 1 }));
      if (!last.rowCount) await event(rt.acct.id, t, "reconcile_error", { message: errText(e) }).catch(() => undefined);
    })));
  }

  // ---------------- public ----------------
  async function onSignal(sig: SignalIn): Promise<void> {
    const rts = await refreshAccounts().catch(() => [...runtimes.values()]);
    await Promise.allSettled(rts.map((rt) => withLock(rt, sig.symbol, () => enter(rt, sig))));
  }

  async function onCommand(cmd: CommandIn): Promise<void> {
    const trades = await tradesForSignal(cmd.sourceSignalId);
    if (trades.some((t) => !runtimes.has(t.account_id))) await refreshAccounts().catch(() => undefined);
    await Promise.allSettled(trades.map(async (t) => {
      const rt = runtimes.get(t.account_id);
      if (!rt) return;
      await withLock(rt, t.symbol, async () => {
        const cur = await tradeById(t.id);
        const f = cur ? await factorOf(cur) : 1;
        const c = f !== 1 && cmd.stopPrice !== null ? { ...cmd, stopPrice: cmd.stopPrice * f } : cmd;
        if (cur) await applyCommand(rt, cur, c).catch((e) => { log("executor: command failed", e); void event(rt.acct.id, cur, "command_failed", { commandId: cmd.commandId, message: e instanceof Error ? e.message : String(e) }); });
      });
    }));
  }

  /** Source position sync (backup for a lost command): close what the source closed, follow a raised stop. */
  async function onSourceState(states: Array<{ sourceSignalId: string; action: string; stop: number | null }>): Promise<void> {
    const map = new Map(states.map((s) => [s.sourceSignalId, s]));
    for (const rt of runtimes.values()) {
      const trades = await activeTrades(rt.acct.id);
      for (const t of trades) {
        const s = map.get(t.source_signal_id);
        if (!s || t.status !== "open" || ownMgmt(t)) continue;
        await withLock(rt, t.symbol, async () => {
          const cur = await tradeById(t.id);
          if (!cur || cur.status !== "open") return;
          const stop = s.stop === null ? null : s.stop * (await factorOf(cur));
          if (s.action === "close") await closeMarket(rt, cur, "source_sync");
          else if (stop !== null && cur.stop_price !== null &&
            (cur.side === "long" ? stop > cur.stop_price * 1.0005 : stop < cur.stop_price * 0.9995)) {
            await replaceStop(rt, cur, stop, "source_sync");
          }
        }).catch((e) => log("executor: source sync failed", e));
      }
    }
  }

  /** Owner 2026-11-06: each account's result is returned, so Bot Health shows an account whose pass fails. */
  async function reconcileAll(): Promise<Array<{ id: string; label: string; ok: boolean; error: string | null }>> {
    const rts = await refreshAccounts().catch(() => [...runtimes.values()]);
    return Promise.all(rts.map((rt) => reconcile(rt)
      .then(() => ({ id: rt.acct.id, label: rt.acct.label, ok: true, error: null }))
      .catch((e) => { log(`executor: reconcile ${rt.acct.id} failed`, e); return { id: rt.acct.id, label: rt.acct.label, ok: false, error: errText(e) }; })));
  }

  return { onSignal, onCommand, onSourceState, reconcileAll, refreshAccounts, runtimes };
}

export type Executor = ReturnType<typeof createExecutor>;
