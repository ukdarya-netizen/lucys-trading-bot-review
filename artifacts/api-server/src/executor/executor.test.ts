// Uses a LOCAL test database only: it empties the executor tables.
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.log("executor.test: skipped (needs a local test database)");
  process.exit(0);
}
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "@workspace/db";
import { createBingX } from "./bingx";
import type { Account } from "./accounts";
import { createExecutor } from "./engine";
import { createFakeBingX } from "./fake-bingx";
import { syncSource } from "./index";
import { parseCommand, parseSignal } from "./intake";
import { resolveStrategy, topUpAmount } from "./plan";
import { ensureExecutorTables } from "./store";
import type { SourceSyncStatus } from "./source-state";

const fake = createFakeBingX({ equity: 10_000, prices: { "BIRB-USDT": 100, "IDOL-USDT": 2, "BTC-USDT": 60000, "ZZZ-USDT": 100, "YYY-USDT": 100, "AAA-USDT": 100, "CCC-USDT": 100, "RECON-USDT": 100, "MOG-USDT": 0.0000005, "CNA-USDT": 100, "CNB-USDT": 100, "CNC-USDT": 100, "CND-USDT": 100, "MRG-USDT": 100, "PRV-USDT": 100, "PRW-USDT": 100 } });
let host = "";
const sent: string[] = [];
let strategy = resolveStrategy({ strategy: "take5" });
const account = (): Account => ({
  id: "owner-vst", label: "BingX VST", env: "vst", key: "k", secret: "s",
  allocation: { mode: "percent", value: 1 }, strategy, startedAt: 0, subscriberId: null, sources: new Set(["cab", "nihilist"]),
});
let ex: ReturnType<typeof createExecutor>;

before(async () => {
  host = await fake.start();
  await ensureExecutorTables();
  ex = createExecutor({
    loadAccounts: async () => [account()],
    entryAllowed: async () => true,
    bingx: (a) => createBingX({ env: a.env, key: a.key, secret: a.secret, host }),
    send: async (t) => { sent.push(t); },
  });
});
after(async () => { await fake.stop(); await pool.end(); });
beforeEach(async () => {
  await pool.query("TRUNCATE ex_trades, ex_events, ex_inbox RESTART IDENTITY");
  await pool.query("DELETE FROM ex_source_settings");
  sent.length = 0;
});

const sig = (id: number, symbol: string, stop: number, at = Date.now(), ref = stop * 1.1) => {
  const p = parseSignal({
    sourceSignalId: `cab-signal-${id}`, patternId: "liquidation_cascade", confirmationStatus: "confirmed",
    signalAt: new Date(at).toISOString(), symbol, side: "buy", orderType: "market", quantity: "1", referencePrice: String(ref), stopLoss: String(stop),
  }, "cab", Date.now());
  assert.ok(p.ok, JSON.stringify(p));
  return p.value;
};
const trade = async (id: number) => (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = $1", [`cab-signal-${id}`])).rows[0];
const newOrders = (symbol: string, type: string) => fake.orders.filter((o) => o.symbol === symbol && o.type === type && o.status === "NEW");

test("long entry right away: IOC with the stop attached, margin added until liquidation is beyond a 9% stop, +5% take", async () => {
  fake.setPrice("BIRB-USDT", 100);
  const t0 = Date.now();
  await ex.onSignal(sig(1, "BIRBUSDT", 91));
  const ms = Date.now() - t0;
  const t = await trade(1);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.ok(ms < 5000, `entry took ${ms} ms`);
  const entryOrder = fake.calls.find((c) => c.path === "/openApi/swap/v2/trade/order" && c.params.type === "LIMIT")!;
  assert.equal(entryOrder.params.timeInForce, "IOC");
  assert.match(entryOrder.params.stopLoss!, /"stopPrice":91/);
  assert.ok(Number(t.margin_added) > 0, "margin topped up");
  const liq = fake.liq("BIRB-USDT", "LONG")!;
  assert.ok(liq < 91, `liquidation ${liq} beyond the stop`);
  assert.equal(newOrders("BIRB-USDT", "STOP_MARKET").length, 1);
  assert.equal(newOrders("BIRB-USDT", "TAKE_PROFIT_MARKET").length, 1);
  assert.ok(Math.abs(Number(t.take_price) - Number(t.entry_price) * 1.05) < 0.01);
  // 1% of 10 000 at 10x ≈ 1000 notional at 100 → ~10 coins.
  assert.ok(Math.abs(Number(t.qty) - 10) < 0.2, String(t.qty));
  assert.match(sent.at(-1)!, /Открыт лонг/);

  // Price up 3%, then CAB moves the stop to break-even in its own format (eventSeq / eventAt).
  fake.setPrice("BIRB-USDT", 103);
  const cmd = parseCommand({ commandId: "c1", sourceSignalId: "cab-signal-1", symbol: "BIRBUSDT", type: "move_stop", eventSeq: 1,
    eventAt: new Date().toISOString(), reason: "breakeven", source: "CryptoAltBullet", stopPrice: "100.05" }, Date.now());
  assert.ok(cmd.ok);
  await ex.onCommand(cmd.value);
  const stops = newOrders("BIRB-USDT", "STOP_MARKET");
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.stopPrice, 100.05);
  // the same command again does nothing
  await ex.onCommand(cmd.value);
  assert.equal(newOrders("BIRB-USDT", "STOP_MARKET").length, 1);

  // Price reaches +5%: the take fills; the reconciler books it with the real exit.
  fake.setPrice("BIRB-USDT", 105.2);
  await ex.reconcileAll();
  const done = await trade(1);
  assert.equal(done.status, "closed");
  assert.equal(done.close_reason, "take");
  assert.ok(Number(done.pnl) > 40, String(done.pnl));
  assert.equal(fake.orders.filter((o) => o.symbol === "BIRB-USDT" && o.status === "NEW").length, 0, "leftover orders cancelled");
  assert.match(sent.at(-1)!, /Позиция закрыта\. Тейк \+5% исполнен — прибыль зафиксирована\.[\s\S]*Итог в плюсе: \+/);
});

