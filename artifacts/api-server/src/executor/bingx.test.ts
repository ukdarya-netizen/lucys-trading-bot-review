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
