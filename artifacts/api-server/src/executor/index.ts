/**
 * Executor start (owner 2026-11-02 rewrite). On with EXECUTOR_V2=1; the old
 * VST/PAPER workers are then not started. Reconciles every 20 s, polls the
 * position sync of each source (CAB and Nihilist) every 60 s while it has an
 * open trade there, reloads accounts every minute.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "@workspace/db";
import { createBingX } from "./bingx";
import { loadAccounts } from "./accounts";
import { createPaperFetch } from "./paper";
import { accountEntryAllowed } from "./trading-controls";

/** One simulated exchange for the PAPER account (its state lives in ex_paper_state). */
let paperFetch: ReturnType<typeof createPaperFetch> | null = null;
import { REASON_TEXT, createExecutor, type Executor } from "./engine";
import { closeReasonText, isCancelReason } from "./texts";
import { createIntakeHandler } from "./intake";
import { BTC_MAX_LEVERAGE, ensureExecutorTables, getBtcSettings, getSourceSettings, saveSourceSettings, type SourceSettings } from "./store";
import { nihilistStrategies, nihilistStrategy } from "./plan";
import { pumpTelegram, telegramOutboxStatus, telegramSender } from "./telegram";

export const executorEnabled = () => process.env.EXECUTOR_V2 === "1";
const CAB_SYNC_URL = "https://crypto-alt-bullet.replit.app/api/trading/position-sync";

let executor: Executor | null = null;
let syncState: Record<string, { at: number | null; ok: boolean | null; error: string | null }> = {};
// Bot Health (owner 2026-11-03): when the executor started and how the last reconcile pass went.
let startedAt: number | null = null;
const lastReconcile: { at: number | null; ms: number | null; ok: boolean | null; error: string | null; accounts: Array<{ id: string; label: string; ok: boolean; error: string | null }> } = { at: null, ms: null, ok: null, error: null, accounts: [] };
let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

export function executorRequestHandler(req: IncomingMessage, res: ServerResponse): void {
  if (!handler) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":{"code":"executor_not_started"}}'); return; }
  void handler(req, res);
}

export type SourceState = { sourceSignalId: string; action: string; stop: number | null; status?: string | null; cancelReason?: string | null };
type SyncSource = "cab" | "nihilist";

/** Where each source's position sync lives and its token. Nihilist's address: NIHILIST_POSITION_SYNC_URL. */
/** CAB's address (from its position sync URL), for its strategy report. */
export function cabOrigin(): string {
  const url = process.env.CAB_POSITION_SYNC_URL?.trim() || CAB_SYNC_URL;
  try { return new URL(url).origin; } catch { return new URL(CAB_SYNC_URL).origin; }
}

function syncTarget(source: SyncSource): { url: string; token: string } | null {
  const token = (source === "cab" ? process.env.TRADING_INGEST_TOKEN : process.env.NIHILIST_TRADING_TOKEN)?.trim();
  const url = source === "cab" ? process.env.CAB_POSITION_SYNC_URL?.trim() || CAB_SYNC_URL : process.env.NIHILIST_POSITION_SYNC_URL?.trim();
  return token && url ? { url, token } : null;
}

/**
 * A source's position sync → what it holds / closed and its current stop.
 * CAB (longs only) may carry a separate trailing level: the higher stop wins.
 * Nihilist (long and short) sends its one current stop. Pages start after
 * `afterId` (the oldest open trade's id − 1), so old closed signals are not re-read.
 * Throws when the source does not answer: then nothing is closed by the sync.
 */