test("lost answer to the entry order: found by its client id, never sent twice", async () => {
  fake.setPrice("IDOL-USDT", 2);
  fake.dropNextOrderResponse();
  await ex.onSignal(sig(2, "IDOLUSDT", 1.9));
  const t = await trade(2);
  assert.equal(t.status, "open", JSON.stringify(t));
  const entries = fake.calls.filter((c) => c.path === "/openApi/swap/v2/trade/order" && c.params.symbol === "IDOL-USDT" && c.params.type === "LIMIT");
  assert.equal(entries.length, 1);
  // stop hit → booked as stop
  fake.setPrice("IDOL-USDT", 1.85);
  await ex.reconcileAll();
  const done = await trade(2);
  assert.equal(done.status, "closed");
  assert.equal(done.close_reason, "stop_loss");
  assert.match(sent.filter((m) => m.includes("Позиция закрыта")).pop()!, /Сработал стоп-лосс[\s\S]*Итог в минусе: −/);
  assert.ok(Number(done.pnl) < 0);
});

test("refusals: stale, price already beyond the stop, one position per symbol; follow_cab has no take; partial and full close", async () => {
  // Freshness counts from the source's message, not from the candle: an old candle time with a fresh release is taken…
  assert.equal(parseSignal({ sourceSignalId: "cab-signal-3", symbol: "BIRBUSDT", side: "buy", stopLoss: "91", signalAt: new Date(Date.now() - 3 * 3600_000).toISOString(), releasedAt: new Date(Date.now() - 2 * 60_000).toISOString() }, "cab", Date.now()).ok, true);
  assert.equal(parseSignal({ sourceSignalId: "cab-signal-3", symbol: "BIRBUSDT", side: "buy", stopLoss: "91", signalAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, "cab", Date.now()).ok, true);
  // …a message delivered more than 10 minutes after its release is not.
  assert.equal(parseSignal({ sourceSignalId: "cab-signal-3", symbol: "BIRBUSDT", side: "buy", stopLoss: "91", signalAt: new Date(Date.now() - 11 * 60_000).toISOString(), releasedAt: new Date(Date.now() - 11 * 60_000).toISOString() }, "cab", Date.now()).ok, false);
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(sig(4, "BIRBUSDT", 101, Date.now(), 102));
  assert.equal((await trade(4)).status, "skipped");
  assert.match(sent.at(-1)!, /цена уже за стопом/);

  strategy = resolveStrategy({ strategy: "follow_cab" });
  await ex.onSignal(sig(5, "BIRBUSDT", 95));
  const t5 = await trade(5);
  assert.equal(t5.status, "open");
  assert.equal(t5.take_price, null);
  assert.equal(newOrders("BIRB-USDT", "TAKE_PROFIT_MARKET").length, 0);
  await ex.onSignal(sig(6, "BIRBUSDT", 95));
  assert.equal((await trade(6)).status, "skipped");

  // Impulse-style core exit: 80% of the initial size, then the rest.
  const part = parseCommand({ commandId: "c5a", sourceSignalId: "cab-signal-5", symbol: "BIRBUSDT", type: "close", eventSeq: 1,
    eventAt: new Date().toISOString(), reason: "core_exit", closeFractionOfInitial: 0.8, partial: true }, Date.now());
  assert.ok(part.ok);
  await ex.onCommand(part.value);
  const after = await trade(5);
  assert.equal(after.status, "open");
  assert.ok(Math.abs(Number(after.qty) - Number(after.initial_qty) * 0.2) < 0.02, `${after.qty} of ${after.initial_qty}`);
  const stops = newOrders("BIRB-USDT", "STOP_MARKET");
  assert.equal(stops.length, 1);
  assert.ok(Math.abs(stops[0]!.origQty - Number(after.qty)) < 0.011, "stop resized to the rest");

  const full = parseCommand({ commandId: "c5b", sourceSignalId: "cab-signal-5", symbol: "BIRBUSDT", type: "close", eventSeq: 2,
    eventAt: new Date().toISOString(), reason: "trailing_stop" }, Date.now());
  assert.ok(full.ok);
  await ex.onCommand(full.value);
  const closed = await trade(5);
  assert.equal(closed.status, "closed");
  assert.equal(closed.close_reason, "source:trailing_stop");
  assert.match(sent.filter((m) => m.includes("Позиция закрыта")).pop()!, /CAB закрыл сделку по трейлинг-стопу — закрыта по рынку/);
  strategy = resolveStrategy({ strategy: "take5" });
});

test("source cancellation closes only the confirmed side and preserves opposite-side protection", async () => {
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(sig(63, "BIRBUSDT", 91));
  const short = parseSignal({
    sourceSignalId: "cab-signal-64", patternId: "liquidation_cascade", confirmationStatus: "confirmed",
    signalAt: new Date().toISOString(), symbol: "BIRBUSDT", side: "sell", orderType: "market", quantity: "1",
    referencePrice: "100", stopLoss: "109",
  }, "cab", Date.now());
  assert.ok(short.ok, JSON.stringify(short));
  await ex.onSignal(short.value);
  assert.equal((await trade(64)).status, "open");
  const marketOrdersBefore = fake.calls.filter((call) =>
    call.path === "/openApi/swap/v2/trade/order" && call.params.type === "MARKET",
  ).length;

  const cancel = parseCommand({
    commandId: "c63-cancel", sourceSignalId: "cab-signal-63", symbol: "BIRBUSDT", type: "cancel_entry",
    eventSeq: 1, eventAt: new Date().toISOString(), reason: "source_cancelled",
  }, Date.now());
  assert.ok(cancel.ok);
  fake.rateLimit("/openApi/swap/v2/trade/order", 1);
  await ex.onCommand(cancel.value);
  assert.equal((await trade(63)).status, "closed");
  assert.equal((await trade(64)).status, "open", "opposite-side position remains open");
  assert.equal(fake.calls.filter((call) =>
    call.path === "/openApi/swap/v2/trade/order" && call.params.type === "MARKET",
  ).length, marketOrdersBefore + 1);
  assert.equal(newOrders("BIRB-USDT", "STOP_MARKET").filter((order) => order.positionSide === "SHORT").length, 1);
  const cleanup = parseCommand({
    commandId: "c64-cleanup", sourceSignalId: "cab-signal-64", symbol: "BIRBUSDT", type: "close",
    eventSeq: 1, eventAt: new Date().toISOString(), reason: "test_cleanup",
  }, Date.now());
  assert.ok(cleanup.ok);
  await ex.onCommand(cleanup.value);
  assert.equal((await trade(64)).status, "closed");
});

test("cancelled position_review closes; reclassified review closes too (owner 2026-11-09: a neutral close in CAB closes the position)", async () => {
  fake.setPrice("ZZZ-USDT", 100);
  await ex.onSignal(sig(65, "ZZZUSDT", 91));
  const cancelled = parseCommand({
    commandId: "c65-review", sourceSignalId: "cab-signal-65", symbol: "ZZZUSDT", type: "position_review",
    eventSeq: 1, eventAt: new Date().toISOString(), reason: "source_cancelled", action: "review",
    sourceStatus: "cancelled", closePosition: false,
  }, Date.now());
  assert.ok(cancelled.ok);
  assert.equal(cancelled.value.trackerStatus, "cancelled");
  await ex.onCommand(cancelled.value);
  assert.equal((await trade(65)).status, "closed");
  assert.equal((await trade(65)).close_reason, "cancel:cancelled");

  fake.setPrice("YYY-USDT", 100);
  await ex.onSignal(sig(66, "YYYUSDT", 91));
  const reclassified = parseCommand({
    commandId: "c66-review", sourceSignalId: "cab-signal-66", symbol: "YYYUSDT", type: "position_review",
    eventSeq: 1, eventAt: new Date().toISOString(), reason: "reclassified", action: "review",
    trackerStatus: "reclassified",
  }, Date.now());
  assert.ok(reclassified.ok);
  await ex.onCommand(reclassified.value);
  assert.equal((await trade(66)).status, "closed");
  assert.equal((await trade(66)).close_reason, "cancel:reclassified");
});

test("repeated cancellation does not postpone a pending BingX close retry", async () => {
  fake.setPrice("AAA-USDT", 100);
  await ex.onSignal(sig(67, "AAAUSDT", 91));
  const opened = await trade(67);
  const marketOrdersBefore = fake.calls.filter((call) =>
    call.path === "/openApi/swap/v2/trade/order" && call.params.type === "MARKET",
  ).length;
  await pool.query(
    "UPDATE ex_trades SET status = 'closing', pending_close_reason = 'source:source_cancelled' WHERE id = $1",
    [opened.id],
  );
  const pending = await trade(67);
  assert.equal(pending.status, "closing");
  const retryAt = new Date(pending.updated_at).getTime();

  const repeated = parseCommand({
    commandId: "c67-cancel-1", sourceSignalId: "cab-signal-67", symbol: "AAAUSDT", type: "cancel_entry",
    eventSeq: 1, eventAt: new Date().toISOString(), reason: "source_cancelled",
  }, Date.now());
  assert.ok(repeated.ok);
  await ex.onCommand(repeated.value);
  assert.equal(new Date((await trade(67)).updated_at).getTime(), retryAt);
  assert.equal(fake.calls.filter((call) =>
    call.path === "/openApi/swap/v2/trade/order" && call.params.type === "MARKET",
  ).length, marketOrdersBefore, "no duplicate market order during the retry window");

  await pool.query("UPDATE ex_trades SET updated_at = now() - interval '61 seconds' WHERE id = $1", [opened.id]);
  await ex.reconcileAll();
  assert.equal((await trade(67)).status, "closed");
  assert.equal(fake.calls.filter((call) =>
    call.path === "/openApi/swap/v2/trade/order" && call.params.type === "MARKET",
  ).length, marketOrdersBefore + 1);
});

test("restart in the middle of an entry: the reconciler adopts the exchange position and protects it", async () => {
  fake.setPrice("BIRB-USDT", 100);
  // An order that reached the exchange, but the process died before booking it.
  await pool.query(`INSERT INTO ex_trades (account_id, source, source_signal_id, symbol, side, env, status, take_pct, signal_at, received_at, entry_sent_at, stop_price, client_order_id)
    VALUES ('owner-vst','cab','cab-signal-7','BIRBUSDT','long','vst','opening',5, now(), now(), now() - interval '1 minute', 92, 'exlost7')`);
  const bx = createBingX({ env: "vst", key: "k", secret: "s", host });
  await bx.placeOrder({ symbol: "BIRB-USDT", side: "BUY", positionSide: "LONG", type: "MARKET", quantity: "5", clientOrderId: "exlost7" }, "entry");
  await ex.reconcileAll();
  const t = await trade(7);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.equal(newOrders("BIRB-USDT", "STOP_MARKET").length, 1, "stop placed for the adopted position");
  assert.ok(fake.liq("BIRB-USDT", "LONG")! < 92);
  // clean up: close it
  const c = parseCommand({ commandId: "c7", sourceSignalId: "cab-signal-7", symbol: "BIRBUSDT", type: "close", eventSeq: 1, eventAt: new Date().toISOString(), reason: "x" }, Date.now());
  assert.ok(c.ok);
  await ex.onCommand(c.value);
  assert.equal((await trade(7)).status, "closed");
});

test("owner 2026-11-13 (VELVET): an order whose sending timed out is looked up for 10 minutes before the trade fails; an entry not sent yet is left alone 3 minutes", async () => {
  fake.setPrice("VELVET-USDT", 0.05);
  await pool.query(`INSERT INTO ex_trades (account_id, source, source_signal_id, symbol, side, env, status, take_pct, signal_at, received_at, entry_sent_at, stop_price, client_order_id)
    VALUES ('owner-vst','nihilist','nh-velvet-1','VELVETUSDT','short','vst','unknown',null, now(), now() - interval '4 minutes', now() - interval '3 minutes', 0.055, 'exvelvet1'),
           ('owner-vst','nihilist','nh-velvet-2','VELVETUSDT','short','vst','opening',null, now(), now() - interval '1 minute', null, 0.055, null)`);
  const st = async (id: string) => (await pool.query(`SELECT status FROM ex_trades WHERE source_signal_id = $1`, [id])).rows[0]?.status;
  await ex.reconcileAll();
  assert.equal(await st("nh-velvet-1"), "unknown", "3 minutes after the timed-out order: still looked up");
  assert.equal(await st("nh-velvet-2"), "opening", "entry still being prepared: left alone");
  await pool.query(`UPDATE ex_trades SET entry_sent_at = now() - interval '11 minutes' WHERE source_signal_id = 'nh-velvet-1'`);
  sent.length = 0;
  await ex.reconcileAll();
  assert.equal(await st("nh-velvet-1"), "failed", "no order and no position after 10 minutes");
  assert.match(sent.join("\n"), /ордер не дошёл до BingX/);
  await pool.query(`UPDATE ex_trades SET status = 'failed' WHERE source_signal_id = 'nh-velvet-2'`);
});

test("liquidation drifts to the stop while open (funding ate the margin): the reconciler adds margin and says so", async () => {
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(sig(41, "BIRBUSDT", 91));
  const t0 = await trade(41);
  assert.equal(t0.status, "open", JSON.stringify(t0));
  const before = Number(t0.margin_added);
  // Funding takes 6 USDT of the isolated margin: liquidation moves up past the 91 stop.
  fake.drainMargin("BIRB-USDT", "LONG", 6);
  assert.ok(fake.liq("BIRB-USDT", "LONG")! > 91 - 0.5, `liquidation ${fake.liq("BIRB-USDT", "LONG")} near/above the stop`);
  sent.length = 0;
  await ex.reconcileAll();
  const t1 = await trade(41);
  assert.equal(t1.status, "open");
  assert.ok(Number(t1.margin_added) > before, "margin added while open");
  assert.ok(fake.liq("BIRB-USDT", "LONG")! < 91, `liquidation ${fake.liq("BIRB-USDT", "LONG")} back beyond the stop`);
  assert.match(sent.join("\n"), /Ликвидация подошла к стопу/);
  // Nothing more to add on the next pass.
  sent.length = 0;
  await ex.reconcileAll();
  assert.equal(Number((await trade(41)).margin_added), Number(t1.margin_added));
  assert.doesNotMatch(sent.join("\n"), /Ликвидация подошла к стопу/);
  // Leave the fake exchange flat for the next tests: the +5% take fills.
  fake.setPrice("BIRB-USDT", 106);
  await ex.reconcileAll();
  assert.equal((await trade(41)).status, "closed");
  fake.setPrice("BIRB-USDT", 100);
});

test("top-up math: liquidation of a 10x long at −9.5% vs a 9% stop needs margin; a 5% stop needs none", () => {
  assert.equal(topUpAmount({ side: "long", qty: 10, stop: 95, liquidation: 90.5, entry: 100, minIncrease: 0.01, pricePrecision: 4 }), "0.00");
  assert.ok(Number(topUpAmount({ side: "long", qty: 10, stop: 91, liquidation: 90.8, entry: 100, minIncrease: 0.01, pricePrecision: 4 })) > 0);
  assert.ok(Number(topUpAmount({ side: "short", qty: 10, stop: 109, liquidation: 109.2, entry: 100, minIncrease: 0.01, pricePrecision: 4 })) > 0);
});

test("Nihilist short: entered with its own management (no take), stop above, liquidation kept above the stop; its commands apply", async () => {
  fake.setPrice("IDOL-USDT", 2);
  const p = parseSignal({ sourceSignalId: "nh-signal-9", source: "CryptoNihilist", rulesVersion: "nihilist-v1", confirmationStatus: "confirmed",
    symbol: "IDOLUSDT", side: "short", setup: "4h_30m_short", signalAt: new Date().toISOString(), entryPrice: "2", stopLoss: "2.19" }, "nihilist", Date.now());
  assert.ok(p.ok, JSON.stringify(p));
  await ex.onSignal(p.value);
  const t = (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = 'nh-signal-9'")).rows[0];
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.equal(t.side, "short");
  assert.equal(t.take_price, null);
  assert.ok(fake.liq("IDOL-USDT", "SHORT")! > 2.19, `liq ${fake.liq("IDOL-USDT", "SHORT")}`);
  fake.setPrice("IDOL-USDT", 1.85);
  const mv = parseCommand({ commandId: "nh-9-1", sourceSignalId: "nh-signal-9", symbol: "IDOLUSDT", type: "move_stop", sequence: 1,
    occurredAt: new Date().toISOString(), reason: "breakeven", stopPrice: "2" }, Date.now());
  assert.ok(mv.ok);
  await ex.onCommand(mv.value);
  assert.equal(newOrders("IDOL-USDT", "STOP_MARKET")[0]!.stopPrice, 2);
  const cl = parseCommand({ commandId: "nh-9-2", sourceSignalId: "nh-signal-9", symbol: "IDOLUSDT", type: "close", sequence: 2,
    occurredAt: new Date().toISOString(), reason: "expired" }, Date.now());
  assert.ok(cl.ok);
  await ex.onCommand(cl.value);
  const done = (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = 'nh-signal-9'")).rows[0];
  assert.equal(done.status, "closed");
  assert.ok(Number(done.pnl) > 0, String(done.pnl));
});

test("Nihilist sync: a missed trailing move is applied to a short, a missed close closes it; nothing happens when the source does not answer", async () => {
  const { readSourceSync } = await import("./index");
  process.env.NIHILIST_TRADING_TOKEN = "t".repeat(40);
  process.env.NIHILIST_POSITION_SYNC_URL = "https://nihilist.example/api/trading/position-sync";
  fake.setPrice("IDOL-USDT", 2);
  const p = parseSignal({ sourceSignalId: "nh-signal-12", symbol: "IDOLUSDT", side: "short", signalAt: new Date().toISOString(), entryPrice: "2", stopLoss: "2.19" }, "nihilist", Date.now());
  assert.ok(p.ok);
  await ex.onSignal(p.value);
  fake.setPrice("IDOL-USDT", 1.6);
  let answer: any = { positions: [{ sourceSignalId: "nh-signal-12", sourceAction: "hold", sourceStopLossPrice: 1.7 }], nextAfterId: null };
  const urls: string[] = [];
  const fetchImpl = (async (u: URL, init: any) => {
    urls.push(String(u));
    assert.equal(init.headers["x-trading-token"], "t".repeat(40));
    if (answer === "down") return new Response("", { status: 503 });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  await ex.onSourceState(await readSourceSync("nihilist", 11, fetchImpl));
  assert.match(urls[0]!, /afterId=11/);
  assert.equal(newOrders("IDOL-USDT", "STOP_MARKET")[0]!.stopPrice, 1.7);
  answer = "down";
  await assert.rejects(readSourceSync("nihilist", 11, fetchImpl));
  assert.equal((await pool.query("SELECT status FROM ex_trades WHERE source_signal_id = 'nh-signal-12'")).rows[0].status, "open");
  answer = { positions: [{ sourceSignalId: "nh-signal-12", sourceAction: "review", sourceStatus: "cancelled", sourceStopLossPrice: 1.7 }], nextAfterId: null };
  const sourceStatus: Record<"cab" | "nihilist", SourceSyncStatus> = {
    cab: { at: null, ok: null, error: null },
    nihilist: { at: null, ok: null, error: null },
  };
  await syncSource(ex, "nihilist", {
    read: async (source, after) => readSourceSync(source, after, fetchImpl),
    status: sourceStatus,
  });
  assert.equal(sourceStatus.nihilist.ok, true);
  const done = (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = 'nh-signal-12'")).rows[0];
  assert.equal(done.status, "closed");
  assert.ok(Number(done.pnl) > 0);
});

const nhSignal = (id: number, symbol: string, side: "long" | "short", entry: number, stop: number, maxHoldHours = 168) => {
  const p = parseSignal({ sourceSignalId: `nh-signal-${id}`, symbol, side, signalAt: new Date().toISOString(), entryPrice: String(entry), stopLoss: String(stop),
    exitRules: { maxHoldHours } }, "nihilist", Date.now());
  assert.ok(p.ok, JSON.stringify(p));
  return p.value;
};
const nhTrade = async (id: number) => (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = $1", [`nh-signal-${id}`])).rows[0];
const nhCmd = (id: number, seq: number, type: "move_stop" | "close", extra: Record<string, unknown>) => {
  const c = parseCommand({ commandId: `nh-${id}-${seq}`, sourceSignalId: `nh-signal-${id}`, symbol: "BIRBUSDT", type, sequence: seq, occurredAt: new Date().toISOString(), ...extra }, Date.now());
  assert.ok(c.ok); return c.value;
};

test("Nihilist allocation and strategy come from its source settings", async () => {
  const { saveSourceSettings } = await import("./store");
  fake.setPrice("BIRB-USDT", 100);
  await saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "amount", allocationValue: 50, strategy: "source", subscribers: false });
  await ex.onSignal(nhSignal(32, "BIRBUSDT", "long", 100, 90));
  const t = await nhTrade(32);
  assert.equal(t.status, "open"); assert.equal(t.mgmt, "source");
  // 50 USDT margin at 10x (before any top-up): about 500 USDT of position.
  assert.ok(Math.abs(Number(t.initial_qty) * Number(t.entry_price) - 500) < 5, String(Number(t.initial_qty) * Number(t.entry_price)));
  await ex.onCommand(nhCmd(32, 1, "close", { reason: "expired" }));
  await pool.query("DELETE FROM ex_source_settings");
});

test("Nihilist «Полный фикс на +5%»: take on the exchange, Nihilist's stop moves ignored, closed by the take and named so", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "percent", allocationValue: 1, strategy: "take5", subscribers: false });
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(nhSignal(41, "BIRBUSDT", "long", 100, 91));
  let t = await nhTrade(41);
  assert.equal(t.status, "open"); assert.equal(Number(t.take_pct), 5);
  await ex.onCommand(nhCmd(41, 1, "move_stop", { reason: "breakeven", stopPrice: "99" }));
  assert.equal(Number((await nhTrade(41)).stop_price), 91, "Nihilist's move is not followed");
  fake.setPrice("BIRB-USDT", 106);
  await ex.reconcileAll();
  t = await nhTrade(41);
  assert.equal(t.status, "closed", JSON.stringify(t));
  assert.equal(t.close_reason, "take");
  assert.match(sent.filter((m) => m.includes("Позиция закрыта")).pop()!, /Тейк \+5% исполнен — прибыль зафиксирована/);
  await pool.query("DELETE FROM ex_source_settings");
});

test("Nihilist «Полный фикс на +15%»: take on the exchange, holding time closes it", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "percent", allocationValue: 1, strategy: "take15", subscribers: false });
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(nhSignal(51, "BIRBUSDT", "long", 100, 91, 0.0001));
  let t = await nhTrade(51);
  assert.equal(t.status, "open"); assert.equal(Number(t.take_pct), 15);
  assert.equal(newOrders("BIRB-USDT", "TAKE_PROFIT_MARKET").length, 1);
  await new Promise((r) => setTimeout(r, 400));
  await ex.reconcileAll();
  t = await nhTrade(51);
  assert.equal(t.status, "closed"); assert.equal(t.close_reason, "timeout");
  await pool.query("DELETE FROM ex_source_settings");
});

