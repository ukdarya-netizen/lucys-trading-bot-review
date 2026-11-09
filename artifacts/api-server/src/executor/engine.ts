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
import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { BingXError, decimalAt, exSymbol, type BingX, type Order, type Position } from "./bingx";
import { LEVERAGE, marginFor, type Account } from "./accounts";
import {
  SIGNAL_TTL_MS, closeSide, entryLimitPrice, entryQuantity, liquidationSafe, manageStep, movePct, nihilistStrategy, openSide, pnl, posSide, stopValid,
  takeFor, takePrice, topUpAmount, type Side,
} from "./plan";
import {
  activeTrades, commandsForSignal, createTrade, event, getBtcSettings, getSourceSettings, symbolBusy, tradeById, tradesForSignal, updateTrade,
  updateTradeCommandSequence, type Trade,
} from "./store";
import { productionTrading } from "./trading-controls";
import { fmt, pct, type Sender } from "./telegram";
import { cancelKey, closeLine, isCancelReason, resultLine, stopCloseKey, stopKindFor, stopMoveLine, type StopKind } from "./texts";
import { parseCommand } from "./intake";
import { sourceActionKind, sourceSyncConfirmed, type SourceSyncStatus } from "./source-state";

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
  commandId: string; sourceSignalId: string; symbol: string; type: "close" | "move_stop" | "cancel_entry" | "position_review";
  seq: number | null; at: number; reason: string; stopPrice: number | null; fraction: number | null;
  /** position_review (source's view of a position): its action / tracker status. */
  sourceAction?: string | null; trackerStatus?: string | null;
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
  sourceSyncStatus?: (source: string) => SourceSyncStatus | null | undefined;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const runtimes = new Map<string, Runtime>();
  type ReconcileIssue = { source?: string; symbol?: string; message: string; kind?: "untracked" };
  type OrphanObservation = { count: number; at: number };
  const orphanObservations = new Map<string, OrphanObservation>();
  const lastIdlePositionAudit = new Map<string, number>();
  const ORPHAN_CONFIRMATIONS = 3;
  const ORPHAN_MIN_OBSERVATION_GAP_MS = 15_000;
  const ORPHAN_MAX_OBSERVATION_GAP_MS = 120_000;
  const ORPHAN_CLOSE_RETRY_MS = 60_000;
  const ORPHAN_CLOSE_MAX_ATTEMPTS_PER_HOUR = 3;
  const IDLE_POSITION_AUDIT_MS = 60_000;
  const RECONCILE_MATCH_NOTICE_COOLDOWN_MS = 10 * 60_000;

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
  async function reportReconcileIssues(rt: Runtime, issues: ReconcileIssue[]): Promise<void> {
    const accountId = rt.acct.id;
    let notice: string | null = null;
    const hasIssues = issues.length > 0;
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`reconcile-notice:${accountId}`]);
        const previous = await client.query<{ detail: Record<string, unknown> }>(
          "SELECT detail FROM ex_events WHERE account_id = $1 AND kind = 'reconcile_notice_state' ORDER BY id DESC LIMIT 1",
          [accountId],
        );
        const prior = previous.rows[0]?.detail ?? {};
        const priorState = String(prior.state ?? "");
        const incidentActive = Boolean(prior.incidentActive);
        let state: string;
        let cleanStreak: number;

        if (hasIssues) {
          state = "unverified";
          cleanStreak = 0;
          if (priorState === "unverified") {
            await client.query("COMMIT");
            return;
          }
        } else {
          if (priorState === "matched") {
            await client.query("COMMIT");
            return;
          }
          const priorAt = Date.parse(String(prior.updatedAt ?? ""));
          if (priorState === "recovering" && Number.isFinite(priorAt) && now() - priorAt < ORPHAN_MIN_OBSERVATION_GAP_MS) {
            await client.query("COMMIT");
            return;
          }
          cleanStreak = priorState === "recovering" ? Number(prior.cleanStreak ?? 0) + 1 : 1;
          state = cleanStreak >= ORPHAN_CONFIRMATIONS ? "matched" : "recovering";
          if (state === "matched") {
            const lastMatchedNoticeAt = Date.parse(String(prior.lastMatchedNoticeAt ?? ""));
            if (!Number.isFinite(lastMatchedNoticeAt) || now() - lastMatchedNoticeAt >= RECONCILE_MATCH_NOTICE_COOLDOWN_MS) {
              notice = `${rt.acct.label} · Сверка подтверждена: позиции этого счёта совпадают с BingX; синхронизация источников подтверждена.`;
              prior.lastMatchedNoticeAt = new Date(now()).toISOString();
            }
          }
        }

        await client.query(
          `INSERT INTO ex_events (account_id, trade_id, source_signal_id, symbol, kind, detail)
           VALUES ($1, NULL, NULL, NULL, 'reconcile_notice_state', $2)`,
          [accountId, JSON.stringify({
            state,
            cleanStreak,
            incidentActive: hasIssues || (state !== "matched" && incidentActive),
            message: issues[0]?.message ?? null,
            lastMatchedNoticeAt: prior.lastMatchedNoticeAt ?? null,
            updatedAt: new Date(now()).toISOString(),
          })],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      log("executor: reconcile notification state failed", e);
      return;
    }
    if (notice) await say(notice);
  }

  function resetOrphanObservations(accountId: string): void {
    const prefix = `${accountId}|`;
    for (const key of orphanObservations.keys()) {
      if (key.startsWith(prefix)) orphanObservations.delete(key);
    }
  }

  async function closeUntrackedPosition(rt: Runtime, position: Position): Promise<boolean> {
    // Automatic exchange closes are limited to the owner's real/demo accounts.
    // Subscriber and simulated accounts are never affected by this rule.
    if (!productionTrading() || !rt.acct.id.startsWith("owner-") || rt.acct.subscriberId !== null || rt.acct.paper) return false;

    const symbol = exSymbol(position.symbol);
    const side = position.positionSide;
    const lockKey = `orphan-close:${rt.acct.id}:${symbol}:${side}`;
    const client = await pool.connect().catch((e) => {
      log("executor: orphan close lock unavailable", e);
      return null;
    });
    if (!client) return false;
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      locked = true;

      const matchingTrade = (await activeTrades(rt.acct.id)).some((trade) =>
        exSymbol(trade.symbol) === symbol && posSide(trade.side) === side);
      if (matchingTrade) return true;

      const attempts = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ex_events
         WHERE account_id = $1 AND symbol = $2 AND kind = 'orphan_close_attempt'
           AND detail->>'positionSide' = $3 AND detail->>'clientOrderId' IS NOT NULL
           AND created_at > now() - interval '1 hour'`,
        [rt.acct.id, symbol, side],
      );
      if (Number(attempts.rows[0]?.count ?? 0) >= ORPHAN_CLOSE_MAX_ATTEMPTS_PER_HOUR) {
        log("executor: orphan close halted after attempt limit", { accountId: rt.acct.id, symbol, side });
        return false;
      }

      const lastAttempt = await client.query<{ detail: Record<string, unknown>; created_at: Date }>(
        `SELECT detail, created_at FROM ex_events
         WHERE account_id = $1 AND symbol = $2 AND kind = 'orphan_close_attempt'
           AND detail->>'positionSide' = $3
         ORDER BY id DESC LIMIT 1`,
        [rt.acct.id, symbol, side],
      );
      const priorAttempt = lastAttempt.rows[0];
      if (priorAttempt && now() - new Date(priorAttempt.created_at).getTime() < ORPHAN_CLOSE_RETRY_MS) return false;
      const priorClientOrderId = String(priorAttempt?.detail?.clientOrderId ?? "");
      if (priorClientOrderId) {
        // A timed-out market request may still have reached BingX. Never resend
        // while its order is pending or while order status cannot be read.
        const priorOrder = await rt.ex.queryOrder(symbol, { clientOrderId: priorClientOrderId }, "protect");
        if (priorOrder && !["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(priorOrder.status)) {
          const open = await rt.ex.openOrders(symbol, "protect");
          if (open.some((order) => order.orderId === priorOrder.orderId)) return false;
        }
      }

      const currentPositions = await rt.ex.positions(symbol, "protect");
      const current = currentPositions.find((item) => item.symbol === symbol && item.positionSide === side);
      const latestTrades = await activeTrades(rt.acct.id);
      if (latestTrades.some((trade) => exSymbol(trade.symbol) === symbol && posSide(trade.side) === side)) return true;
      if (!current) {
        await client.query(
          `INSERT INTO ex_events (account_id, trade_id, source_signal_id, symbol, kind, detail)
           VALUES ($1, NULL, NULL, $2, 'orphan_close_attempt', $3)`,
          [rt.acct.id, symbol, JSON.stringify({ positionSide: side, status: "position_absent", cleanupPending: true })],
        );
        return false;
      }

      const attemptRow = await client.query<{ id: number }>(
        `INSERT INTO ex_events (account_id, trade_id, source_signal_id, symbol, kind, detail)
         VALUES ($1, NULL, NULL, $2, 'orphan_close_attempt', $3) RETURNING id`,
        [rt.acct.id, symbol, JSON.stringify({ positionSide: side, qty: current.qty, status: "preflight", cleanupPending: true })],
      );
      const attemptId = attemptRow.rows[0]?.id;
      if (!attemptId) return false;

      const contract = await rt.ex.contract(symbol, "protect");
      const quantity = decimalAt(current.qty, contract.quantityPrecision, "floor");
      if (!(Number(quantity) > 0)) {
        await client.query(
          "UPDATE ex_events SET detail = detail || $2::jsonb WHERE id = $1",
          [attemptId, JSON.stringify({ status: "preflight_failed", error: "rounded quantity is zero", cleanupPending: true })],
        );
        return false;
      }
      const clientOrderId = `oc${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      await client.query(
        "UPDATE ex_events SET detail = detail || $2::jsonb WHERE id = $1",
        [attemptId, JSON.stringify({ clientOrderId, qty: Number(quantity), status: "pending", cleanupPending: true })],
      );

      try {
        const order = await rt.ex.placeOrder({
          symbol,
          side: side === "LONG" ? "SELL" : "BUY",
          positionSide: side,
          type: "MARKET",
          quantity,
          clientOrderId,
        }, "protect");
        await client.query(
          "UPDATE ex_events SET detail = detail || $2::jsonb WHERE id = $1",
          [attemptId, JSON.stringify({ status: "sent", orderId: order.orderId, executedQty: order.executedQty, cleanupPending: true })],
        );
        log("executor: orphan BingX position close sent", { accountId: rt.acct.id, symbol, side, qty: quantity, orderId: order.orderId });
      } catch (e) {
        await client.query(
          "UPDATE ex_events SET detail = detail || $2::jsonb WHERE id = $1",
          [attemptId, JSON.stringify({
            status: e instanceof BingXError && e.ambiguous ? "ambiguous" : "rejected",
            error: errText(e),
            cleanupPending: true,
          })],
        ).catch(() => undefined);
        log("executor: orphan BingX position close failed", { accountId: rt.acct.id, symbol, side, error: errText(e) });
      }
      return false;
    } catch (e) {
      log("executor: orphan position close check failed", { accountId: rt.acct.id, symbol, side, error: errText(e) });
      return false;
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async function cleanupPendingOrphanOrders(rt: Runtime, positions: Position[]): Promise<ReconcileIssue[]> {
    if (!productionTrading() || !rt.acct.id.startsWith("owner-") || rt.acct.subscriberId !== null || rt.acct.paper) return [];
    const pending = await pool.query<{ id: number; symbol: string; detail: Record<string, unknown> }>(
      `SELECT DISTINCT ON (symbol, detail->>'positionSide') id, symbol, detail
       FROM ex_events
       WHERE account_id = $1 AND kind = 'orphan_close_attempt' AND detail->>'cleanupPending' = 'true'
       ORDER BY symbol, detail->>'positionSide', id DESC`,
      [rt.acct.id],
    );
    const issues: ReconcileIssue[] = [];
    for (const row of pending.rows) {
      const symbol = exSymbol(row.symbol);
      const side = String(row.detail.positionSide ?? "");
      if (side !== "LONG" && side !== "SHORT") continue;
      if (positions.some((position) => position.symbol === symbol && position.positionSide === side)) continue;

      const lockKey = `orphan-close:${rt.acct.id}:${symbol}:${side}`;
      const client = await pool.connect().catch((e) => {
        log("executor: orphan order cleanup lock unavailable", e);
        return null;
      });
      if (!client) {
        issues.push({ symbol, kind: "untracked", message: "Protective order cleanup is not confirmed" });
        continue;
      }
      let locked = false;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
        locked = true;
        const currentEvent = await client.query<{ detail: Record<string, unknown> }>(
          "SELECT detail FROM ex_events WHERE id = $1 AND account_id = $2",
          [row.id, rt.acct.id],
        );
        const detail = currentEvent.rows[0]?.detail;
        if (!detail || detail.cleanupPending !== true) continue;
        const lastCleanupAt = Date.parse(String(detail.cleanupAttemptAt ?? ""));
        if (Number.isFinite(lastCleanupAt) && now() - lastCleanupAt < ORPHAN_CLOSE_RETRY_MS) {
          issues.push({ symbol, kind: "untracked", message: "Protective order cleanup is pending" });
          continue;
        }
        await client.query(
          `UPDATE ex_events SET detail = detail || $4::jsonb
           WHERE account_id = $1 AND symbol = $2 AND kind = 'orphan_close_attempt'
             AND detail->>'positionSide' = $3 AND detail->>'cleanupPending' = 'true'`,
          [rt.acct.id, symbol, side, JSON.stringify({ cleanupAttemptAt: new Date(now()).toISOString() })],
        );

        const active = await activeTrades(rt.acct.id);
        if (active.some((trade) => exSymbol(trade.symbol) === symbol && posSide(trade.side) === side)) {
          await client.query(
            `UPDATE ex_events SET detail = detail || '{"cleanupPending":false,"cleanupSkipped":"active_trade"}'::jsonb
             WHERE account_id = $1 AND symbol = $2 AND kind = 'orphan_close_attempt'
               AND detail->>'positionSide' = $3 AND detail->>'cleanupPending' = 'true'`,
            [rt.acct.id, symbol, side],
          );
          continue;
        }
        const fresh = await rt.ex.positions(symbol, "protect");
        if (fresh.some((position) => position.symbol === symbol && position.positionSide === side)) {
          issues.push({ symbol, kind: "untracked", message: "Position remains open; protective orders retained" });
          continue;
        }

        const open = await rt.ex.openOrders(symbol, "protect");
        const protective = open.filter((order) =>
          order.positionSide === side && /^(STOP|TAKE_PROFIT)/i.test(order.type));
        for (const order of protective) await rt.ex.cancelOrder(symbol, order.orderId);
        const remaining = await rt.ex.openOrders(symbol, "protect");
        const stillOpen = remaining.some((order) =>
          order.positionSide === side && /^(STOP|TAKE_PROFIT)/i.test(order.type));
        if (stillOpen) {
          issues.push({ symbol, kind: "untracked", message: "Protective orders remain open" });
          continue;
        }
        await client.query(
          `UPDATE ex_events SET detail = detail || $4::jsonb
           WHERE account_id = $1 AND symbol = $2 AND kind = 'orphan_close_attempt'
             AND detail->>'positionSide' = $3 AND detail->>'cleanupPending' = 'true'`,
          [rt.acct.id, symbol, side, JSON.stringify({
            cleanupPending: false,
            ordersCleanedAt: new Date(now()).toISOString(),
            cancelledOrderIds: protective.map((order) => order.orderId),
          })],
        );
        await say(`${rt.acct.label} · ${symbol.replace(/-/g, "")} ${side.toLowerCase()}: позиция закрыта после сверки с BingX; защитных заявок этой стороны не осталось. В «Открытых» записи не было.`);
      } catch (e) {
        log("executor: orphan protective order cleanup failed", { accountId: rt.acct.id, symbol, side, error: errText(e) });
        issues.push({ symbol, kind: "untracked", message: "Protective order cleanup failed" });
      } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
        client.release();
      }
    }
    return issues;
  }

  async function reportUntrackedPositions(rt: Runtime, trades: Trade[], positions: Position[]): Promise<ReconcileIssue[]> {
    const tracked = new Set(trades.map((trade) => `${exSymbol(trade.symbol)}:${posSide(trade.side)}`));
    const current = new Set<string>();
    const issues: ReconcileIssue[] = [];
    for (const position of positions) {
      if (!Number.isFinite(position.qty) || Math.abs(position.qty) <= 1e-12) continue;
      if (tracked.has(`${position.symbol}:${position.positionSide}`)) continue;
      const key = `${rt.acct.id}|${position.symbol}|${position.positionSide}`;
      current.add(key);
      const observedAt = now();
      const previous = orphanObservations.get(key);
      let count = 1;
      let at = observedAt;
      if (previous && observedAt - previous.at <= ORPHAN_MAX_OBSERVATION_GAP_MS) {
        if (observedAt - previous.at < ORPHAN_MIN_OBSERVATION_GAP_MS) {
          count = previous.count;
          at = previous.at;
        } else {
          count = previous.count + 1;
        }
      }
      orphanObservations.set(key, { count, at });
      if (count >= ORPHAN_CONFIRMATIONS) {
        const resolved = await closeUntrackedPosition(rt, position);
        if (resolved) {
          orphanObservations.delete(key);
          continue;
        }
      }
      issues.push({
        symbol: position.symbol,
        kind: "untracked",
        message: `BingX position ${position.symbol} ${position.positionSide} has no active bot trade`,
      });
    }
    const prefix = `${rt.acct.id}|`;
    for (const key of orphanObservations.keys()) {
      if (key.startsWith(prefix) && !current.has(key)) orphanObservations.delete(key);
    }
    return issues;
  }
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
        if (e instanceof BingXError && e.kind === "rate") {
          const until = Number(/unblocked after (\d{13})/.exec(e.message)?.[1]);
          const when = Number.isFinite(until) ? ` до ${new Date(until).toISOString().slice(11, 19)} UTC` : "";
          await say(`${head(rt, cur)}\nВход отправлен вместе со стопом. BingX временно ограничил частоту запросов${when}: проверка стопа, маржи и тейка отложена.\nБот закончит её сам, как только ограничение снимется (сверка каждые 20 с).`);
        } else {
          await say(`${head(rt, cur)}\nОрдер на вход отправлен, но настройка позиции прервалась: ${errText(e)}\nБот сверит позицию с биржей и закончит защиту в течение минуты.`);
        }
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
      if (Number(amount) > bal.available) {
        await event(rt.acct.id, t, "margin_add_impossible", { amount, available: bal.available, liquidation: p.liquidationPrice, stop: t.stop_price });
        await say(`${head(rt, t)}\nЛиквидация раньше стопа, а свободной маржи не хватает: нужно долить ${amount} USDT, свободно ${fmt(bal.available)}.\nПозиция закрывается по рынку.`);
        await closeMarket(rt, t, "no_margin_for_stop");
        return null;
      }
      try {
        await rt.ex.addMargin(t.symbol, posSide(t.side), amount, "protect");
      } catch (e) {
        // Owner 2026-11-09 (US): the position opened but BingX refused the top-up — the position is closed.
        // A rate limit or a lost answer is not a refusal: the next pass (20 s) tries again.
        if (!(e instanceof BingXError) || e.kind === "rate" || e.ambiguous) throw e;
        await event(rt.acct.id, t, "margin_add_failed", { amount, message: errText(e), liquidation: p.liquidationPrice, stop: t.stop_price });
        await say(`${head(rt, t)}\nBingX не принял доливку маржи ${amount} USDT (${errText(e)}): ликвидация осталась раньше стопа.\nПозиция закрывается по рынку.`);
        await closeMarket(rt, t, "no_margin_for_stop");
        return null;
      }
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
      `Сверка BingX подтверждена: позиции нет; запись убрана из «Открытых» (обновление в кабинете — до 15 секунд).`,
      `Вход ${fmt(cur.entry_price)} → выход ${fmt(last?.avgPrice ?? exit)}${closing.length > 1 ? ` (средний выход по всем частям ${fmt(exit)})` : ""}`,
      resultLine(cur.pnl_pct, result, asset) + (cur.partial_done || closing.length > 1 ? " — с учётом частичных закрытий" : ""),
      histError ? `Цену выхода BingX не отдал (${histError}) — результат не посчитан, сверьте на бирже.` : "",
    ].filter(Boolean).join("\n"));
  }

  async function recordSourcePositionReview(
    rt: Runtime,
    t: Trade,
    cmd: CommandIn,
  ): Promise<{ exchangeState: "open" | "not_found" | "unavailable"; position: Position | null }> {
    let position: Position | null = null;
    let exchangeState: "open" | "not_found" | "unavailable" = "unavailable";
    let observationError: string | null = null;
    try {
      position = await findPosition(rt, t, "normal");
      exchangeState = position ? "open" : "not_found";
    } catch (error) {
      observationError = errText(error).slice(0, 160);
    }
    await event(rt.acct.id, t, "source_position_review", {
      commandId: cmd.commandId,
      commandType: cmd.type,
      sourceReason: cmd.reason,
      sourceAction: cmd.sourceAction ?? null,
      trackerStatus: cmd.trackerStatus ?? null,
      ledgerStatus: t.status,
      exchangeState,
      exchangeQty: position?.qty ?? null,
      exchangeLookup: "symbol_side",
      closeRequested: cmd.type === "cancel_entry" ||
        (cmd.type === "position_review" &&
          (sourceActionKind(cmd.sourceAction ?? "") === "close" || sourceActionKind(cmd.trackerStatus ?? "") === "close")),
      observedAt: new Date(now()).toISOString(),
      ...(observationError ? { observationError } : {}),
    });
    return { exchangeState, position };
  }

  const isSourceCancellation = (cmd: CommandIn) =>
    cmd.type === "cancel_entry" || (cmd.type === "position_review" &&
      (sourceActionKind(cmd.sourceAction ?? "") === "close" || sourceActionKind(cmd.trackerStatus ?? "") === "close"));

  // ---------------- commands from the source ----------------
  async function applyCommand(rt: Runtime, t: Trade, cmd: CommandIn): Promise<void> {
    if (cmd.seq !== null && cmd.seq <= t.last_command_seq) return; // already applied (or older)
    const done = () => cmd.seq === null ? Promise.resolve(t) : updateTradeCommandSequence(t.id, cmd.seq);
    const cancellation = isSourceCancellation(cmd);
    const reviewOnly = cmd.type === "position_review" && !cancellation;
    if (t.status === "closed") {
      if (reviewOnly || cancellation) await recordSourcePositionReview(rt, t, cmd);
      await done();
      return;
    }
    if (["skipped", "failed"].includes(t.status) && !cancellation) {
      if (reviewOnly) await recordSourcePositionReview(rt, t, cmd);
      await done();
      return;
    }
    await event(rt.acct.id, t, "command", { ...cmd });
    if (reviewOnly) {
      await recordSourcePositionReview(rt, t, cmd);
      await done();
      return;
    }
    if (cancellation) {
      // Owner 2026-11-09: a cancellation is booked as a cancellation (cancel:<reason>), never as an ordinary close.
      const reason = cancelKey(cmd.type === "position_review" ? (cmd.trackerStatus || cmd.sourceAction || cmd.reason) : cmd.reason);
      const originalStatus = t.status;
      const alreadyQueued = t.status === "closing" && sourcePending(t.pending_close_reason);
      const retryAsClosing = ["open", "closing", "skipped", "failed"].includes(t.status);
      const pending = alreadyQueued ? t : await updateTrade(t.id, {
        ...(retryAsClosing ? { status: "closing" as const } : {}),
        pending_close_reason: reason,
      });
      const observation = await recordSourcePositionReview(rt, t, cmd);
      if (observation.exchangeState === "open" && observation.position) {
        const current = await tradeById(t.id) ?? pending;
        const retryDue = !alreadyQueued || now() - t.updated_at.getTime() >= 60_000;
        if (retryDue) {
          const needsAdoption = current.status !== "closing" || !current.entry_price || !current.initial_qty;
          const closeTrade = needsAdoption ? await updateTrade(t.id, {
            status: "closing",
            pending_close_reason: reason,
            qty: observation.position.qty,
            initial_qty: current.initial_qty ?? observation.position.qty,
            entry_price: current.entry_price ?? observation.position.avgPrice,
            opened_at: current.opened_at ?? current.entry_sent_at ?? new Date(now()),
            liquidation_price: observation.position.liquidationPrice,
            margin: observation.position.margin,
          }) : current;
          await closeMarket(rt, closeTrade, reason);
        }
      } else if (observation.exchangeState === "not_found") {
        const current = await tradeById(t.id);
        if (current && ["open", "closing"].includes(originalStatus)) {
          await finalize(rt, current);
        } else if (current && ["skipped", "failed"].includes(originalStatus)) {
          await updateTrade(t.id, { status: originalStatus, pending_close_reason: null });
        } else if (current && ["opening", "unknown"].includes(originalStatus)) {
          const order = current.client_order_id
            ? await rt.ex.queryOrder(current.symbol, { clientOrderId: current.client_order_id }, "entry")
            : null;
          if (order && ["NEW", "PARTIALLY_FILLED"].includes(order.status) && order.orderId) {
            await rt.ex.cancelOrder(current.symbol, order.orderId, "entry");
          }
          if (order && order.executedQty > 0) {
            await updateTrade(t.id, {
              status: "closing",
              qty: order.executedQty,
              initial_qty: current.initial_qty ?? order.executedQty,
              entry_price: current.entry_price ?? (order.avgPrice > 0 ? order.avgPrice : null),
              opened_at: current.opened_at ?? current.entry_sent_at ?? new Date(order.time || now()),
            });
          } else if (!order || ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) {
            await updateTrade(t.id, { status: "skipped", reason: "source_cancelled", pending_close_reason: null });
            await event(rt.acct.id, current, "skipped", { reason: "source_cancelled", sourceCancellation: true });
          }
        }
      }
      // unavailable remains pending; reconciliation retries against BingX.
      // Command-sequence writes do not touch updated_at, which paces close retries.
      await done();
      return;
    }
    // The bot manages this Nihilist trade itself: Nihilist's stop moves and closes are not followed,
    // except a close at the end of the holding time (the same limit as the bot's own).
    if (ownMgmt(t) && (cmd.type === "move_stop" || (cmd.type === "close" && cmd.reason !== "expired"))) { await done(); return; }
    if (cmd.type === "move_stop" && cmd.stopPrice !== null) {
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
  /** A close the source asked for (its close or its cancellation) waits on this trade. */
  const sourcePending = (r: string | null | undefined) => Boolean(r && (r.startsWith("source") || isCancelReason(r)));
  const missingAtSource = new Map<string, number>();
  const isBtc = (symbol: string) => /^BTC-?USDT$/.test(symbol);

  /**
   * Commands stored in the inbox with a sequence after the last applied one, in order. Of several stop moves
   * only the last is applied (an older level could only move the stop back). Commands without a sequence
   * cannot be told apart from applied ones and are not replayed. Returns true when something was applied.
   */
  async function replayMissedCommands(rt: Runtime, t: Trade): Promise<boolean> {
    const rows = await commandsForSignal(t.source_signal_id);
    const missed: CommandIn[] = [];
    for (const r of rows) {
      const p = parseCommand(r.body, r.received_at.getTime());
      if (p.ok && p.value.seq !== null && p.value.seq > t.last_command_seq) missed.push(p.value);
    }
    if (!missed.length) return false;
    missed.sort((a, b) => a.seq! - b.seq!);
    const lastMove = Math.max(...missed.filter((c) => c.type === "move_stop").map((c) => c.seq!), -1);
    const terminal = missed.find((c) => isSourceCancellation(c) || (c.type === "close" && (c.fraction ?? 1) >= 0.999));
    const todo = terminal ? [terminal] : missed.filter((c) => c.type !== "move_stop" || c.seq === lastMove);
    const f = await factorOf(t);
    for (const c of todo) {
      const cur = await tradeById(t.id);
      if (!cur || !["open", "closing", "unknown", "opening"].includes(cur.status)) break;
      await event(rt.acct.id, cur, "command_replayed", { commandId: c.commandId, type: c.type, seq: c.seq });
      await applyCommand(rt, cur, f !== 1 && c.stopPrice !== null ? { ...c, stopPrice: c.stopPrice * f } : c);
    }
    // applyCommand records each applied sequence; an error is thrown and the next pass tries again.
    return true;
  }

  // ---------------- reconciliation ----------------
  async function reconcile(rt: Runtime): Promise<ReconcileIssue[] | null> {
    const trades = await activeTrades(rt.acct.id);
    if (!trades.length) {
      const auditedAt = now();
      if (auditedAt - (lastIdlePositionAudit.get(rt.acct.id) ?? 0) < IDLE_POSITION_AUDIT_MS) return null;
      lastIdlePositionAudit.set(rt.acct.id, auditedAt);
    }
    const all = await rt.ex.positions(undefined, "normal");
    const currentTrades = await activeTrades(rt.acct.id);
    const cleanupIssues = await cleanupPendingOrphanOrders(rt, all);
    const untrackedIssues = await reportUntrackedPositions(rt, currentTrades, all);
    if (!trades.length) return [...cleanupIssues, ...untrackedIssues];
    // One request for the open orders of every symbol in this pass (BingX limits openOrders: 100410).
    await rt.ex.prefetchOpenOrders(trades.map((t) => t.symbol)).catch(() => undefined);
    const issues: ReconcileIssue[] = [...cleanupIssues, ...untrackedIssues];
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
          if (after?.status === "open" && sourcePending(after.pending_close_reason)) await closeMarket(rt, after, after.pending_close_reason!);
          return;
        }
        if (age > 120_000 || cur.status === "opening") {
          const sourceClosePending = sourcePending(cur.pending_close_reason);
          const order = cur.client_order_id
            ? sourceClosePending
              ? await rt.ex.queryOrder(cur.symbol, { clientOrderId: cur.client_order_id })
              : await rt.ex.queryOrder(cur.symbol, { clientOrderId: cur.client_order_id }).catch(() => null)
            : null;
          if (sourceClosePending && order && ["NEW", "PARTIALLY_FILLED"].includes(order.status) && order.orderId) {
            await rt.ex.cancelOrder(cur.symbol, order.orderId);
          }
          if (order && order.executedQty > 0) {
            const closing = await updateTrade(cur.id, {
              status: "closing",
              entry_price: cur.entry_price ?? (order.avgPrice > 0 ? order.avgPrice : null),
              qty: order.executedQty,
              initial_qty: cur.initial_qty ?? order.executedQty,
              opened_at: cur.opened_at ?? new Date(order.time || now()),
            });
            if (sourceClosePending) {
              const latePosition = await findPosition(rt, closing, "normal");
              if (latePosition) await closeMarket(rt, closing, cur.pending_close_reason!);
              else await finalize(rt, closing);
            } else {
              await finalize(rt, closing);
            }
            return;
          }
          if (sourceClosePending) {
            if (!cur.client_order_id || !order || ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) {
              await updateTrade(cur.id, { status: "skipped", reason: "source_cancelled", pending_close_reason: null });
              await event(rt.acct.id, cur, "skipped", { reason: "source_cancelled", sourceCancellation: true });
            }
            return;
          }
          await fail(rt, cur, "entry_not_found");
        }
        return;
      }
      if (!pos) { await finalize(rt, cur); return; }
      // Owner 2026-11-09: a command that came but was not applied (BingX error, restart, it came before the
      // entry) is applied from the inbox — a cancellation or close is never lost.
      if (cur.status === "open" && await replayMissedCommands(rt, cur)) return;
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
      const message = errText(e);
      issues.push({ source: t.source, symbol: t.symbol, message });
      log("executor: reconcile trade failed", e);
      // Kept for the owner (a repeated error is stored once a minute at most).
      const last = await pool.query("SELECT 1 FROM ex_events WHERE trade_id = $1 AND kind = 'reconcile_error' AND created_at > now() - interval '1 minute'", [t.id]).catch(() => ({ rowCount: 1 }));
      if (!last.rowCount) await event(rt.acct.id, t, "reconcile_error", { message }).catch(() => undefined);
    })));
    return issues;
  }

  // ---------------- public ----------------
  async function onSignal(sig: SignalIn): Promise<void> {
    const rts = await refreshAccounts().catch(() => [...runtimes.values()]);
    await Promise.allSettled(rts.map((rt) => withLock(rt, sig.symbol, () => enter(rt, sig))));
  }

  async function onCommand(cmd: CommandIn): Promise<void> {
    const trades = await tradesForSignal(cmd.sourceSignalId);
    // Fresh accounts every time: an account whose subscription just ended is not led a second longer (owner 2026-11-09).
    await refreshAccounts().catch(() => undefined);
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
  async function onSourceState(states: Array<{ sourceSignalId: string; action: string; stop: number | null; status?: string | null; cancelReason?: string | null }>): Promise<void> {
    const map = new Map(states.map((s) => [s.sourceSignalId, s]));
    // A CAB signal whose row is gone at the source (deleted) is a cancellation once two syncs in a row agree.
    for (const s of states) {
      if (s.action === "unknown" && s.status == null) missingAtSource.set(s.sourceSignalId, (missingAtSource.get(s.sourceSignalId) ?? 0) + 1);
      else missingAtSource.delete(s.sourceSignalId);
    }
    for (const rt of runtimes.values()) {
      const trades = await activeTrades(rt.acct.id);
      for (const t of trades) {
        const s = map.get(t.source_signal_id);
        if (!s) continue;
        const actionKind = sourceActionKind(s.action, s.status);
        if (actionKind === "review" || (ownMgmt(t) && actionKind !== "close")) continue;
        await withLock(rt, t.symbol, async () => {
          const cur = await tradeById(t.id);
          if (!cur || !["opening", "open", "closing", "unknown"].includes(cur.status)) return;
          // Owner 2026-11-09: a signal the source cancelled / reclassified, or that is gone at the source two syncs
          // in a row, is closed as a cancellation found by the sync — not as an ordinary close.
          const st = (s.status ?? "").toLowerCase();
          const gone = actionKind === "unknown" && s.status == null && (missingAtSource.get(s.sourceSignalId) ?? 0) >= 2;
          const cancelled = st === "cancelled" || st === "canceled" || st === "reclassified" || gone;
          if (actionKind === "close" || gone) {
            const key = cancelled ? cancelKey(gone ? "removed" : st, true) : "source_sync";
            if (cur.status === "opening" || cur.status === "unknown") {
              await updateTrade(cur.id, { pending_close_reason: cancelled ? key : "source:source_sync" });
            } else if (cur.status === "open") {
              await closeMarket(rt, cur, key);
            }
            return;
          }
          if (cur.status !== "open") return;
          const stop = s.stop === null ? null : s.stop * (await factorOf(cur));
          if (stop !== null && cur.stop_price !== null &&
            (cur.side === "long" ? stop > cur.stop_price * 1.0005 : stop < cur.stop_price * 0.9995)) {
            await replaceStop(rt, cur, stop, "source_sync");
          }
        }).catch((e) => log("executor: source sync failed", e));
      }
    }
  }

  async function sourceSyncIssues(rt: Runtime): Promise<ReconcileIssue[]> {
    if (!deps.sourceSyncStatus) return [];
    const activeStatuses = ["opening", "open", "closing", "unknown"];
    const activeSources = rt.acct.id.startsWith("owner-")
      ? await pool.query<{ source: string }>(
        `SELECT DISTINCT source FROM ex_trades
         WHERE account_id LIKE 'owner-%' AND status = ANY($1::text[]) ORDER BY source`,
        [activeStatuses],
      )
      : await pool.query<{ source: string }>(
        `SELECT DISTINCT source FROM ex_trades
         WHERE account_id = $1 AND status = ANY($2::text[]) ORDER BY source`,
        [rt.acct.id, activeStatuses],
      );
    const sources = activeSources.rows.map((row) => row.source);
    const issues: ReconcileIssue[] = [];
    for (const source of sources) {
      const status = deps.sourceSyncStatus(source);
      if (!sourceSyncConfirmed(status, now())) {
        issues.push({
          source,
          message: status?.error
            ? `Source state not confirmed (${source}): ${status.error}`
            : `Source state not confirmed (${source})`,
        });
      }
    }
    return issues;
  }

  /** Owner 2026-11-06: each account's result is returned, so Bot Health shows an account whose pass fails. */
  async function reconcileAll(): Promise<Array<{ id: string; label: string; ok: boolean; error: string | null }>> {
    const rts = await refreshAccounts().catch(() => [...runtimes.values()]);
    return Promise.all(rts.map(async (rt) => {
      try {
        const issues = await reconcile(rt);
        if (issues === null) return { id: rt.acct.id, label: rt.acct.label, ok: true, error: null };
        const sourceIssues = await sourceSyncIssues(rt);
        const unsettledTrades = (await activeTrades(rt.acct.id))
          .filter((trade) => trade.status !== "open")
          .map((trade) => ({
            source: trade.source,
            symbol: trade.symbol,
            message: `Trade settlement not confirmed: ${trade.symbol} (${trade.status})`,
          }));
        const allIssues = [...issues, ...sourceIssues, ...unsettledTrades];
        if (allIssues.length) {
          await reportReconcileIssues(rt, allIssues);
          return { id: rt.acct.id, label: rt.acct.label, ok: false, error: allIssues[0]!.message };
        }
        await reportReconcileIssues(rt, []);
        return { id: rt.acct.id, label: rt.acct.label, ok: true, error: null };
      } catch (e) {
        const message = errText(e);
        resetOrphanObservations(rt.acct.id);
        await reportReconcileIssues(rt, [{ message }]);
        log(`executor: reconcile ${rt.acct.id} failed`, e);
        return { id: rt.acct.id, label: rt.acct.label, ok: false, error: message };
      }
    }));
  }

  return { onSignal, onCommand, onSourceState, reconcileAll, refreshAccounts, runtimes };
}

export type Executor = ReturnType<typeof createExecutor>;