export async function readSourceSync(source: SyncSource, afterId = 0, fetchImpl: typeof fetch = fetch): Promise<SourceState[]> {
  const target = syncTarget(source);
  if (!target) return [];
  const out: SourceState[] = [];
  let after: number | null = afterId;
  for (let page = 0; page < 50 && after !== null; page++) {
    const url = new URL(target.url);
    if (after) url.searchParams.set("afterId", String(after));
    const res = await fetchImpl(url, { headers: { "x-trading-token": target.token, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${source} position sync: HTTP ${res.status}`);
    const body = await res.json() as { positions?: any[]; nextAfterId?: number | null };
    for (const p of body.positions ?? []) {
      let stop: number | null;
      if (source === "cab") {
        const stops = [Number(p.sourceStopLossPrice), Number(p.sourceTrailingStopLevel)].filter((v) => Number.isFinite(v) && v > 0);
        stop = stops.length ? Math.max(...stops) : null;
      } else {
        const v = Number(p.sourceStopLossPrice);
        stop = Number.isFinite(v) && v > 0 ? v : null;
      }
      // The source's own status (CAB: cancelled / reclassified come as action "review").
      const status = typeof p.sourceStatus === "string" ? p.sourceStatus : null;
      out.push({ sourceSignalId: String(p.sourceSignalId), action: String(p.sourceAction), stop, status,
        cancelReason: typeof p.sourceCancelReason === "string" ? p.sourceCancelReason : null });
    }
    after = body.nextAfterId ?? null;
  }
  return out;
}

const SIGNAL_NUM = /-(\d+)$/;
async function syncSource(ex: Executor, source: SyncSource): Promise<number> {
  // Only while there is an open trade of this source; start just before the oldest one.
  const r = await pool.query<{ source_signal_id: string }>(
    "SELECT source_signal_id FROM ex_trades WHERE source = $1 AND status IN ('open', 'closing') ORDER BY id", [source]);
  if (!r.rowCount) return 0;
  const nums = r.rows.map((x) => Number(SIGNAL_NUM.exec(x.source_signal_id)?.[1])).filter((n) => Number.isSafeInteger(n) && n > 0);
  const after = nums.length ? Math.max(0, Math.min(...nums) - 1) : 0;
  const states = await readSourceSync(source, after);
  await ex.onSourceState(states);
  return states.length;
}

export async function startExecutor(log: (msg: string, extra?: unknown) => void): Promise<void> {
  if (executor) return;
  await ensureExecutorTables();
  executor = createExecutor({
    loadAccounts,
    entryAllowed: accountEntryAllowed,
    bingx: (a) => (a.paper
      ? createBingX({ env: "vst", key: a.key, secret: a.secret, host: "https://paper.local", fetchImpl: (paperFetch ??= createPaperFetch()) })
      : createBingX({ env: a.env, key: a.key, secret: a.secret })),
    send: telegramSender,
    log,
  });
  handler = createIntakeHandler(executor, { log });
  void pumpTelegram().catch((e) => log("executor: telegram outbox", e)); // what waited before a restart
  const accounts = await executor.refreshAccounts();
  log(`executor: started, accounts: ${accounts.map((r) => r.acct.id).join(", ") || "none"}`);
  startedAt = Date.now();
  const ex = executor;
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    const t0 = Date.now();
    try {
      const accounts = await ex.reconcileAll();
      Object.assign(lastReconcile, { at: Date.now(), ms: Date.now() - t0, ok: true, error: null, accounts });
    } catch (e) {
      Object.assign(lastReconcile, { at: Date.now(), ms: Date.now() - t0, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      log("executor: reconcile pass failed", e);
    } finally { reconciling = false; }
  };
  void reconcile();
  setInterval(() => void reconcile(), 20_000).unref?.();
  const lastSync: Record<SyncSource, { at: number | null; ok: boolean | null; error: string | null }> = {
    cab: { at: null, ok: null, error: null }, nihilist: { at: null, ok: null, error: null },
  };
  syncState = lastSync;
  setInterval(() => {
    for (const source of ["cab", "nihilist"] as const) {
      void syncSource(ex, source)
        .then(() => { lastSync[source] = { at: Date.now(), ok: true, error: null }; })
        .catch((e) => {
          lastSync[source] = { at: Date.now(), ok: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
          log(`executor: ${source} sync failed`, e);
        });
    }
  }, 60_000).unref?.();
}

const SOURCE_NAME: Record<string, string> = { cab: "CAB", nihilist: "Нигилист" };
/** Owner 2026-11-09: closes caused by a source's cancellation (see texts.ts isCancelReason) — not a win or a loss. */
const CANCEL_SQL = `coalesce(close_reason LIKE 'cancel:%' OR close_reason LIKE 'cancel\\_sync:%'
  OR (close_reason LIKE 'source:%' AND substr(close_reason, 8) NOT IN ('stop_loss','expired','breakeven_stop','breakeven_close','trailing_stop','profit','core_exit','close','')), false)`;
const STATUS_TEXT: Record<string, string> = {
  opening: "открывается", open: "открыта", closing: "закрывается", closed: "закрыта",
  skipped: "не открыта", failed: "не открыта (ошибка)", unknown: "сверяется с биржей",
};
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

function tradeView(t: any) {
  const reasonKey = t.status === "closed" ? t.close_reason : t.reason;
  const reasonText = reasonKey ? (t.status === "closed" ? closeReasonText(reasonKey, t.source) : REASON_TEXT[reasonKey] ?? reasonKey) : null;
  const sentAt = t.entry_sent_at ? new Date(t.entry_sent_at).getTime() : null;
  return {
    id: t.id, accountId: t.account_id, source: t.source, sourceName: SOURCE_NAME[t.source] ?? t.source, sourceSignalId: t.source_signal_id,
    symbol: t.symbol, side: t.side, pattern: t.pattern, env: t.env, status: t.status, statusText: STATUS_TEXT[t.status] ?? t.status,
    reason: reasonKey ?? null, reasonText, takePct: n(t.take_pct), cancelled: t.status === "closed" && isCancelReason(t.close_reason),
    leverage: n(t.leverage) ?? 10, mgmt: t.mgmt ?? null, mgmtLabel: t.mgmt ? nihilistStrategy(t.mgmt).label : null, peakPct: n(t.peak_pct),
    signalAt: iso(t.signal_at), receivedAt: iso(t.received_at), entrySentAt: iso(t.entry_sent_at), openedAt: iso(t.opened_at), closedAt: iso(t.closed_at),
    entryDelaySec: sentAt ? Math.round((sentAt - new Date(t.received_at).getTime()) / 100) / 10 : null,
    qty: n(t.qty), entryPrice: n(t.entry_price), stopPrice: n(t.stop_price), takePrice: n(t.take_price),
    liquidationPrice: n(t.liquidation_price), margin: n(t.margin), marginAdded: n(t.margin_added) ?? 0,
    exitPrice: n(t.exit_price), pnl: n(t.pnl), pnlPct: n(t.pnl_pct),
    price: null as number | null, unrealized: null as number | null, unrealizedPct: null as number | null,
  };
}

// Live prices and balances for the page: at most one exchange round per 10 s.
let liveCache: { at: number; prices: Map<string, number>; balances: Map<string, { equity: number; available: number } | null> } | null = null;
async function live(openRows: any[]): Promise<NonNullable<typeof liveCache>> {
  if (liveCache && Date.now() - liveCache.at < 10_000) return liveCache;
  const prices = new Map<string, number>();
  const balances = new Map<string, { equity: number; available: number } | null>();
  if (executor) {
    const rts = [...executor.runtimes.values()];
    const symbols = [...new Set(openRows.map((t) => `${t.account_id}|${t.symbol}`))];
    await Promise.allSettled([
      ...rts.map(async (rt) => { balances.set(rt.acct.id, await rt.ex.balance("normal").catch(() => null)); }),
      ...symbols.map(async (k) => {
        const [acct, symbol] = k.split("|") as [string, string];
        const rt = executor!.runtimes.get(acct) ?? rts[0];
        if (!rt || prices.has(symbol)) return;
        const q = await rt.ex.ticker(symbol, "normal").catch(() => null);
        if (q && q.last > 0) prices.set(symbol, q.last);
      }),
    ]);
  }
  liveCache = { at: Date.now(), prices, balances };
  return liveCache;
}

/**
 * Owner view for the journal: accounts with balance, open trades with the live
 * price and floating result, closed trades, signals that were not opened (with
 * the reason), totals by source and side (longs and shorts apart), sync state.
 */
export async function executorStatus(): Promise<unknown> {
  await ensureExecutorTables();
  const [openQ, closedQ, skippedQ, totalsQ, skipTotalsQ] = await Promise.all([
    pool.query("SELECT * FROM ex_trades WHERE status IN ('opening','open','closing','unknown') ORDER BY id DESC"),
    pool.query("SELECT * FROM ex_trades WHERE status = 'closed' ORDER BY closed_at DESC NULLS LAST, id DESC LIMIT 500"),
    pool.query("SELECT * FROM ex_trades WHERE status IN ('skipped','failed') ORDER BY id DESC LIMIT 300"),
    pool.query(`SELECT account_id, source, side, count(*)::int AS closed,
                       count(*) FILTER (WHERE pnl > 0 AND NOT ${CANCEL_SQL})::int AS wins, count(*) FILTER (WHERE pnl < 0 AND NOT ${CANCEL_SQL})::int AS losses,
                       count(*) FILTER (WHERE ${CANCEL_SQL})::int AS cancelled,
                       coalesce(sum(pnl) FILTER (WHERE ${CANCEL_SQL}), 0)::float8 AS cancelled_pnl,
                       count(*) FILTER (WHERE close_reason = 'liquidation')::int AS liquidations,
                       coalesce(sum(pnl), 0)::float8 AS pnl
                FROM ex_trades WHERE status = 'closed' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    pool.query(`SELECT source, reason, count(*)::int AS n FROM ex_trades WHERE status IN ('skipped','failed') GROUP BY 1, 2 ORDER BY 3 DESC`),
  ]);
  const lv = await live(openQ.rows);
  const open = openQ.rows.map((t) => {
    const v = tradeView(t);
    const price = lv.prices.get(t.symbol) ?? null;
    if (price !== null && v.entryPrice && v.qty) {
      v.price = price;
      v.unrealized = (price - v.entryPrice) * v.qty * (v.side === "long" ? 1 : -1);
      v.unrealizedPct = ((price - v.entryPrice) / v.entryPrice) * 100 * (v.side === "long" ? 1 : -1);
    }
    return v;
  });
  return {
    enabled: executorEnabled(),
    asOf: new Date().toISOString(),
    // Whether signals actually arrive (owner 2026-11-03: sending is switched in CAB / Nihilist themselves).
    inbox: await inboxBySource(),
    telegram: await telegramOutboxStatus().catch(() => null),
    cab: { settings: await getSourceSettings("cab") },
    nihilist: { settings: await getSourceSettings("nihilist"), strategies: nihilistStrategies().map(({ id, label }) => ({ id, label })) },
    btc: { settings: await getBtcSettings("owner"), maxLeverage: BTC_MAX_LEVERAGE },
    accounts: executor ? [...executor.runtimes.values()].map((r) => ({
      id: r.acct.id, label: r.acct.label, env: r.acct.env, strategy: r.acct.strategy.name, takePct: r.acct.strategy.takePct,
      paper: Boolean(r.acct.paper), sources: [...r.acct.sources],
      balance: lv.balances.get(r.acct.id) ?? null,
    })) : [],
    sync: Object.fromEntries(Object.entries(syncState).map(([k, v]) => [k, { at: v.at ? new Date(v.at).toISOString() : null, ok: v.ok, error: v.error }])),
    open,
    closed: closedQ.rows.map(tradeView),
    skipped: skippedQ.rows.map(tradeView),
    totals: totalsQ.rows.map((r) => ({ accountId: r.account_id, source: r.source, sourceName: SOURCE_NAME[r.source] ?? r.source, side: r.side,
      closed: r.closed, wins: r.wins, losses: r.losses, liquidations: r.liquidations, pnl: Number(r.pnl),
      cancelled: r.cancelled, cancelledPnl: Number(r.cancelled_pnl) })),
    skippedTotals: skipTotalsQ.rows.map((r) => ({ source: r.source, sourceName: SOURCE_NAME[r.source] ?? r.source, reason: r.reason,
      reasonText: REASON_TEXT[r.reason] ?? r.reason, n: r.n })),
  };
}

/** One trade's events in order (what was sent to the exchange, fills, stop moves, top-ups, close). */
export async function executorTradeEvents(id: number): Promise<unknown> {
  await ensureExecutorTables();
  const [t, ev] = await Promise.all([
    pool.query("SELECT * FROM ex_trades WHERE id = $1", [id]),
    pool.query("SELECT id, kind, detail, created_at FROM ex_events WHERE trade_id = $1 ORDER BY id", [id]),
  ]);
  if (!t.rowCount) return null;
  return { trade: tradeView(t.rows[0]), events: ev.rows.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, at: iso(e.created_at) })) };
}