test("Bitcoin: 50x by default for CAB and Nihilist, own size and leverage per source, can be switched off", async () => {
  const { saveBtcSettings } = await import("./store");
  fake.setPrice("BTC-USDT", 60000);
  await ex.onSignal(sig(61, "BTCUSDT", 58200, Date.now(), 60000));
  const t = await trade(61);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.equal(t.leverage, 50);
  const lev = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/trade/leverage") && c.params.symbol === "BTC-USDT").map((c) => Number(c.params.leverage));
  assert.ok(lev.length && lev.every((x) => x === 50), JSON.stringify(lev));
  // 1% of 10,000 = 100 margin × 50 = about 5,000 of position.
  assert.ok(Math.abs(Number(t.initial_qty) * Number(t.entry_price) - 5000) < 5000 * 0.05, String(Number(t.initial_qty) * Number(t.entry_price)));
  assert.ok(Number(t.margin_added) > 0, "50x: liquidation at about −2% is before a 3% stop, so margin was added");
  assert.ok(fake.liq("BTC-USDT", "LONG")! < 58200, "liquidation kept below the stop by a top-up");
  await ex.onCommand((parseCommand({ commandId: "c61", sourceSignalId: "cab-signal-61", symbol: "BTCUSDT", type: "close", eventSeq: 1, eventAt: new Date().toISOString() }, Date.now()) as any).value);

  assert.ok((await saveBtcSettings("owner", { source: "nihilist", enabled: true, leverage: 20, allocationMode: "amount", allocationValue: 30 })).ok);
  await ex.onSignal(nhSignal(62, "BTCUSDT", "short", 60000, 61800));
  const n = await nhTrade(62);
  assert.equal(n.status, "open"); assert.equal(n.leverage, 20);
  assert.ok(Math.abs(Number(n.initial_qty) * Number(n.entry_price) - 600) < 600 * 0.11, String(Number(n.initial_qty) * Number(n.entry_price)));
  await ex.onCommand(nhCmd(62, 1, "close", { reason: "expired", symbol: "BTCUSDT" }));

  assert.ok((await saveBtcSettings("owner", { source: "cab", enabled: false, leverage: 50, allocationMode: "same" })).ok);
  await ex.onSignal(sig(63, "BTCUSDT", 58200, Date.now(), 60000));
  assert.equal((await trade(63)).reason, "btc_disabled");
  assert.equal((await saveBtcSettings("owner", { source: "cab", enabled: true, leverage: 200 })).ok, false);
  await pool.query("DELETE FROM ex_btc_settings");
});

