import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate, stats, waysFor, type Candle, type SimCommand, type SimSignal } from "./strategy-results";

const M = 5 * 60_000;
const T0 = Date.UTC(2026, 10, 10, 0, 0);
/** Candles from closes: each bar opens at the previous close; highs/lows given or ±0.2 %. */
function bars(rows: Array<[number, number?, number?]>): Candle[] {
  let prev = rows[0]![0];
  return rows.map(([c, h, l], i) => {
    const o = i === 0 ? c : prev; prev = c;
    return { t: T0 + i * M, o, c, h: h ?? Math.max(o, c) * 1.002, l: l ?? Math.min(o, c) * 0.998 };
  });
}
const long: SimSignal = { id: "nh-signal-1", source: "nihilist", symbol: "XUSDT", side: "long", pattern: null, receivedAt: T0 + 60_000, stop: 95, maxHoldH: null };
const way = (id: string) => waysFor("nihilist").find((w) => w.id === id)!;
const cab = (id: string) => waysFor("cab").find((w) => w.id === id)!;
const NOW = T0 + 1000 * M;

test("take +5 % fills at the take; the fee is taken", () => {
  const r = simulate(long, [], bars([[100], [101], [103], [106]]), way("take5"), NOW);
  assert.equal(r.status, "closed");
  if (r.status === "closed") { assert.equal(r.reason, "take"); assert.equal(r.pnlPct, 4.9); }
});

test("stop first: a candle through both the stop and the take is a stop", () => {
  const r = simulate(long, [], bars([[100], [100, 106, 94]]), way("take5"), NOW);
  assert.equal(r.status === "closed" && r.reason, "stop");
  assert.equal(r.status === "closed" && r.pnlPct, -5.1);
});

test("follow the source: its moved stop works from the next candle, its close at the candle close", () => {
  const cmds: SimCommand[] = [
    { at: T0 + 2 * M + 1000, type: "move_stop", stopPrice: 100, fraction: null, reason: "breakeven", cancel: false },
    { at: T0 + 4 * M + 1000, type: "close", stopPrice: null, fraction: null, reason: "profit", cancel: false },
  ];
  const r = simulate(long, cmds, bars([[100], [102], [104], [106], [108], [110]]), way("source"), NOW);
  assert.equal(r.status === "closed" && r.reason, "source");
  assert.equal(r.status === "closed" && r.pnlPct, 7.9);
});

test("a cancellation before the entry skips the signal for every way", () => {
  const cmds: SimCommand[] = [{ at: T0 + 2 * 60_000, type: "cancel_entry", stopPrice: null, fraction: null, reason: "x", cancel: true }];
  assert.deepEqual(simulate(long, cmds, bars([[100], [101]]), cab("take5"), NOW), { status: "skipped", why: "cancelled_before_entry" });
});

test("the bot's own trailing: from +15 % the stop follows the peak at −10 p.p., from the next candle", () => {
  const trail = waysFor("nihilist").find((w) => w.mgmt?.trail && w.take === null && w.id !== "source");
  if (!trail) return; // no own trailing way in this set
  const r = simulate(long, [], bars([[100], [108], [116], [120, 120, 119], [108, 119, 107]]), trail, NOW);
  assert.equal(r.status === "closed" && r.reason, "trailing");
});

test("Nihilist's close at the end of the holding time closes the bot's own ways too", () => {
  const cmds: SimCommand[] = [{ at: T0 + 2 * M + 1000, type: "close", stopPrice: null, fraction: null, reason: "expired", cancel: false }];
  const r = simulate(long, cmds, bars([[100], [101], [102], [103]]), way("take10"), NOW);
  assert.equal(r.status === "closed" && r.reason, "timeout");
  const other = simulate(long, [{ ...cmds[0]!, reason: "profit" }], bars([[100], [101], [102], [103]]), way("take10"), NOW);
  assert.equal(other.status, "open");
});

test("stats: sum, drawdown, halves", () => {
  const s = stats([
    { pnlPct: 5, openedAt: 1, closedAt: 2, reason: "take" },
    { pnlPct: -3, openedAt: 3, closedAt: 4, reason: "stop" },
    { pnlPct: -2, openedAt: 5, closedAt: 6, reason: "stop" },
  ], 1);
  assert.equal(s.sum, 0); assert.equal(s.maxDd, 5); assert.equal(s.open, 1); assert.equal(Math.round(s.stopPct), 67);
});

test("the bot's stop is the source's stop rounded away from the price, on the last price", async () => {
  const { stopAt, TRIGGER_PRICE } = await import("./plan");
  const c = { symbol: "BR-USDT", quantityPrecision: 0, pricePrecision: 4, minQty: 0, minNotional: 0 };
  assert.equal(stopAt("long", 0.123456, c), "0.1234");
  assert.equal(stopAt("short", 0.123446, c), "0.1235");
  assert.equal(TRIGGER_PRICE, "CONTRACT_PRICE");
});