/** Owner saves one source's trading settings (CAB or Nihilist); returns the error code when the input is wrong. */
export async function saveSourceSettingsFrom(source: "cab" | "nihilist", b: any): Promise<{ ok: true; settings: SourceSettings } | { ok: false; code: string }> {
  if (!b || typeof b !== "object") return { ok: false, code: "invalid_payload" };
  const cur = await getSourceSettings(source);
  const next: SourceSettings = { ...cur };
  if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") return { ok: false, code: "invalid_enabled" }; next.enabled = b.enabled; }
  if (b.subscribers !== undefined) { if (typeof b.subscribers !== "boolean") return { ok: false, code: "invalid_subscribers" }; next.subscribers = b.subscribers; }
  if (b.strategy !== undefined && source === "nihilist") {
    if (!nihilistStrategies().some((m) => m.id === b.strategy)) return { ok: false, code: "invalid_strategy" };
    next.strategy = b.strategy;
  }
  if (b.allocationMode !== undefined || b.allocationValue !== undefined) {
    const mode = b.allocationMode ?? cur.allocationMode;
    const value = Number(b.allocationValue ?? cur.allocationValue);
    if (mode !== "percent" && mode !== "amount") return { ok: false, code: "invalid_allocation_mode" };
    if (!Number.isFinite(value) || value <= 0 || (mode === "percent" && value > 100)) return { ok: false, code: "invalid_allocation_value" };
    next.allocationMode = mode; next.allocationValue = value;
  }
  return { ok: true, settings: await saveSourceSettings(next) };
}

