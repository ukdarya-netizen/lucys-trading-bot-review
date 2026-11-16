/**
 * Strategy results computed by the trading bot itself (owner 2026-11-16: «все стратегии пустые … они должны
 * находиться там на постоянной основе»; «почему пересчёт должен зависеть от других ботов?»).
 *
 * Every signal the bot received from CAB and Nihilist (ex_inbox) is led by every strategy the bot offers for
 * that source, on BingX 5-minute candles, with the commands the source sent to the bot (received times):
 *  - entry: close of the 5m candle in which the bot received the signal; the stop of the signal;
 *  - inside a candle the stop is checked first, then the take; a stop moved by the source or by the bot's own
 *    management (break-even, trailing) works from the next candle; a command acts at the close of its candle;
 *  - CAB: «как CAB» — CAB's stop moves, closes and cancellations; +5 / +8 / +10 % — the same plus a take;
 *  - Nihilist: «как Нигилист» — its stop moves, closes and cancellations; the bot's own ways (plan.ts manageStep:
 *    break-even, partial, trailing, take) with Nihilist's holding time; Nihilist's close at the end of the
 *    holding time, its cancellations and its stop moves that tighten the stop apply to every way (as engine.ts);
 *  - fee 0.1 % of the price per round trip.
 * Results are kept in ex_strategy_results: a closed signal is final and never recalculated; open ones are
 * recalculated every 15 minutes (production only — dev makes no BingX calls). Nothing depends on CAB or
 * Nihilist being reachable.
 */
import { pool } from "@workspace/db";
import { HOSTS, mapSymbol, exSymbol } from "./bingx";
import { parseCommand, type Source } from "./intake";
import { manageStep, movePct, nihilistStrategies, type Mgmt, type Side } from "./plan";
import { sourceActionKind } from "./source-state";

export const SIM_FEE_PCT = 0.1;
const BAR_MS = 5 * 60_000;
const PASS_MS = 15 * 60_000;
/** CAB's four traded patterns (as the CAB report); BTC is led by CAB under every strategy and is left out. */
export const CAB_PATTERNS = ["stealth_breakout", "neon_support_bounce", "impulse_buy", "liquidation_cascade"];
export const CAB_WAYS: Array<{ id: string; take: number | null }> = [
  { id: "follow_cab", take: null }, { id: "take5", take: 5 }, { id: "take8", take: 8 }, { id: "take10", take: 10 },
];

