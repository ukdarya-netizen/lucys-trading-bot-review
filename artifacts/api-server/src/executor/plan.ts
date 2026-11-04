/**
 * Pure calculations of the executor (no I/O): size, entry price cap, margin
 * top-up that puts liquidation beyond the stop, take price, results.
 */
import { decimalAt, type Contract } from "./bingx";

export type Side = "long" | "short";
export const posSide = (s: Side) => (s === "long" ? "LONG" : "SHORT") as "LONG" | "SHORT";
export const openSide = (s: Side) => (s === "long" ? "BUY" : "SELL");
export const closeSide = (s: Side) => (s === "long" ? "SELL" : "BUY");
const dir = (s: Side) => (s === "long" ? 1 : -1);

/** Max slippage of the entry (limit IOC at ask +0.5% / bid −0.5%). */
export const ENTRY_SLIPPAGE = 0.005;
/** Liquidation must stay at least this far beyond the stop (share of entry). */
export const LIQ_BUFFER = 0.005;
export const SIGNAL_TTL_MS = 10 * 60_000;

export type Sizing = { marginUsd: number; leverage: number };

export function entryQuantity(sz: Sizing, price: number, c: Contract): { qty: string; notional: number } | { error: string } {
  if (!(price > 0)) return { error: "no_price" };
  const qty = decimalAt((sz.marginUsd * sz.leverage) / price, c.quantityPrecision, "floor");
  const q = Number(qty);
  if (!(q > 0) || (c.minQty && q < c.minQty)) return { error: "below_min_quantity" };
  if (c.minNotional && q * price < c.minNotional) return { error: "below_min_notional" };
  return { qty, notional: q * price };
}

export function entryLimitPrice(side: Side, quote: { ask: number; bid: number }, c: Contract): string {
  return side === "long"
    ? decimalAt(quote.ask * (1 + ENTRY_SLIPPAGE), c.pricePrecision, "ceil")
    : decimalAt(quote.bid * (1 - ENTRY_SLIPPAGE), c.pricePrecision, "floor");
}

/** The stop must be on the loss side of the price. */
export function stopValid(side: Side, stop: number, price: number): boolean {
  return side === "long" ? stop < price : stop > price;
}

/**
 * Extra isolated margin so that liquidation is beyond the stop by the buffer.
 * Isolated linear contract: adding Δ moves liquidation by Δ / qty.
 * Returns "0.00" when nothing is needed.
 */
export function topUpAmount(p: {
  side: Side; qty: number; stop: number; liquidation: number | null; entry: number; minIncrease: number; pricePrecision: number;
}): string {
  if (p.liquidation === null) return "0.00";
  const buffer = Math.max(p.entry * LIQ_BUFFER, 10 ** -p.pricePrecision);
  const gap = p.side === "long" ? p.liquidation + buffer - p.stop : p.stop - (p.liquidation - buffer);
  if (gap <= 0) return "0.00";
  const required = gap * p.qty;
  return ((Math.ceil(Math.max(required, p.minIncrease) * 100 - 1e-9) + 1) / 100).toFixed(2);
}

export function liquidationSafe(side: Side, liquidation: number | null, stop: number, entry: number): boolean {
  if (liquidation === null) return true; // BingX gives none = no liquidation risk on this size
  const buffer = entry * LIQ_BUFFER * 0.5; // after the top-up, accept half the planned buffer
  return side === "long" ? liquidation + buffer < stop : liquidation - buffer > stop;
}

export function takePrice(side: Side, entry: number, pct: number, c: Contract): string {
  return decimalAt(entry * (1 + dir(side) * pct / 100), c.pricePrecision, side === "long" ? "ceil" : "floor");
}

export function movePct(side: Side, entry: number, price: number): number {
  return ((price - entry) / entry) * 100 * dir(side);
}

export function pnl(side: Side, entry: number, exit: number, qty: number): number {
  return (exit - entry) * qty * dir(side);
}