export const saveNihilistSettings = (b: any) => saveSourceSettingsFrom("nihilist", b);

/** Last signal received from each source and how many in 24 hours (ex_inbox). */
async function inboxBySource(): Promise<Record<"cab" | "nihilist", { lastAt: string | null; last24h: number }>> {
  const out = { cab: { lastAt: null as string | null, last24h: 0 }, nihilist: { lastAt: null as string | null, last24h: 0 } };
  const r = await pool.query(
    `SELECT CASE WHEN source_signal_id LIKE 'nh-%' THEN 'nihilist' ELSE 'cab' END AS src,
            max(received_at) AS last_at, count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS n
     FROM ex_inbox WHERE kind = 'signal' GROUP BY 1`);
  for (const row of r.rows as any[]) out[row.src as "cab" | "nihilist"] = { lastAt: row.last_at ? new Date(row.last_at).toISOString() : null, last24h: row.n };
  return out;
}

const ERROR_TEXT: Record<string, string> = {
  entry_error: "настройка позиции прервалась после входа",
  reconcile_error: "ошибка сверки с биржей",
  take_error: "биржа не приняла тейк",
  command_failed: "команда источника не выполнена",
};

/**
 * Bot Health (owner 2026-11-03): is the trading bot alive and doing its job — the last reconcile
 * pass, signals and position sync of each source, BingX (balance, rate-limit hits), trades stuck
 * on the way or never announced, errors of the last 24 h, Telegram. Problems first, red before yellow.
 */