export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type SimSignal = { id: string; source: Source; symbol: string; side: Side; pattern: string | null; receivedAt: number; stop: number; maxHoldH: number | null };
export type SimCommand = { at: number; type: "close" | "move_stop" | "cancel_entry" | "position_review"; stopPrice: number | null; fraction: number | null; reason: string; cancel: boolean };
export type Way = { id: string; follow: boolean; take: number | null; mgmt: Mgmt | null };
export type Reason = "stop" | "breakeven" | "trailing" | "take" | "partial" | "timeout" | "source" | "cancel";
export type Result =
  | { status: "skipped"; why: "cancelled_before_entry" | "price_beyond_stop" | "no_candles" | "no_contract" }
  | { status: "open" | "closed"; openedAt: number; closedAt: number | null; entry: number; pnlPct: number; reason: Reason | null };

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** One signal, one way (pure). Candles are 5m, sorted, starting at or before the receipt. */
export function simulate(sig: SimSignal, cmds: SimCommand[], candles: Candle[], way: Way, now: number): Result {
  const k0 = candles.findIndex((k) => sig.receivedAt >= k.t && sig.receivedAt < k.t + BAR_MS);
  if (k0 < 0) return { status: "skipped", why: "no_candles" };
  const entryBar = candles[k0]!;
  const entryAt = entryBar.t + BAR_MS;
  const ordered = [...cmds].sort((a, b) => a.at - b.at);
  if (ordered.some((c) => c.at < entryAt && (c.cancel || (c.type === "close" && (c.fraction ?? 1) >= 0.999)))) {
    return { status: "skipped", why: "cancelled_before_entry" };
  }
  const long = sig.side === "long";
  const entry = entryBar.c;
  let stop = sig.stop;
  for (const c of ordered) if (c.at < entryAt && way.follow && c.type === "move_stop" && c.stopPrice) stop = c.stopPrice;
  if (long ? stop >= entry : stop <= entry) return { status: "skipped", why: "price_beyond_stop" };
  const price = (pct: number) => entry * (1 + (long ? 1 : -1) * pct / 100);
  const take = way.take !== null ? price(way.take) : null;
  let left = 1, realized = 0, peak = 0, be = false, partialDone = false;
  let stopKind: Reason = "stop";
  let last: Reason | null = null;
  const book = (share: number, exit: number, why: Reason) => {
    const s = Math.min(share, left);
    if (s <= 0) return;
    realized += s * (movePct(sig.side, entry, exit) - SIM_FEE_PCT);
    left -= s;
    last = why;
  };
  const holdEnd = way.mgmt && sig.maxHoldH ? entryAt + sig.maxHoldH * 3_600_000 : null;
  let ci = ordered.findIndex((c) => c.at >= entryAt);
  if (ci < 0) ci = ordered.length;
  let closedAt: number | null = null;
  for (let k = k0 + 1; k < candles.length && left > 1e-9; k++) {
    const b = candles[k]!;
    const end = b.t + BAR_MS;
    if (end > now) break; // only closed candles
    // 1. stop first (a gap through the stop fills at the open)
    if (long ? b.l <= stop : b.h >= stop) { book(left, long ? Math.min(b.o, stop) : Math.max(b.o, stop), stopKind); closedAt = end; break; }
    // 2. take
    if (take !== null && (long ? b.h >= take : b.l <= take)) { book(left, long ? Math.max(b.o, take) : Math.min(b.o, take), "take"); closedAt = end; break; }
    // 3. the bot's own management: peak of this candle, new stop from the next one
    if (way.mgmt) {
      peak = Math.max(peak, movePct(sig.side, entry, long ? b.h : b.l));
      const step = manageStep({ side: sig.side, entry, stop, peakPct: peak, partialDone, beMoved: be, m: way.mgmt });
      if (step.partial && way.mgmt.partial) { partialDone = true; book(way.mgmt.partial.share, price(way.mgmt.partial.at), "partial"); }
      if (step.be) be = true;
      if (step.stop !== null) { stopKind = way.mgmt.trail && peak >= way.mgmt.trail.act ? "trailing" : "breakeven"; stop = step.stop; }
      if (holdEnd !== null && end >= holdEnd) { book(left, b.c, "timeout"); closedAt = end; break; }
    }
    // 4. the source's commands received during this candle, at its close
    for (; ci < ordered.length && ordered[ci]!.at < end; ci++) {
      const c = ordered[ci]!;
      if (c.cancel) { book(left, b.c, "cancel"); break; }
      if (c.type === "close" && (way.follow || c.reason === "expired")) book(c.fraction !== null && c.fraction < 0.999 ? c.fraction : left, b.c, c.reason === "expired" && way.mgmt ? "timeout" : "source");
      // Owner 2026-11-16: the source's stop moves under every way (the bot's own ways — only when tighter).
      else if (c.type === "move_stop" && c.stopPrice && (way.follow || (long ? c.stopPrice > stop : c.stopPrice < stop))) {
        stop = c.stopPrice;
        const locked = movePct(sig.side, entry, stop);
        stopKind = locked > 0.3 ? "trailing" : locked >= -0.05 ? "breakeven" : "stop";
      }
    }
    if (left <= 1e-9) { closedAt = end; break; }
  }
  if (left > 1e-9) {
    // Still open: unrealised at the last closed candle (shown as «в пути», not counted).
    const lastBar = [...candles].reverse().find((k) => k.t + BAR_MS <= now) ?? entryBar;
    return { status: "open", openedAt: entryAt, closedAt: null, entry, pnlPct: r4(realized + left * (movePct(sig.side, entry, lastBar.c) - SIM_FEE_PCT)), reason: null };
  }
  return { status: "closed", openedAt: entryAt, closedAt, entry, pnlPct: r4(realized), reason: last };
}

