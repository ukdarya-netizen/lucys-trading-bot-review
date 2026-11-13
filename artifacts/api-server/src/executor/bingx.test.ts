import assert from "node:assert/strict";
import { test } from "node:test";
import { BingXError, createBingX, type Fetch } from "./bingx";

test("BingX 109429 honors retry-after and does not resend a blocked order", async () => {
  const calls: string[] = [];
  const retryAt = Date.now() + 480_000;
  const fetchImpl: Fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify({
      code: 109429,
      msg: `over 20 error code:109420 requests within 480000 ms for this api, can retry after time: ${retryAt}`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const exchange = createBingX({
    env: "real",
    key: "test-key",
    secret: "test-secret",
    host: "https://bingx.invalid",
    fetchImpl,
  });
  const params = { symbol: "ZBT-USDT", side: "SELL", positionSide: "LONG", type: "STOP_MARKET", stopPrice: 0.5 };

  await assert.rejects(
    exchange.placeOrder(params, "protect"),
    (error: unknown) => error instanceof BingXError && error.code === 109429 && error.kind === "rate",
  );
  await assert.rejects(
    exchange.placeOrder(params, "protect"),
    (error: unknown) => error instanceof BingXError && error.kind === "rate",
  );

  assert.equal(calls.length, 1, "the second attempt must be stopped locally until BingX's retry time");
  assert.deepEqual(calls, ["POST /openApi/swap/v2/trade/order"]);
  assert.equal(exchange.stats().rate[0]?.path, "/openApi/swap/v2/trade/order");
});

test("owner 2026-11-13: a read that timed out is asked again (twice); an order is never repeated", async () => {
  const calls: string[] = [];
  let tickerFails = 1;
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const fetchImpl: Fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/openApi/swap/v2/quote/ticker" && tickerFails-- > 0) throw timeout();
    if (path === "/openApi/swap/v2/trade/order") throw timeout();
    return new Response(JSON.stringify({ code: 0, data: { symbol: "USELESS-USDT", lastPrice: "0.5", askPrice: "0.51", bidPrice: "0.49" } }), { status: 200 });
  };
  const exchange = createBingX({ env: "real", key: "k2", secret: "s", host: "https://bingx.invalid", fetchImpl });
  const q = await exchange.ticker("USELESS-USDT", "entry");
  assert.equal(q.ask, 0.51);
  assert.deepEqual(calls.filter((c) => c.endsWith("/ticker")).length, 2, "one timeout, then the repeated read");
  await assert.rejects(exchange.placeOrder({ symbol: "USELESS-USDT", side: "SELL", positionSide: "SHORT", type: "LIMIT", quantity: 1, price: 0.5 }, "entry"),
    (e: unknown) => e instanceof BingXError && e.kind === "timeout");
  assert.equal(calls.filter((c) => c === "POST /openApi/swap/v2/trade/order").length, 1, "an order is sent once");
});