test("CAB size comes from its own source settings", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "cab", enabled: true, allocationMode: "amount", allocationValue: 40, strategy: "source", subscribers: true });
  await ex.onSignal(sig(72, "BIRBUSDT", 91));
  const t = await trade(72);
  assert.equal(t.status, "open");
  assert.ok(Math.abs(Number(t.initial_qty) * Number(t.entry_price) - 400) < 10, String(Number(t.initial_qty) * Number(t.entry_price)));
  await pool.query("DELETE FROM ex_source_settings");
});

test("one-way account: switched to hedge mode before the first entry", async () => {
  fake.positions.length = 0; // BingX switches the mode only with no positions
  fake.setOneWay();
  for (const rt of ex.runtimes.values()) rt.hedge = false;
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(sig(81, "BIRBUSDT", 91));
  assert.equal(fake.isHedge(), true);
  assert.equal((await trade(81)).status, "open");
});

test("BingX position-value cap at 10x (101209): the size is cut to the cap instead of being rejected", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "amount", allocationValue: 1000, strategy: "source", subscribers: true });
  fake.setPrice("IDOL-USDT", 2);
  fake.setMaxPositionValue("IDOL-USDT", 5000);
  const p = parseSignal({ sourceSignalId: "nh-signal-91", symbol: "IDOLUSDT", side: "long", signalAt: new Date().toISOString(), entryPrice: "2", stopLoss: "1.8" }, "nihilist", Date.now());
  assert.ok(p.ok);
  // 1000 margin at 10x = 10000, above the 5000 cap.
  await ex.onSignal(p.value);
  const t = (await pool.query("SELECT * FROM ex_trades WHERE source_signal_id = 'nh-signal-91'")).rows[0];
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.ok(Number(t.initial_qty) * Number(t.entry_price) <= 5000 && Number(t.initial_qty) * Number(t.entry_price) > 4500, String(Number(t.initial_qty) * Number(t.entry_price)));
  assert.match(sent.filter((m) => m.includes("Открыт")).pop()!, /урезан до лимита биржи/);
  fake.setMaxPositionValue("IDOL-USDT", 1e12);
  await pool.query("DELETE FROM ex_source_settings");
});

