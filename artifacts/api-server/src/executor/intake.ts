/**
 * Signals and commands in (owner 2026-11-02 rewrite). Accepts what CAB really
 * sends (and Nihilist later): stores it once, answers at once, and hands it
 * to the executor without waiting for any tick.
 *   POST /api/trading/signals  → 202 {accepted:true, signal:{status:"pending"}}
 *   POST /api/trading/commands → 202 {stored:true, commandId}
 * Header x-trading-token = TRADING_INGEST_TOKEN (NIHILIST_TRADING_TOKEN for
 * the Nihilist source).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommandIn, Executor, SignalIn } from "./engine";
import { SIGNAL_TTL_MS, type Side } from "./plan";
import { inboxPut } from "./store";

function tokenOk(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}
const sourceOfToken = (given: unknown): "cab" | "nihilist" | null =>
  tokenOk(given, process.env.TRADING_INGEST_TOKEN?.trim()) ? "cab"
    : tokenOk(given, process.env.NIHILIST_TRADING_TOKEN?.trim()) ? "nihilist" : null;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

/** CAB: cab-signal-N, side "buy", stopLoss; Nihilist: nh-signal-N, side long/short, stopLoss. */
export function parseSignal(b: any, source: "cab" | "nihilist", now: number): Parsed<SignalIn> {
  if (!b || typeof b !== "object") return { ok: false, code: "invalid_payload" };
  const id = String(b.sourceSignalId ?? "");
  const idOk = source === "cab" ? /^cab-signal-[1-9]\d*$/.test(id) : /^nh-signal-[1-9]\d*$/.test(id);
  if (!idOk) return { ok: false, code: "invalid_signal_id" };
  if (b.confirmationStatus !== undefined && b.confirmationStatus !== "confirmed") return { ok: false, code: "unconfirmed_signal" };
  const symbol = String(b.symbol ?? "").toUpperCase();
  if (!/^[A-Z0-9]{1,30}USDT$/.test(symbol)) return { ok: false, code: "invalid_symbol" };
  const sideRaw = String(b.side ?? "").toLowerCase();
  const side: Side | null = sideRaw === "buy" || sideRaw === "long" ? "long" : sideRaw === "sell" || sideRaw === "short" ? "short" : null;
  if (!side) return { ok: false, code: "invalid_side" };
  const signalAt = Date.parse(String(b.signalAt ?? ""));
  if (!Number.isFinite(signalAt)) return { ok: false, code: "invalid_timestamp" };
  if (signalAt - now > 30_000) return { ok: false, code: "expired_or_future_signal" };
  // Freshness = time since the source released the signal (its message), not since
  // the candle or detection it refers to (owner 2026-11-03). Without releasedAt the
  // receipt moment counts: a source that holds a message sends it with its release time.
  const relRaw = b.releasedAt === undefined || b.releasedAt === null ? NaN : Date.parse(String(b.releasedAt));
  const releasedAt = Number.isFinite(relRaw) ? Math.min(relRaw, now) : now;
  if (Number.isFinite(relRaw) && relRaw - now > 30_000) return { ok: false, code: "expired_or_future_signal" };
  if (now - releasedAt > SIGNAL_TTL_MS) return { ok: false, code: "expired_or_future_signal" };
  const stop = num(b.stopLoss);
  if (!(stop > 0)) return { ok: false, code: "invalid_stop" };
  const ref = num(b.referencePrice ?? b.entryPrice);
  if (ref > 0 && (side === "long" ? stop >= ref : stop <= ref)) return { ok: false, code: "invalid_entry_or_stop" };
  return {
    ok: true,
    value: {
      sourceSignalId: id, source, symbol, side, pattern: typeof b.patternId === "string" ? b.patternId : typeof b.setup === "string" ? b.setup : null,
      signalAt, stop, receivedAt: now, releasedAt,
      // Nihilist's holding time (its exitRules), used when the bot manages the trade itself.
      maxHoldH: Number.isFinite(num(b.exitRules?.maxHoldHours)) && num(b.exitRules?.maxHoldHours) > 0 ? num(b.exitRules.maxHoldHours) : null,
    },
  };
}