export async function executorHealth(): Promise<unknown> {
  await ensureExecutorTables();
  const now = Date.now();
  const problems: Array<{ level: "red" | "yellow"; text: string }> = [];
  const enabled = executorEnabled();
  if (!enabled) problems.push({ level: "red", text: "Торговый бот выключен: в Secrets нет EXECUTOR_V2=1" });
  else if (!executor) problems.push({ level: "red", text: "Торговый бот не запустился — смотрите логи сервера" });

  // Reconcile: every 20 s; over 2 minutes without a pass is a stop.
  if (enabled && executor) {
    if (lastReconcile.at === null || now - lastReconcile.at > 120_000) problems.push({ level: "red", text: "Сверка с биржей не проходила больше 2 минут" });
    else if (lastReconcile.ok === false) problems.push({ level: "red", text: `Последняя сверка с ошибкой: ${lastReconcile.error}` });
  }

  const [stuckQ, unannQ, errQ, failQ, openN] = await Promise.all([
    pool.query(`SELECT id, account_id, source, symbol, side, status, received_at, updated_at FROM ex_trades
                WHERE (status IN ('opening','unknown') AND received_at < now() - interval '2 minutes')
                   OR (status = 'closing' AND updated_at < now() - interval '3 minutes') ORDER BY id`),
    pool.query(`SELECT t.id, t.account_id, t.source, t.symbol, t.side, t.opened_at FROM ex_trades t
                WHERE t.status = 'open' AND t.opened_at < now() - interval '2 minutes'
                  AND NOT EXISTS (SELECT 1 FROM ex_events e WHERE e.trade_id = t.id AND e.kind = 'opened') ORDER BY t.id`),
    pool.query(`SELECT kind, count(*)::int AS n, max(created_at) AS last_at,
                       (array_agg(symbol ORDER BY id DESC))[1] AS last_symbol, (array_agg(detail->>'message' ORDER BY id DESC))[1] AS last_message
                FROM ex_events WHERE created_at > now() - interval '24 hours' AND kind = ANY($1::text[]) GROUP BY kind ORDER BY 2 DESC`,
      [Object.keys(ERROR_TEXT)]),
    pool.query(`SELECT reason, count(*)::int AS n FROM ex_trades WHERE status = 'failed' AND received_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`),
    pool.query(`SELECT source, count(*)::int AS n FROM ex_trades WHERE status IN ('opening','open','closing','unknown') GROUP BY 1`),
  ]);
  const view = (r: any) => ({ id: r.id, accountId: r.account_id, source: SOURCE_NAME[r.source] ?? r.source, symbol: r.symbol, side: r.side, status: STATUS_TEXT[r.status] ?? r.status ?? "открыта", since: iso(r.received_at ?? r.opened_at) });
  if (stuckQ.rowCount) problems.push({ level: "red", text: `Сделки застряли при открытии или закрытии: ${stuckQ.rowCount}` });
  if (unannQ.rowCount) problems.push({ level: "yellow", text: `Открытые сделки без сообщения «Открыт…»: ${unannQ.rowCount} — сверка доведёт их` });

  // Owner 2026-11-06: an account whose reconcile pass fails (closes by hand, stops, takes are then not seen).
  if (enabled && executor) for (const a of lastReconcile.accounts) {
    if (!a.ok) problems.push({ level: "red", text: `${a.label}: сверка с биржей не проходит — ${a.error}. Закрытия (в том числе руками) не видны боту.` });
  }

  // Sources: signals (last 24 h) and the position sync (only matters while a trade of the source is open).
  const inbox = await inboxBySource();
  const openBySource = new Map(openN.rows.map((r) => [r.source as string, r.n as number]));
  const sources = (["cab", "nihilist"] as const).map((s) => {
    const sync = syncState[s] ?? { at: null, ok: null, error: null };
    const open = openBySource.get(s) ?? 0;
    if (open && sync.ok === false) problems.push({ level: "yellow", text: `Синхронизация позиций ${SOURCE_NAME[s]}: ${sync.error}` });
    return { source: s, name: SOURCE_NAME[s], inbox: inbox[s], open, sync };
  });

  // BingX per account.
  const accounts = executor ? await Promise.all([...executor.runtimes.values()].map(async (rt) => {
    const bal = await rt.ex.balance("normal").then((b) => ({ ok: true as const, ...b })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message.slice(0, 160) : String(e) }));
    if (!bal.ok) problems.push({ level: "red", text: `${rt.acct.label}: баланс BingX не читается — ${bal.error}` });
    const st = rt.ex.stats();
    const hits = st.rate.reduce((a, r) => a + r.lastHour, 0);
    if (hits) problems.push({ level: "yellow", text: `${rt.acct.label}: лимит запросов BingX за час — ${hits} раз (бот ждёт и повторяет)` });
    return { id: rt.acct.id, label: rt.acct.label, env: rt.acct.env, hedge: rt.hedge ?? null, balance: bal, requests: st.requests, rate: st.rate, lastError: st.lastError };
  })) : [];

  const errors = errQ.rows.map((r) => ({ kind: r.kind, text: ERROR_TEXT[r.kind] ?? r.kind, n: r.n, lastAt: iso(r.last_at), lastSymbol: r.last_symbol, lastMessage: r.last_message }));
  const errN = errors.reduce((a, e) => a + e.n, 0);
  if (errN) problems.push({ level: "yellow", text: `Ошибок за сутки: ${errN}` });
  const failed = failQ.rows.map((r) => ({ reason: r.reason, text: REASON_TEXT[r.reason] ?? r.reason, n: r.n }));

  const telegram = await telegramOutboxStatus().catch(() => null);
  if (telegram) {
    const waitS = telegram.oldestPendingAt ? (now - new Date(telegram.oldestPendingAt).getTime()) / 1000 : 0;
    if (telegram.pending && waitS > 60) problems.push({ level: "yellow", text: `Telegram: ${telegram.pending} сообщ. ждут дольше минуты` });
    if (telegram.failed24h) problems.push({ level: "red", text: `Telegram не доставил за сутки: ${telegram.failed24h} — ${telegram.lastError ?? ""}` });
  }

  problems.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1));
  return {
    asOf: new Date(now).toISOString(), enabled, running: Boolean(executor), startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    reconcile: { ...lastReconcile, at: lastReconcile.at ? new Date(lastReconcile.at).toISOString() : null },
    status: problems.some((p) => p.level === "red") ? "red" : problems.length ? "yellow" : "green", problems,
    sources, accounts, stuck: stuckQ.rows.map(view), unannounced: unannQ.rows.map(view), errors, failed, telegram,
  };
}