test("a take the exchange refuses never hides the open message; the reconciler places it later. An open trade never announced is announced by the reconciler", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "percent", allocationValue: 1, strategy: "take10", subscribers: false });
  fake.setPrice("ZZZ-USDT", 100);
  fake.rejectTakes(1);
  await ex.onSignal(nhSignal(61, "ZZZUSDT", "long", 100, 91));
  let t = await nhTrade(61);
  assert.equal(t.status, "open");
  const mine = (m: string) => m.includes("Открыт лонг") && m.includes(`объём ${Number(t.qty)}`);
  const open = sent.filter(mine);
  assert.equal(open.length, 1);
  assert.match(open[0]!, /Тейк \+10% не выставлен: .*take refused/);
  await ex.reconcileAll();
  t = await nhTrade(61);
  assert.ok(Number(t.take_price) > 0, "placed on the next pass");
  assert.equal(sent.filter(mine).length, 1, "announced once");

  // Protection that broke off before the announcement: the reconciler finishes it and announces.
  await pool.query("DELETE FROM ex_events WHERE trade_id = $1 AND kind = 'opened'", [t.id]);
  sent.length = 0;
  await ex.reconcileAll();
  assert.equal(sent.filter(mine).length, 1);
  assert.match(sent.filter(mine)[0]!, /Тейк \d/);
  await ex.reconcileAll();
  assert.equal(sent.filter(mine).length, 1, "not again");
  await pool.query("DELETE FROM ex_source_settings");
});