export function waysFor(source: Source): Way[] {
  if (source === "cab") return CAB_WAYS.map((w) => ({ id: w.id, follow: true, take: w.take, mgmt: null }));
  return nihilistStrategies().map((m) => (m.id === "source"
    ? { id: m.id, follow: true, take: null, mgmt: null }
    : { id: m.id, follow: false, take: m.take, mgmt: m }));
}

// ---------------- storage ----------------
type Stored = { final: boolean; signal: Omit<SimSignal, "stop" | "maxHoldH">; ways: Record<string, Result>; at: number };
let ready: Promise<void> | null = null;
export function ensureResultsTable(): Promise<void> {
  ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS ex_strategy_results (
      key text PRIMARY KEY,
      body jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => undefined);
  ready.catch(() => { ready = null; });
  return ready;
}
export async function putResult(key: string, body: unknown): Promise<void> {
  await ensureResultsTable();
  await pool.query(
    `INSERT INTO ex_strategy_results (key, body, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [key, JSON.stringify(body)]);
}
export async function getResult<T>(key: string): Promise<T | null> {
  await ensureResultsTable();
  const r = await pool.query<{ body: T }>("SELECT body FROM ex_strategy_results WHERE key = $1", [key]);
  return r.rows[0]?.body ?? null;
}

// ---------------- BingX market data (public, no key) ----------------
async function publicGet(path: string): Promise<any> {
  const res = await fetch(`${HOSTS.real}${path}`, { signal: AbortSignal.timeout(15_000) });
  const body = JSON.parse(await res.text());
  if (body?.code !== 0) throw new Error(`BingX ${path.split("?")[0]}: ${body?.msg ?? res.status}`);
  return body.data;
}
async function listedSymbols(): Promise<Set<string>> {
  const data = await publicGet("/openApi/swap/v2/quote/contracts");
  return new Set((Array.isArray(data) ? data : []).map((c: any) => String(c.symbol)));
}
async function candles5m(exSym: string, from: number, to: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  for (let start = from; start < to; start += 1000 * BAR_MS) {
    const end = Math.min(to, start + 1000 * BAR_MS);
    const data = await publicGet(`/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(exSym)}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`);
    for (const k of Array.isArray(data) ? data : []) {
      const t = Number(k.time);
      if (Number.isFinite(t)) out.set(t, { t, o: Number(k.open), h: Number(k.high), l: Number(k.low), c: Number(k.close) });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ---------------- the pass ----------------
const sourceOf = (id: string): Source | null => (id.startsWith("cab-signal-") ? "cab" : id.startsWith("nh-signal-") ? "nihilist" : null);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

function signalOf(id: string, body: any, receivedAt: number): SimSignal | null {
  const source = sourceOf(id);
  if (!source) return null;
  const sideRaw = String(body?.side ?? "").toLowerCase();
  const side: Side | null = sideRaw === "buy" || sideRaw === "long" ? "long" : sideRaw === "sell" || sideRaw === "short" ? "short" : null;
  const stop = num(body?.stopLoss);
  const symbol = String(body?.symbol ?? "").toUpperCase();
  if (!side || !(stop > 0) || !symbol) return null;
  const hold = num(body?.exitRules?.maxHoldHours);
  return {
    id, source, symbol, side, receivedAt, stop,
    pattern: typeof body?.patternId === "string" ? body.patternId : typeof body?.setup === "string" ? body.setup : null,
    maxHoldH: Number.isFinite(hold) && hold > 0 ? hold : null,
  };
}
const included = (s: SimSignal) => s.source === "nihilist" || (s.symbol !== "BTCUSDT" && CAB_PATTERNS.includes(s.pattern ?? ""));

let passRunning = false;
/** One pass: every received signal without a final result is (re)calculated. */
export async function runStrategyResultsPass(log: (m: string, e?: unknown) => void = () => undefined): Promise<{ done: number; failed: number }> {
  if (passRunning) return { done: 0, failed: 0 };
  passRunning = true;
  let done = 0, failed = 0;
  try {
    await ensureResultsTable();
    const sigs = await pool.query<{ source_signal_id: string; body: any; received_at: Date }>(
      `SELECT i.source_signal_id, i.body, i.received_at FROM ex_inbox i
        WHERE i.kind = 'signal' AND (i.source_signal_id LIKE 'cab-signal-%' OR i.source_signal_id LIKE 'nh-signal-%')
          AND NOT EXISTS (SELECT 1 FROM ex_strategy_results r WHERE r.key = 'sig:' || i.source_signal_id AND (r.body->>'final')::boolean)
        ORDER BY i.id`);
    if (!sigs.rows.length) return { done, failed };
    const listed = await listedSymbols();
    for (const row of sigs.rows) {
      const sig = signalOf(row.source_signal_id, row.body, row.received_at.getTime());
      if (!sig || !included(sig)) continue;
      try {
        const now = Date.now();
        const map = mapSymbol(sig.symbol, (s) => listed.has(s));
        const f = map?.factor ?? 1;
        const cmdRows = await pool.query<{ body: any; received_at: Date }>(
          "SELECT body, received_at FROM ex_inbox WHERE kind = 'command' AND source_signal_id = $1 ORDER BY id", [sig.id]);
        const cmds: SimCommand[] = [];
        for (const c of cmdRows.rows) {
          const p = parseCommand(c.body, c.received_at.getTime());
          if (!p.ok) continue;
          const v = p.value;
          const cancel = v.type === "cancel_entry" || (v.type === "position_review"
            && (sourceActionKind(v.sourceAction ?? "") === "close" || sourceActionKind(v.trackerStatus ?? "") === "close"));
          if (v.type === "position_review" && !cancel) continue;
          cmds.push({ at: c.received_at.getTime(), type: v.type, stopPrice: v.stopPrice !== null ? v.stopPrice * f : null, fraction: v.fraction, reason: v.reason, cancel });
        }
        const s2 = { ...sig, stop: sig.stop * f };
        const ways: Record<string, Result> = {};
        if (!map) for (const w of waysFor(sig.source)) ways[w.id] = { status: "skipped", why: "no_contract" };
        else {
          const from = Math.floor(sig.receivedAt / BAR_MS) * BAR_MS;
          const bars = await candles5m(exSymbol(map.symbol), from, now);
          for (const w of waysFor(sig.source)) ways[w.id] = simulate(s2, cmds, bars, w, now);
        }
        const final = Object.values(ways).every((r) => r.status !== "open")
          // no candles yet for a fresh signal: try again next pass
          && !Object.values(ways).some((r) => r.status === "skipped" && r.why === "no_candles" && now - sig.receivedAt < 3_600_000);
        const stored: Stored = { final, signal: { id: sig.id, source: sig.source, symbol: sig.symbol, side: sig.side, pattern: sig.pattern, receivedAt: sig.receivedAt }, ways, at: now };
        await putResult(`sig:${sig.id}`, stored);
        done += 1;
      } catch (e) {
        failed += 1;
        log(`strategy results: ${sig.id} failed`, e);
      }
    }
    await putResult("pass", { at: Date.now(), done, failed });
  } finally {
    passRunning = false;
  }
  return { done, failed };
}

/** Production only: first pass 2 minutes after the start, then every 15 minutes. */
export function startStrategyResults(log: (m: string, e?: unknown) => void): void {
  if (process.env.REPLIT_DEPLOYMENT !== "1") return;
  const go = () => { void runStrategyResultsPass(log).catch((e) => log("strategy results pass failed", e)); };
  setTimeout(() => { go(); setInterval(go, PASS_MS); }, 2 * 60_000);
}

// ---------------- reports in the shapes the pages already show ----------------
type Row = { pnlPct: number; openedAt: number; closedAt: number; reason: Reason | null };
export type Stats = {
  n: number; open: number; winPct: number; stopPct: number; avg: number; sum: number; maxDd: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
};
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Same measures as the Nihilist report (crypto-nihilist analysis/strategy-sim.ts stats). */
export function stats(rows: Row[], open: number): Stats {
  const xs = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const n = xs.length;
  const share = (f: (r: Row) => boolean) => (n ? (100 * xs.filter(f).length) / n : 0);
  const sum = xs.reduce((a, r) => a + r.pnlPct, 0);
  let cum = 0, peakCum = 0, maxDd = 0;
  for (const r of xs) { cum += r.pnlPct; peakCum = Math.max(peakCum, cum); maxDd = Math.max(maxDd, peakCum - cum); }
  const opens = xs.map((r) => r.openedAt);
  const mid = n ? (Math.min(...opens) + Math.max(...opens)) / 2 : 0;
  const half = (first: boolean) => {
    const p = xs.filter((r) => (r.openedAt < mid) === first);
    return { n: p.length, avg: p.length ? r2(p.reduce((a, r) => a + r.pnlPct, 0) / p.length) : null };
  };
  return {
    n, open, winPct: r2(share((r) => r.pnlPct > 0.5)), stopPct: r2(share((r) => r.reason === "stop")),
    avg: n ? r2(sum / n) : 0, sum: r2(sum), maxDd: r2(maxDd), half1: half(true), half2: half(false),
  };
}

async function storedFor(source: Source, days: number | null): Promise<Stored[]> {
  await ensureResultsTable();
  const prefix = source === "cab" ? "sig:cab-signal-%" : "sig:nh-signal-%";
  const r = await pool.query<{ body: Stored }>("SELECT body FROM ex_strategy_results WHERE key LIKE $1", [prefix]);
  const since = days ? Date.now() - days * 86_400_000 : 0;
  return r.rows.map((x) => x.body).filter((b) => b.signal.receivedAt >= since).sort((a, b) => a.signal.receivedAt - b.signal.receivedAt);
}
function bucket(list: Stored[], wayIds: string[], pick: (s: Stored) => boolean): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const id of wayIds) {
    const rows: Row[] = [];
    let open = 0;
    for (const s of list) {
      if (!pick(s)) continue;
      const r = s.ways[id];
      if (!r || r.status === "skipped") continue;
      if (r.status === "open") open += 1;
      else rows.push({ pnlPct: r.pnlPct, openedAt: r.openedAt, closedAt: r.closedAt ?? r.openedAt, reason: r.reason });
    }
    out[id] = stats(rows, open);
  }
  return out;
}
const span = (list: Stored[]) => ({
  from: list.length ? new Date(list[0]!.signal.receivedAt).toISOString() : null,
  to: list.length ? new Date(list[list.length - 1]!.signal.receivedAt).toISOString() : null,
});
async function lastPass(): Promise<string | null> {
  const p = await getResult<{ at: number }>("pass");
  return p ? new Date(p.at).toISOString() : null;
}

/** CAB: the shape of CAB's own report (exits, byPattern), from the signals the bot received. */
export async function ownCabReport(daysRaw: unknown) {
  const d = Number(daysRaw);
  const days = Number.isInteger(d) && d > 0 ? d : null;
  const list = await storedFor("cab", days);
  const ids = CAB_WAYS.map((w) => w.id);
  const byPattern: Record<string, Record<string, Stats>> = {};
  for (const p of CAB_PATTERNS) {
    const sub = list.filter((s) => s.signal.pattern === p);
    if (sub.length) byPattern[p] = bucket(sub, ids, () => true);
  }
  const closed = list.filter((s) => s.ways.follow_cab?.status === "closed").length;
  return { own: true, days, ...span(list), signals: list.length, trades: closed, exits: bucket(list, ids, () => true), byPattern, calculatedAt: await lastPass() };
}

/** Nihilist: one dataset «bot» in the shape of Nihilist's report (groups long_filtered / long_all / short). */
export async function ownNihilistDataset() {
  const list = await storedFor("nihilist", null);
  const ms = nihilistStrategies();
  const ids = ms.map((m) => m.id);
  const longs = bucket(list, ids, (s) => s.signal.side === "long");
  const shorts = bucket(list, ids, (s) => s.signal.side === "short");
  const grp = (b: Record<string, Stats>) => ms.map((m) => ({ id: m.id, label: m.label, stats: b[m.id]! }));
  return {
    name: "bot" as const, ...span(list), trades: list.filter((s) => s.ways.source?.status === "closed").length,
    groups: { long_filtered: grp(longs), long_all: grp(longs), short: grp(shorts) }, calculatedAt: await lastPass(),
  };
}
