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
import { parseCommand, parseSignal } from "./intake";
import { resolveStrategy, topUpAmount } from "./plan";
import { ensureExecutorTables } from "./store";

const fake = createFakeBingX({ equity: 10_000, prices: { "BIRB-USDT": 100, "IDOL-USDT": 2, "BTC-USDT": 60000, "ZZZ-USDT": 100, "YYY-USDT": 100, "AAA-USDT": 100, "CCC-USDT": 100, "MOG-USDT": 0.0000005 } });
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
  answer = { positions: [{ sourceSignalId: "nh-signal-12", sourceAction: "close", sourceStopLossPrice: 1.7 }], nextAfterId: null };
  await ex.onSourceState(await readSourceSync("nihilist", 11, fetchImpl));
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

test("Nihilist settings: off → not opened (no Telegram); own size in USDT; subscribers excluded by default", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "nihilist", enabled: false, allocationMode: "amount", allocationValue: 50, strategy: "source", subscribers: false });
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(nhSignal(31, "BIRBUSDT", "long", 100, 90));
  const off = await nhTrade(31);
  assert.equal(off.status, "skipped"); assert.equal(off.reason, "source_disabled");
  assert.equal(sent.length, 0);
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

test("CAB settings apart from Nihilist: CAB off → not opened; CAB size from its own settings", async () => {
  const { saveSourceSettings } = await import("./store");
  await saveSourceSettings({ source: "cab", enabled: false, allocationMode: "percent", allocationValue: 1, strategy: "source", subscribers: true });
  fake.setPrice("BIRB-USDT", 100);
  await ex.onSignal(sig(71, "BIRBUSDT", 91));
  assert.equal((await trade(71)).reason, "source_disabled");
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