test("BingX rate limit (100410) on open orders right after the fill: the request waits for the unblock time, the trade is protected and announced at once", async () => {
  await (await import("./store")).saveSourceSettings({ source: "nihilist", enabled: true, allocationMode: "percent", allocationValue: 1, strategy: "take10", subscribers: false });
  fake.setPrice("YYY-USDT", 100);
  fake.rateLimit("/openApi/swap/v2/trade/openOrders", 1);
  await ex.onSignal(nhSignal(71, "YYYUSDT", "long", 100, 91));
  const t = await nhTrade(71);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.ok(Number(t.take_price) > 0);
  const kinds = (await pool.query("SELECT kind FROM ex_events WHERE trade_id = $1", [t.id])).rows.map((r) => r.kind);
  assert.ok(kinds.includes("opened") && !kinds.includes("entry_error"), kinds.join(","));
  assert.equal(sent.filter((m) => m.includes("Открыт лонг") && m.includes("YYY")).length, 1);
});

test("a reconcile pass asks BingX for open orders once for all symbols (not once per trade)", async () => {
  fake.setPrice("AAA-USDT", 100); fake.setPrice("CCC-USDT", 100);
  await ex.onSignal(sig(181, "AAAUSDT", 91, Date.now(), 100));
  await ex.onSignal(sig(182, "CCCUSDT", 91, Date.now(), 100));
  assert.equal((await trade(181)).status, "open", JSON.stringify(await trade(181))); assert.equal((await trade(182)).status, "open");
  await new Promise((r) => setTimeout(r, 5_100)); // cache from the entries expires
  const before = fake.calls.length;
  await ex.reconcileAll();
  const asked = fake.calls.slice(before).filter((c) => c.path === "/openApi/swap/v2/trade/openOrders");
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.equal(asked[0]!.params.symbol, undefined);
});