/** CAB sends eventSeq / eventAt (and closeFractionOfInitial on a partial close); Nihilist sequence / occurredAt. */
export function parseCommand(b: any, now: number): Parsed<CommandIn> {
  if (!b || typeof b !== "object") return { ok: false, code: "invalid_payload" };
  const commandId = String(b.commandId ?? "");
  const sourceSignalId = String(b.sourceSignalId ?? "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(commandId)) return { ok: false, code: "invalid_commandId" };
  if (!/^(cab|nh)-signal-[1-9]\d*$/.test(sourceSignalId)) return { ok: false, code: "invalid_sourceSignalId" };
  const type = String(b.type ?? "");
  if (type !== "close" && type !== "move_stop" && type !== "cancel_entry" && type !== "position_review") return { ok: false, code: "invalid_type" };
  const seqRaw = b.sequence ?? b.eventSeq;
  const seq = seqRaw === undefined || seqRaw === null ? null : Number(seqRaw);
  if (seq !== null && !(Number.isSafeInteger(seq) && seq >= 1)) return { ok: false, code: "invalid_sequence" };
  const atRaw = Date.parse(String(b.occurredAt ?? b.eventAt ?? ""));
  const stopPrice = type === "move_stop" ? num(b.stopPrice) : null;
  if (type === "move_stop" && !(stopPrice! > 0)) return { ok: false, code: "invalid_stopPrice" };
  const f = b.closeFractionOfInitial === undefined || b.closeFractionOfInitial === null ? null : num(b.closeFractionOfInitial);
  if (f !== null && !(f > 0 && f <= 1)) return { ok: false, code: "invalid_fraction" };
  return {
    ok: true,
    value: {
      commandId, sourceSignalId, symbol: String(b.symbol ?? "").toUpperCase().replace("-", ""), type, seq,
      at: Number.isFinite(atRaw) ? atRaw : now, reason: String(b.reason ?? type), stopPrice, fraction: b.partial === true || (f !== null && f < 1) ? f : null,
    },
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 64_000) throw new SyntaxError("too_large"); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export const INTAKE_PATHS = new Set(["/api/trading/signals", "/api/bot/api/trading/signals", "/api/trading/commands"]);

export function createIntakeHandler(executor: Executor, opts: { now?: () => number; log?: (m: string, e?: unknown) => void } = {}) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => undefined);
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url || "/", "http://x").pathname;
    if (req.method !== "POST") return send(res, 405, { error: { code: "method_not_allowed" } });
    const source = sourceOfToken(req.headers["x-trading-token"]);
    if (!source) return send(res, 401, { accepted: false, error: { code: "unauthorized" } });
    let body: any;
    try { body = await readJson(req); } catch { return send(res, 400, { accepted: false, error: { code: "invalid_json" } }); }
    const t = now();
    try {
      if (path.endsWith("/signals")) {
        const p = parseSignal(body, source, t);
        if (!p.ok) return send(res, 422, { accepted: false, error: { code: p.code } });
        await inboxPut("signal", p.value.sourceSignalId, p.value.sourceSignalId, body);
        send(res, 202, { accepted: true, signal: { status: "pending", sourceSignalId: p.value.sourceSignalId } });
        void executor.onSignal(p.value).catch((e) => log("executor: signal failed", e));
        return;
      }
      const p = parseCommand(body, t);
      if (!p.ok) return send(res, 422, { stored: false, error: { code: p.code } });
      const fresh = await inboxPut("command", `cmd:${p.value.commandId}`, p.value.sourceSignalId, body);
      send(res, fresh ? 202 : 200, { stored: true, accepted: true, duplicate: !fresh, commandId: p.value.commandId });
      if (fresh) void executor.onCommand(p.value).catch((e) => log("executor: command failed", e));
    } catch (e) {
      log("executor: intake failed", e);
      send(res, 503, { accepted: false, error: { code: "storage_unavailable" } });
    }
  };
}