/** Strategy → take % (null = follow the source: its stop and its close only). */
export type Strategy = { name: string; takePct: number | null; patterns: Set<string> | null };
const TAKES: Record<string, number | null> = { follow_cab: null, take5: 5, take8: 8, take10: 10 };
export function resolveStrategy(row: { strategy?: string | null; pattern_exit?: string | null; patterns?: string | null } | null): Strategy {
  const name = row?.strategy ?? "take5";
  if (name === "patterns") {
    const list = (row?.patterns ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    return { name, takePct: TAKES[row?.pattern_exit ?? "follow_cab"] ?? null, patterns: list.length ? new Set(list) : null };
  }
  return { name, takePct: name in TAKES ? TAKES[name]! : 5, patterns: null };
}
/** BTC always follows the source (its own ladder at the source). */
export function takeFor(strategy: Strategy, symbol: string): number | null {
  return /^BTC-?USDT$/.test(symbol) ? null : strategy.takePct;
}

/**
 * How the trading bot manages a Nihilist trade (owner 2026-11-03). Same ids
 * and rules as the Nihilist report «Стратегии торговли»
 * (crypto-nihilist analysis/strategy-sim.ts), so a variant chosen there is
 * traded exactly so here. "source" = Nihilist leads: its own stop moves and
 * closes by commands. Every other variant is managed by the trading bot on
 * the live price: be (stop to entry at +be%), take (whole rest at +take%, an
 * exchange order), partial (share at +at%, then stop to entry), trail (from
 * +act% the stop follows the peak at peak − gap p.p.); holding time as
 * Nihilist (from the signal's exitRules.maxHoldHours).
 */
export type Mgmt = {
  id: string; label: string; be: number | null; take: number | null;
  partial: { at: number; share: number } | null; trail: { act: number; gap: number } | null;
};
const mg = (id: string, label: string, p: Partial<Omit<Mgmt, "id" | "label">>): Mgmt =>
  ({ id, label, be: p.be ?? null, take: p.take ?? null, partial: p.partial ?? null, trail: p.trail ?? null });
/** The four ways the owner chose (2026-11-03). Ids match the Nihilist report. */
export function nihilistStrategies(): Mgmt[] {
  return [
    mg("source", "Полностью как торгует Нигилист", { be: 5, trail: { act: 15, gap: 10 } }),
    mg("take5", "Полный фикс на +5%", { take: 5 }),
    mg("take10", "Полный фикс на +10%", { take: 10 }),
    mg("take15", "Полный фикс на +15%", { take: 15 }),
  ];
}
export const nihilistStrategy = (id: string | null | undefined): Mgmt =>
  nihilistStrategies().find((m) => m.id === id) ?? nihilistStrategies()[0]!;

/** A trailing stop is moved only when it gains at least this much (p.p. of entry): no order churn. */
export const TRAIL_STEP_PCT = 0.5;

/** What the bot's own management wants now, from the peak and the current stop (pure). */
export function manageStep(p: {
  side: Side; entry: number; stop: number; peakPct: number; partialDone: boolean; beMoved: boolean; m: Mgmt;
}): { partial: boolean; stop: number | null; be: boolean } {
  const price = (pct: number) => p.entry * (1 + dir(p.side) * pct / 100);
  const tighter = (a: number, b: number) => (p.side === "long" ? b > a : b < a);
  let stop = p.stop;
  let be = p.beMoved;
  const partial = Boolean(p.m.partial && !p.partialDone && p.peakPct >= p.m.partial.at);
  if ((partial || (p.m.be !== null && p.peakPct >= p.m.be)) && !be) { be = true; if (tighter(stop, p.entry)) stop = p.entry; }
  if (p.m.trail && p.peakPct >= p.m.trail.act) {
    const t = price(p.peakPct - p.m.trail.gap);
    if (tighter(stop, t) && Math.abs(movePct(p.side, p.entry, t) - movePct(p.side, p.entry, stop)) >= TRAIL_STEP_PCT) stop = t;
  }
  return { partial, stop: stop !== p.stop ? stop : null, be };
}