test("source-sync failures and unsettled trades never report a match; three fresh clean passes confirm recovery once", async (t) => {
  const reconciliationFake = createFakeBingX({ equity: 10_000, prices: { "RECON-USDT": 100 } });
  const reconciliationHost = await reconciliationFake.start();
  t.after(async () => { await reconciliationFake.stop(); });
  let reconciliationNow = Date.now();
  const sourceStatus: Record<"cab" | "nihilist", SourceSyncStatus> = {
    cab: { at: null, ok: null, error: null },
    nihilist: { at: null, ok: null, error: null },
  };
  const reconciler = createExecutor({
    loadAccounts: async () => [account()],
    entryAllowed: async () => true,
    bingx: (a) => createBingX({ env: a.env, key: a.key, secret: a.secret, host: reconciliationHost }),
    send: async (text) => { sent.push(text); },
    sourceSyncStatus: (source) => sourceStatus[source as "cab" | "nihilist"],
    now: () => reconciliationNow,
  });
  const signalId = 20001;
  reconciliationFake.setPrice("RECON-USDT", 100);
  await reconciler.onSignal(sig(signalId, "RECONUSDT", 91));
  sent.length = 0;
  const hasMatchNotice = () => sent.some((text) => text.includes("Сверка подтверждена"));
  const reconcileWith = async (
    read: () => Promise<Array<{ sourceSignalId: string; action: string; stop: number | null }>>,
    expectedError: RegExp,
  ) => {
    await assert.rejects(
      syncSource(reconciler, "cab", {
        read: async () => read(),
        status: sourceStatus,
        now: () => reconciliationNow,
      }),
      expectedError,
    );
    assert.equal(sourceStatus.cab.ok, false);
    await reconciler.reconcileAll();
    assert.equal(hasMatchNotice(), false, "an unconfirmed source sync must not produce a match notice");
  };

  await reconcileWith(async () => { throw new Error("timeout"); }, /timeout/);
  await reconcileWith(
    async () => [{ sourceSignalId: `cab-signal-${signalId}`, action: "future_action", stop: null }],
    /unrecognized action/,
  );
  await reconcileWith(async () => [], /omitted 1 active signal/);

  sourceStatus.cab = { at: reconciliationNow, ok: true, error: null };
  let resolveRead!: (states: Array<{ sourceSignalId: string; action: string; stop: number | null }>) => void;
  let readStarted!: () => void;
  const sourceReadStarted = new Promise<void>((resolve) => { readStarted = resolve; });
  const inFlightSync = syncSource(reconciler, "cab", {
    read: async () => {
      readStarted();
      return new Promise((resolve) => { resolveRead = resolve; });
    },
    status: sourceStatus,
    now: () => reconciliationNow,
  });
  await sourceReadStarted;
  assert.equal(sourceStatus.cab.ok, false, "a new source poll immediately invalidates the prior successful snapshot");
  await reconciler.reconcileAll();
  assert.equal(hasMatchNotice(), false, "a match notice is blocked while the source poll is in flight");
  resolveRead([{ sourceSignalId: `cab-signal-${signalId}`, action: "active", stop: null }]);
  await inFlightSync;

  await pool.query("UPDATE ex_trades SET status = 'closing' WHERE source_signal_id = $1", [`cab-signal-${signalId}`]);
  await syncSource(reconciler, "cab", {
    read: async () => [{ sourceSignalId: `cab-signal-${signalId}`, action: "active", stop: null }],
    status: sourceStatus,
    now: () => reconciliationNow,
  });
  await reconciler.reconcileAll();
  assert.equal(hasMatchNotice(), false, "a trade still in closing must not produce a match notice");

  await pool.query("UPDATE ex_trades SET status = 'open' WHERE source_signal_id = $1", [`cab-signal-${signalId}`]);
  for (let pass = 0; pass < 3; pass++) {
    reconciliationNow += 15_001;
    await syncSource(reconciler, "cab", {
      read: async () => [{ sourceSignalId: `cab-signal-${signalId}`, action: "active", stop: null }],
      status: sourceStatus,
      now: () => reconciliationNow,
    });
    await reconciler.reconcileAll();
    assert.equal(sent.filter((text) => text.includes("Сверка подтверждена")).length, pass === 2 ? 1 : 0);
  }
  await reconciler.reconcileAll();
  assert.equal(sent.filter((text) => text.includes("Сверка подтверждена")).length, 1, "a matched account is notified only once");

  reconciliationFake.setPrice("RECON-USDT", 90);
  await reconciler.reconcileAll();
});

test("an empty VST account cannot announce a match while another owner account has an unverified source", async (t) => {
  const reconciliationFake = createFakeBingX({ equity: 10_000, prices: {} });
  const reconciliationHost = await reconciliationFake.start();
  t.after(async () => { await reconciliationFake.stop(); });
  await pool.query(
    `INSERT INTO ex_trades
      (account_id, source, source_signal_id, symbol, side, pattern, env, status, signal_at, received_at, opened_at)
     VALUES ('owner-real', 'cab', 'cab-signal-20901', 'ANIMEUSDT', 'long', 'impulse_buy', 'real', 'open', now(), now(), now())`,
  );
  const sourceStatus: Record<"cab" | "nihilist", SourceSyncStatus> = {
    cab: { at: Date.now(), ok: false, error: "cancellation/reclassification requires review" },
    nihilist: { at: Date.now(), ok: true, error: null },
  };
  const notices: string[] = [];
  const reconciler = createExecutor({
    loadAccounts: async () => [account()],
    entryAllowed: async () => true,
    bingx: (a) => createBingX({ env: a.env, key: a.key, secret: a.secret, host: reconciliationHost }),
    send: async (text) => { notices.push(text); },
    sourceSyncStatus: (source) => sourceStatus[source as "cab" | "nihilist"],
  });
  await reconciler.reconcileAll();
  assert.equal(notices.some((text) => text.includes("Сверка подтверждена")), false);
});

test("a burst of signals asks BingX for open orders once (one shared request), and accounts on one key share the rate block", async () => {
  const a = createBingX({ env: "vst", key: "burst-key", secret: "s", host });
  const b = createBingX({ env: "real", key: "burst-key", secret: "s", host });
  // Five symbols asked at the same moment → one request for the whole account.
  const before = fake.calls.length;
  await Promise.all(["BIRBUSDT", "IDOLUSDT", "ZZZUSDT", "YYYUSDT", "AAAUSDT"].map((sym) => a.openOrders(sym, "protect")));
  const asked = fake.calls.slice(before).filter((c) => c.path === "/openApi/swap/v2/trade/openOrders");
  assert.equal(asked.length, 1, JSON.stringify(asked));
  // BingX blocks positions for ~300 ms after refusing account A: account B (same key) waits for the
  // unblock instead of firing into the block.
  fake.rateLimit("/openApi/swap/v2/user/positions", 1);
  const t0 = Date.now();
  const pa = a.positions(undefined, "protect");
  await new Promise((r) => setTimeout(r, 60));
  const tb = b.positions(undefined, "protect").then(() => Date.now() - t0);
  await pa;
  assert.ok((await tb) >= 250, `B waited for the shared block (${await tb} ms)`);
});

test("another number of zeros on BingX: CAB's 1000000MOG trades as BingX's MOG with the stop rescaled; later stop moves are rescaled too; a coin BingX does not list is skipped with the reason", async () => {
  fake.setPrice("MOG-USDT", 0.0000005); // source quotes 1 000 000 MOG at 0.5
  await ex.onSignal(sig(191, "1000000MOGUSDT", 0.45, Date.now(), 0.5));
  const t = await trade(191);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.equal(t.symbol, "MOGUSDT");
  assert.ok(Math.abs(Number(t.stop_price) - 0.00000045) < 1e-15, String(t.stop_price));
  const open = sent.filter((m) => m.includes("Открыт лонг") && m.includes("MOG")).pop()!;
  assert.match(open, /Сигнал по 1000000MOG, на BingX — MOG: цены пересчитаны/);
  // CAB raises its stop in its own units: the bot moves BingX's stop in BingX's units.
  await ex.onSourceState([{ sourceSignalId: "cab-signal-191", action: "hold", stop: 0.48 }]);
  assert.ok(Math.abs(Number((await trade(191)).stop_price) - 0.00000048) < 1e-15, String((await trade(191)).stop_price));

  await ex.onSignal(sig(192, "NOSUCHCOINUSDT", 0.9, Date.now(), 1));
  const n = await trade(192);
  assert.equal(n.status, "skipped"); assert.equal(n.reason, "no_contract");
});

