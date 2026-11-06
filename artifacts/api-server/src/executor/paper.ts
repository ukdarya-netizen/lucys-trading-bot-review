/**
 * PAPER account (owner 2026-11-04): the same executor and strategies, but orders go to a
 * simulated exchange instead of BingX. Prices are BingX's real ones (public market data, no key):
 * before every request the symbols it touches get their live price, so entries fill at the
 * market and stops / takes / liquidations fire when the price crosses them (checked on each
 * request, at least every 20 s by the reconcile pass). The state (balance, positions, orders)
 * is kept in ex_paper_state, so it survives restarts and publishing.
 */
import { pool } from "@workspace/db";
import { HOSTS, type Fetch } from "./bingx";
import { createSimExchange, simText, type SimSnapshot } from "./sim-exchange";

/** Starting balance of a new PAPER account. */
export const PAPER_START_EQUITY = 10_000;
const PRICE_TTL_MS = 3_000;
const CONTRACTS_TTL_MS = 10 * 60_000;

type Store = { load: () => Promise<SimSnapshot | null>; save: (s: SimSnapshot) => Promise<void> };

export const dbPaperStore: Store = {
  async load() {
    const r = await pool.query<{ state: SimSnapshot }>("SELECT state FROM ex_paper_state WHERE id = 1");
    return r.rows[0]?.state ?? null;
  },
  async save(s) {
    await pool.query(
      `INSERT INTO ex_paper_state (id, state, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [JSON.stringify(s)]);
  },
};

/** A fetch for createBingX: private calls answered by the simulated exchange, prices from BingX. */
export function createPaperFetch(opts: { store?: Store; realFetch?: Fetch; startEquity?: number } = {}): Fetch {
  const store = opts.store ?? dbPaperStore;
  const real = opts.realFetch ?? fetch;
  const sim = createSimExchange({ equity: opts.startEquity ?? PAPER_START_EQUITY, prices: {} });
  let lastSaved = "";
  let saving: Promise<void> = Promise.resolve();
  const ready = store.load().then((s) => { if (s) { sim.restore(s); lastSaved = JSON.stringify(sim.snapshot()); } });
  const priceAt = new Map<string, number>();
  let contracts: { at: number; text: string } | null = null;

  async function publicGet(path: string): Promise<any> {
    const res = await real(`${HOSTS.real}${path}`, { signal: AbortSignal.timeout(10_000) });
    return JSON.parse(await res.text());
  }
  async function refreshPrice(symbol: string): Promise<void> {
    if (Date.now() - (priceAt.get(symbol) ?? 0) < PRICE_TTL_MS && sim.hasPrice(symbol)) return;
    const body = await publicGet(`/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}`);
    const last = Number(body?.data?.lastPrice);
    if (body?.code !== 0 || !(last > 0)) throw new Error(`price of ${symbol}: ${body?.msg ?? "no price"}`);
    sim.setPrice(symbol, last);
    priceAt.set(symbol, Date.now());
  }
  const reply = (text: string) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    await ready;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(url.searchParams.entries());
    delete params.signature; delete params.timestamp; delete params.recvWindow;
    if (url.pathname === "/openApi/swap/v2/quote/contracts") {
      if (!contracts || Date.now() - contracts.at > CONTRACTS_TTL_MS) {
        const res = await real(`${HOSTS.real}${url.pathname}`, { signal: AbortSignal.timeout(15_000) });
        contracts = { at: Date.now(), text: await res.text() };
      }
      return reply(contracts.text);
    }
    try {
      const symbols = params.symbol ? [params.symbol] : [...new Set(sim.positions.map((p) => p.symbol))];
      for (const s of symbols) await refreshPrice(s);
    } catch (e) {
      return reply(JSON.stringify({ code: 100500, msg: `PAPER: ${e instanceof Error ? e.message : String(e)}` }));
    }
    const out = sim.handle(method, url.pathname, params);
    const now = JSON.stringify(sim.snapshot());
    if (now !== lastSaved) {
      lastSaved = now;
      saving = saving.catch(() => undefined).then(() => store.save(JSON.parse(now)));
      await saving;
    }
    return reply(simText(out));
  }) as Fetch;
}
