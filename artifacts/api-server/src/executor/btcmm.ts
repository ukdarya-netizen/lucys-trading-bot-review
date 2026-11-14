/**
 * Bitcoin Margin Master — the third connected bot (owner 2026-11-14). Its settings per user (owner and each
 * subscriber), kept as a reserved row of ex_source_settings (`btcmm:<account>`, JSON in `strategy`; no DDL):
 *   size        — % of the deposit or an amount (margin);
 *   leverage    — null = the signal's own (1D ×10, 4h ×20), else the user's 1…125;
 *   reserve     — the most the bot may add as margin so that liquidation sits beyond the stop; null = from the free
 *                 balance (as for every coin). Checked before the entry: when the trade would need more, it is not
 *                 opened and Telegram says how much to add;
 *   families    — template per pattern family (range 1D, levels 1D, Smart Money 4h / 1D, cascade): on/off,
 *                 long / short / both, own size and leverage or «как общие».
 * Management is always «Как Bitcoin MM» (its commands: half at target 1 + stop to entry, the rest at target 2,
 * holding time). The ladders are virtual for now (the panel reads Bitcoin MM's strategy report).
 */
import { pool } from "@workspace/db";
import { LIQ_BUFFER, type Side } from "./plan";

export type Alloc = { mode: "percent" | "amount"; value: number };
export type FamilyId = "range_1d" | "levels_1d" | "smc_4h" | "smc_1d" | "cascade";
export type FamilyRule = { on: boolean; sides: "both" | "long" | "short"; leverage: number | null; alloc: Alloc | null };
export type BtcMm = { alloc: Alloc; leverage: number | null; reserve: number | null; families: Record<FamilyId, FamilyRule> };

export const BTC_MAX_LEVERAGE = 125;
/** The families, the signal's leverage and the largest stop of its profile (Bitcoin MM: 1D ×10 ≤7.68%, 4h ×20 ≤3.68%). */
export const FAMILIES: Array<{ id: FamilyId; label: string; match: RegExp; signalLeverage: number; maxStopPct: number }> = [
  { id: "range_1d", label: "Диапазон 1D", match: /^d1_(breakout|deviation)_/, signalLeverage: 10, maxStopPct: 7.68 },
  { id: "levels_1d", label: "Уровни 1D", match: /^neon_.*_1d_/, signalLeverage: 10, maxStopPct: 7.68 },
  { id: "smc_4h", label: "Smart Money 4h", match: /^smc_4h_/, signalLeverage: 20, maxStopPct: 3.68 },
  { id: "smc_1d", label: "Smart Money 1D", match: /^smc_1d_/, signalLeverage: 10, maxStopPct: 7.68 },
  { id: "cascade", label: "Каскад ликвидаций", match: /^lc_/, signalLeverage: 20, maxStopPct: 3.68 },
];
export const familyOf = (pattern: string | null | undefined): FamilyId | null =>
  pattern ? FAMILIES.find((f) => f.match.test(pattern))?.id ?? null : null;

export const btcMmDefault = (): BtcMm => ({
  alloc: { mode: "percent", value: 1 }, leverage: null, reserve: null,
  families: Object.fromEntries(FAMILIES.map((f) => [f.id, { on: true, sides: "both", leverage: null, alloc: null }])) as Record<FamilyId, FamilyRule>,
});

const okAlloc = (a: any): a is Alloc => a && (a.mode === "percent" || a.mode === "amount") && Number.isFinite(a.value) && a.value > 0 && (a.mode !== "percent" || a.value <= 100);
const okLev = (v: any) => v === null || (Number.isInteger(v) && v >= 1 && v <= BTC_MAX_LEVERAGE);

/** Validates a whole settings object; returns an error code or the clean settings. */
export function validBtcMm(b: any): { ok: true; value: BtcMm } | { ok: false; code: string } {
  if (!b || typeof b !== "object") return { ok: false, code: "invalid_payload" };
  if (!okAlloc(b.alloc)) return { ok: false, code: "invalid_allocation" };
  if (!okLev(b.leverage)) return { ok: false, code: "invalid_leverage" };
  if (!(b.reserve === null || (Number.isFinite(b.reserve) && b.reserve >= 0))) return { ok: false, code: "invalid_reserve" };
  const families = {} as Record<FamilyId, FamilyRule>;
  for (const f of FAMILIES) {
    const r = b.families?.[f.id] ?? btcMmDefault().families[f.id];
    if (typeof r.on !== "boolean" || !["both", "long", "short"].includes(r.sides)) return { ok: false, code: "invalid_family" };
    if (!okLev(r.leverage ?? null)) return { ok: false, code: "invalid_leverage" };
    if (!(r.alloc === null || r.alloc === undefined || okAlloc(r.alloc))) return { ok: false, code: "invalid_allocation" };
    families[f.id] = { on: r.on, sides: r.sides, leverage: r.leverage ?? null, alloc: r.alloc ? { mode: r.alloc.mode, value: Number(r.alloc.value) } : null };
  }
  return { ok: true, value: { alloc: { mode: b.alloc.mode, value: Number(b.alloc.value) }, leverage: b.leverage, reserve: b.reserve === null ? null : Number(b.reserve), families } };
}

const key = (accountKey: string) => {
  if (accountKey !== "owner" && !/^sub-[1-9]\d*$/.test(accountKey)) throw new Error("invalid_account_key");
  return `btcmm:${accountKey}`;
};