test("a burst hits BingX's limit on positions several times in a row: the entry still finishes and is announced, no «прервалась»", async () => {
  fake.setPrice("AAA-USDT", 100);
  fake.rateLimit("/openApi/swap/v2/user/positions", 3);
  await ex.onSignal(sig(201, "AAAUSDT", 91, Date.now(), 100));
  const t = await trade(201);
  assert.equal(t.status, "open", JSON.stringify(t));
  assert.ok(!sent.some((m) => m.includes("прервалась")));
  assert.equal(sent.filter((m) => m.includes("Открыт лонг") && m.includes("AAA")).length, 1);
});

// ---------------- owner 2026-11-09: cancellations, lost commands, margin refused ----------------
const cancelCmd = (n: number, symbol: string, reason: string, seq = 1) => ({
  commandId: `cab-cmd-${n}-${seq}`, sourceSignalId: `cab-signal-${n}`, symbol, type: "cancel_entry", eventSeq: seq,
  eventAt: new Date().toISOString(), reason, source: "CryptoAltBullet",
});

test("CAB cancels an open signal: closed by market and booked as a cancellation, not as a close", async () => {
  fake.setPrice("CNA-USDT", 100);
  await ex.onSignal(sig(301, "CNAUSDT", 91, Date.now(), 100));
  assert.equal((await trade(301)).status, "open");
  const c = parseCommand(cancelCmd(301, "CNAUSDT", "abneon_gate_neutral_close_20261107"), Date.now());
  assert.ok(c.ok);
  await ex.onCommand(c.value);
  const t = await trade(301);
  assert.equal(t.status, "closed", JSON.stringify(t));
  assert.equal(t.close_reason, "cancel:abneon_gate_neutral_close_20261107");
  assert.equal(fake.positions.filter((p) => p.symbol === "CNA-USDT" && p.qty > 0).length, 0);
  assert.match(sent.at(-1)!, /Отмена: CAB переклассифицировал сигнал — позиция закрыта по рынку/);
});

test("a cancellation that came but was never applied (lost to an error) is applied from the inbox by the reconcile pass", async () => {
  fake.setPrice("CNB-USDT", 100);
  await ex.onSignal(sig(302, "CNBUSDT", 91, Date.now(), 100));
  assert.equal((await trade(302)).status, "open");
  // Stored by the intake, but the executor never applied it.
  await pool.query("INSERT INTO ex_inbox (kind, message_id, source_signal_id, body) VALUES ('command', $1, 'cab-signal-302', $2)",
    ["cmd:cab-cmd-302-1", JSON.stringify(cancelCmd(302, "CNBUSDT", "cancelled"))]);
  await ex.reconcileAll();
  const t = await trade(302);
  assert.equal(t.status, "closed", JSON.stringify(t));
  assert.equal(t.close_reason, "cancel:cancelled");
  assert.equal(t.last_command_seq, 1);
  const ev = await pool.query("SELECT 1 FROM ex_events WHERE trade_id = $1 AND kind = 'command_replayed'", [t.id]);
  assert.equal(ev.rowCount, 1);
  // A second pass does nothing more.
  await ex.reconcileAll();
  assert.equal((await pool.query("SELECT 1 FROM ex_events WHERE trade_id = $1 AND kind = 'command_replayed'", [t.id])).rowCount, 1);
});

test("position sync: a signal CAB reclassified (sent as «review») is closed as a cancellation found by the sync", async () => {
  fake.setPrice("CNC-USDT", 100);
  await ex.onSignal(sig(303, "CNCUSDT", 91, Date.now(), 100));
  assert.equal((await trade(303)).status, "open");
  await ex.onSourceState([{ sourceSignalId: "cab-signal-303", action: "review", stop: 91, status: "reclassified", cancelReason: "ib_price24h_below_15" }]);
  const t = await trade(303);
  assert.equal(t.status, "closed", JSON.stringify(t));
  assert.equal(t.close_reason, "cancel_sync:reclassified");
  assert.match(sent.at(-1)!, /Отмена: CAB уже переклассифицировал сигнал \(найдено при сверке\)/);
  // A signal still held by CAB is not touched.
  fake.setPrice("CND-USDT", 100);
  await ex.onSignal(sig(304, "CNDUSDT", 91, Date.now(), 100));
  await ex.onSourceState([{ sourceSignalId: "cab-signal-304", action: "hold", stop: 91, status: "active" }]);
  assert.equal((await trade(304)).status, "open");
});

test("the position opened but BingX refuses the margin top-up: the position is closed, not left with liquidation before the stop", async () => {
  fake.setPrice("MRG-USDT", 100);
  fake.rejectMargin(5);
  await ex.onSignal(sig(305, "MRGUSDT", 91, Date.now(), 100));
  const t = await trade(305);
  assert.equal(t.status, "closed", JSON.stringify(t));
  assert.equal(t.close_reason, "no_margin_for_stop");
  assert.ok(sent.some((m) => m.includes("BingX не принял доливку маржи")));
  assert.equal(fake.positions.filter((p) => p.symbol === "MRG-USDT" && p.qty > 0).length, 0);
  fake.rejectMargin(0);
});

test("position_review: cancelled / reclassified closes as a cancellation; a plain review only observes", async () => {
  fake.setPrice("PRV-USDT", 100); fake.setPrice("PRW-USDT", 100);
  await ex.onSignal(sig(311, "PRVUSDT", 91, Date.now(), 100));
  await ex.onSignal(sig(312, "PRWUSDT", 91, Date.now(), 100));
  const review = (n: number, symbol: string, trackerStatus: string) => parseCommand({ commandId: `rv-${n}`, sourceSignalId: `cab-signal-${n}`, symbol,
    type: "position_review", eventSeq: 1, eventAt: new Date().toISOString(), reason: "review", trackerStatus }, Date.now());
  const a = review(311, "PRVUSDT", "reclassified"); assert.ok(a.ok); await ex.onCommand(a.value);
  const b = review(312, "PRWUSDT", "active"); assert.ok(b.ok); await ex.onCommand(b.value);
  assert.equal((await trade(311)).close_reason, "cancel:reclassified");
  assert.equal((await trade(312)).status, "open");
});
