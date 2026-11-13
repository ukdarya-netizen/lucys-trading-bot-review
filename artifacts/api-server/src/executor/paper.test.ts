import assert from "node:assert/strict";
import { test } from "node:test";
import { createBingX, type Fetch } from "./bingx";
import { createPaperFetch } from "./paper";
import type { SimSnapshot } from "./sim-exchange";

/** BingX public market data, faked: one contract and a price we move. */
function market(start: number) {
  let price = start;
  const realFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/quote/contracts")
      ? { code: 0, data: [{ symbol: "BIRB-USDT", quantityPrecision: 2, pricePrecision: 4, tradeMinQuantity: 0.01, tradeMinUSDT: 2, status: 1 }] }
      : { code: 0, data: { symbol: "BIRB-USDT", lastPrice: String(price) } };
    return new Response(JSON.stringify(body));
  }) as Fetch;
  return { realFetch, set: (p: number) => { price = p; } };
}
function memStore() {
  let saved: SimSnapshot | null = null;
  return { store: { load: async () => saved, save: async (s: SimSnapshot) => { saved = s; } }, get: () => saved };
}
const client = (f: Fetch) => createBingX({ env: "vst", key: "paper", secret: "paper", host: "https://paper.local", fetchImpl: f });

test("PAPER: a market entry fills at the live price, the stop fires when the live price crosses it, state survives a restart", async () => {
  const m = market(100);
  const mem = memStore();
  const ex = client(createPaperFetch({ store: mem.store, realFetch: m.realFetch, startEquity: 1000 }));
  assert.equal((await ex.balance()).equity, 1000);
  await ex.contract("BIRB-USDT");
  await ex.placeOrder({ symbol: "BIRB-USDT", side: "BUY", positionSide: "LONG", type: "MARKET", quantity: 5, stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: 95, workingType: "MARK_PRICE" }) }, "entry");
  let pos = await ex.positions("BIRB-USDT");
  assert.equal(pos.length, 1);
  assert.ok(Math.abs(pos[0]!.avgPrice - 100.05) < 1e-9, String(pos[0]!.avgPrice));

  // Restart: a new paper exchange from the stored state still has the position.
  const again = client(createPaperFetch({ store: mem.store, realFetch: m.realFetch, startEquity: 1000 }));
  pos = await again.positions("BIRB-USDT");
  assert.equal(pos.length, 1);

  // The price falls through the stop: the next request closes the position at the stop.
  m.set(94);
  await new Promise((r) => setTimeout(r, 3_100)); // past the price cache
  pos = await again.positions("BIRB-USDT");
  assert.equal(pos.length, 0);
  const eq = (await again.balance()).equity;
  assert.ok(Math.abs(eq - (1000 + (95 - 100.05) * 5)) < 1e-6, String(eq));
  assert.ok(mem.get() !== null);
});