export async function getBtcMm(accountKey: string): Promise<BtcMm> {
  const r = await pool.query<{ strategy: string }>("SELECT strategy FROM ex_source_settings WHERE source = $1", [key(accountKey)]);
  if (!r.rows.length) return btcMmDefault();
  try {
    const v = validBtcMm(JSON.parse(r.rows[0]!.strategy));
    if (v.ok) return v.value;
  } catch { /* unreadable: defaults */ }
  return btcMmDefault();
}

export async function saveBtcMm(accountKey: string, b: unknown): Promise<{ ok: true; settings: BtcMm } | { ok: false; code: string }> {
  const v = validBtcMm(b);
  if (!v.ok) return v;
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, subscribers, strategy, updated_at) VALUES ($1, false, false, $2, now())
     ON CONFLICT (source) DO UPDATE SET strategy = EXCLUDED.strategy, updated_at = now()`, [key(accountKey), JSON.stringify(v.value)]);
  return { ok: true, settings: v.value };
}

/** What a signal gets under these settings: skipped (why) or its leverage and size. */
export function planBtcMm(s: BtcMm, pattern: string | null, side: Side, signalLeverage: number | null):
  { skip: "btcmm_unknown_pattern" | "btcmm_family_off" | "side_disabled" } | { family: FamilyId; leverage: number; alloc: Alloc } {
  const family = familyOf(pattern);
  if (!family) return { skip: "btcmm_unknown_pattern" };
  const rule = s.families[family];
  if (!rule.on) return { skip: "btcmm_family_off" };
  if (rule.sides !== "both" && rule.sides !== side) return { skip: "side_disabled" };
  const fam = FAMILIES.find((f) => f.id === family)!;
  const leverage = rule.leverage ?? s.leverage ?? (signalLeverage && signalLeverage >= 1 && signalLeverage <= BTC_MAX_LEVERAGE ? Math.round(signalLeverage) : fam.signalLeverage);
  return { family, leverage, alloc: rule.alloc ?? s.alloc };
}

/** BingX BTC maintenance margin (lowest tier), for the estimate before the entry. */
export const BTC_MMR = 0.004;
/**
 * Margin to add so that liquidation is beyond the stop by the bot's buffer, estimated before the entry
 * (isolated linear: liquidation ≈ entry × (1 ∓ 1/leverage ± mmr); adding Δ moves it by Δ / qty).
 */
export function reserveNeeded(p: { side: Side; entry: number; stop: number; qty: number; leverage: number }): number {
  const liq = p.side === "long" ? p.entry * (1 - 1 / p.leverage + BTC_MMR) : p.entry * (1 + 1 / p.leverage - BTC_MMR);
  const buffer = p.entry * LIQ_BUFFER;
  const gap = p.side === "long" ? liq + buffer - p.stop : p.stop - (liq - buffer);
  return gap > 0 ? Math.ceil(gap * p.qty * 100) / 100 : 0;
}

const allocText = (a: Alloc) => (a.mode === "percent" ? `${a.value}% депозита` : `${a.value} USDT`);
/** One-line summary for Telegram when the settings change. */
export function describeBtcMm(s: BtcMm): string {
  const side = { both: "лонги и шорты", long: "только лонги", short: "только шорты" };
  const rows = FAMILIES.map((f) => {
    const r = s.families[f.id];
    if (!r.on) return `${f.label}: выключен`;
    const own = [r.alloc ? allocText(r.alloc) : "", r.leverage ? `x${r.leverage}` : ""].filter(Boolean).join(", ");
    return `${f.label}: ${side[r.sides]}${own ? ` (${own})` : ""}`;
  });
  return [
    `Размер: ${allocText(s.alloc)} · плечо: ${s.leverage ? `x${s.leverage}` : "из сигнала (1D x10, 4h x20)"}`,
    `Запас на добор маржи: ${s.reserve === null ? "из свободного баланса" : `${s.reserve} USDT`}`,
    "Ведение: как Bitcoin MM",
    ...rows,
  ].join("\n");
}

/** Bitcoin MM's strategy report (virtual ladders), from its site (origin of BTC_POSITION_SYNC_URL) with BTC_TRADING_TOKEN. */
export async function btcMmReport(): Promise<{ status: number; body: any }> {
  const token = process.env.BTC_TRADING_TOKEN?.trim();
  const sync = process.env.BTC_POSITION_SYNC_URL?.trim();
  let origin: string | null = null;
  try { origin = sync ? new URL(sync).origin : null; } catch { origin = null; }
  if (!token || !origin) return { status: 503, body: { error: { code: "btc_not_configured", message: "Не заданы BTC_POSITION_SYNC_URL и BTC_TRADING_TOKEN" } } };
  try {
    const r = await fetch(`${origin}/api/trading/strategy-report`, { headers: { "x-trading-token": token, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const body = (await r.json().catch(() => ({}))) as any;
    if (r.ok) return { status: 200, body };
    return { status: r.status, body: { error: { code: String(body?.error ?? r.status), message: r.status === 401 ? "Bitcoin MM не принял токен" : "Bitcoin MM не ответил" } } };
  } catch {
    return { status: 502, body: { error: { code: "btc_unreachable", message: "Bitcoin MM недоступен" } } };
  }
}
