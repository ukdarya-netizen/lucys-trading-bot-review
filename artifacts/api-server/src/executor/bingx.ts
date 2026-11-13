/**
 * BingX USDT perpetual client for the executor (owner 2026-11-02: rewrite).
 * One client per account (key) and environment: "vst" (demo host) or "real".
 * Hedge mode: positionSide LONG / SHORT. Signing as BingX documents it: keys
 * sorted, values unencoded in the signed text, URL-encoded in the query.
 * Big order/position ids are kept as strings (JSON numbers lose precision).
 * Requests of one account start through its own small queue: entries first,
 * at most one request start every MIN_GAP_MS (answers are awaited in
 * parallel). Accounts never wait on each other.
 *
 * Rate limit (owner 2026-11-03: two signals at once → 100410 on openOrders, the
 * protection broke off): BingX names the moment an endpoint is unblocked; every
 * request to it waits until then, and the refused one is sent again until it passes
 * (blocks under 30 s each, up to 2 minutes in all, waiters spread at random). A refusal for rate is its own kind — never read as
 * «order not found» or «already cancelled». Open orders of a symbol are kept for
 * 5 s (cleared by any order placed or cancelled on it): stop and take checks in a
 * row ask BingX once, and a reconcile pass asks once for all symbols. Every open-orders question is
 * one request for the whole account, shared while in flight (a burst of signals = one request), and
 * the queue and endpoint blocks are shared by every account on the same key (owner 2026-11-07).
 */
import { createHmac } from "node:crypto";

export type Env = "vst" | "real";
export const HOSTS: Record<Env, string> = {
  vst: "https://open-api-vst.bingx.com",
  real: "https://open-api.bingx.com",
};
const MIN_GAP_MS = 120;
const TIMEOUT_MS = 8_000;
const CLOCK_SYNC_MAX_RTT_MS = 2_000;

export class BingXError extends Error {
  constructor(message: string, public code: number | null, public kind: "exchange" | "network" | "timeout" | "http" | "rate") {
    super(message);
  }
  /** The request may or may not have reached the exchange. */
  get ambiguous(): boolean { return this.kind === "network" || this.kind === "timeout"; }
}

export type Contract = { symbol: string; quantityPrecision: number; pricePrecision: number; minQty: number; minNotional: number };
export type Position = {
  symbol: string; positionId: string; positionSide: "LONG" | "SHORT"; qty: number; avgPrice: number;
  liquidationPrice: number | null; margin: number | null; minIncreaseMargin: number; leverage: number | null; isolated: boolean | null;
};
export type Order = {
  orderId: string; clientOrderId: string | null; symbol: string; side: string; positionSide: string; type: string;
  status: string; qty: number; executedQty: number; avgPrice: number; stopPrice: number | null; time: number; updateTime: number;
};
export type Priority = "entry" | "protect" | "normal";

/** BingX "BTC-USDT"; signals use "BTCUSDT". */
export const exSymbol = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"));

/**
 * Coins quoted per 1000 / 1 000 000 units (owner 2026-11-03: CAB sent 1000000MOG, BingX
 * has it with another number of zeros; LUNC too). Multiplier prefix of a base asset:
 * "1000000MOG" → 1e6 × MOG, "1MBABYDOGE" → 1e6, "MOG" → 1.
 */
const MULTS = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];
export function splitMultiplier(base: string): { mult: number; core: string } {
  const m = /^(10+)(?=[A-Z])/.exec(base);
  if (m && MULTS.includes(Number(m[1]))) return { mult: Number(m[1]), core: base.slice(m[1]!.length) };
  if (/^1M(?=[A-Z]{2})/.test(base)) return { mult: 1_000_000, core: base.slice(2) };
  return { mult: 1, core: base };
}
/** BingX's contract for a source symbol and the price factor (BingX price = source price × factor), or null. */
export function mapSymbol(symbol: string, listed: (exSym: string) => boolean): { symbol: string; factor: number } | null {
  const ex = exSymbol(symbol);
  if (listed(ex)) return { symbol, factor: 1 };
  const base = ex.replace(/-USDT$/, "");
  const { mult: srcMult, core } = splitMultiplier(base);
  const names = (m: number) => (m === 1 ? [core] : m === 1_000_000 ? [`${m}${core}`, `1M${core}`] : [`${m}${core}`]);
  // Nearest multiplier first (10× before 1000×), never the same symbol again.
  const order = [...MULTS].sort((a, b) => Math.abs(Math.log10(a / srcMult)) - Math.abs(Math.log10(b / srcMult)));
  for (const m of order) for (const n of names(m)) {
    if (`${n}-USDT` === ex || !listed(`${n}-USDT`)) continue;
    return { symbol: `${n}USDT`, factor: m / srcMult };
  }
  return null;
}
export const plainSymbol = (s: string) => s.replace("-", "");

const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Keeps 16+ digit integers (ids) exact. */
export function parseLossless(text: string): any {
  return JSON.parse(text.replace(/("(?:orderId|orderID|positionId|positionID|id)"\s*:\s*)(-?\d{16,})/g, '$1"$2"'));
}

export function decimalAt(value: number, precision: number, mode: "floor" | "ceil" | "round" = "round"): string {
  const f = 10 ** precision;
  const scaled = value * f;
  const r = mode === "floor" ? Math.floor(scaled + 1e-9) : mode === "ceil" ? Math.ceil(scaled - 1e-9) : Math.round(scaled);
  return (r / f).toFixed(precision);
}

function toOrder(o: any): Order {
  return {
    orderId: str(o.orderId ?? o.orderID), clientOrderId: o.clientOrderId ?? o.clientOrderID ?? null,
    symbol: str(o.symbol), side: str(o.side), positionSide: str(o.positionSide), type: str(o.type), status: str(o.status),
    qty: num(o.origQty ?? o.quantity), executedQty: num(o.executedQty), avgPrice: num(o.avgPrice),
    stopPrice: Number.isFinite(num(o.stopPrice)) && num(o.stopPrice) > 0 ? num(o.stopPrice) : null,
    time: num(o.time), updateTime: num(o.updateTime ?? o.time),
  };
}

export type Fetch = typeof fetch;

/**
 * One BingX key = one rate limit, however many accounts use it (owner 2026-11-07: the owner's VST and
 * REAL accounts share one key and each had its own queue — twice the requests, and one did not know
 * the other was blocked → 100410 on openOrders). The queue spacing and the endpoint blocks are kept per
 * key and shared by every client of that key. Paper (its own fetch) never shares.
 */
type Limiter = { queue: { prio: number; run: () => Promise<void> }[]; busy: boolean; lastAt: number; blockedUntil: Map<string, number> };
const limiters = new Map<string, Limiter>();
function limiterFor(key: string, shared: boolean): Limiter {
  const fresh = (): Limiter => ({ queue: [], busy: false, lastAt: 0, blockedUntil: new Map() });
  if (!shared) return fresh();
  let l = limiters.get(key);
  if (!l) { l = fresh(); limiters.set(key, l); }
  return l;
}

export function createBingX(opts: { env: Env; key: string; secret: string; fetchImpl?: Fetch; now?: () => number; host?: string }) {
  const host = opts.host ?? HOSTS[opts.env];
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const marginAsset = opts.env === "vst" ? "VST" : "USDT";
  const limiter = limiterFor(opts.key, !opts.fetchImpl);
  const canSyncClock = !opts.fetchImpl && !opts.host;
  let clockOffsetMs = 0;
  let clockSyncInFlight: Promise<void> | null = null;

  // ---- per-account queue: entries first ----
  const queue = limiter.queue;
  const prioOf: Record<Priority, number> = { entry: 0, protect: 1, normal: 2 };
  async function pump() {
    if (limiter.busy) return;
    limiter.busy = true;
    try {
      while (queue.length) {
        queue.sort((a, b) => a.prio - b.prio);
        const job = queue.shift()!;
        const wait = limiter.lastAt + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        limiter.lastAt = Date.now();
        // Start spacing only: a slow answer never holds the next request.
        void job.run();
      }
    } finally {
      limiter.busy = false;
    }
  }
  function schedule<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ prio: prioOf[priority], run: () => fn().then(resolve, reject) });
      void pump();
    });
  }

  async function raw(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | undefined>, signed: boolean): Promise<any> {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) values[k] = String(v);
    let url: string;
    const headers: Record<string, string> = {};
    if (signed) {
      values.timestamp = String(Math.round(now() + clockOffsetMs));
      values.recvWindow = "5000";
      const sorted = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const signingText = sorted.map(([k, v]) => `${k}=${v}`).join("&");
      const sig = createHmac("sha256", opts.secret).update(signingText).digest("hex");
      url = `${host}${path}?${new URLSearchParams(sorted).toString()}&signature=${sig}`;
      headers["X-BX-APIKEY"] = opts.key;
    } else {
      url = `${host}${path}?${new URLSearchParams(values).toString()}`;
    }
    health.requests += 1;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new BingXError(`${method} ${path}: ${timeout ? "timeout" : "network error"}`, null, timeout ? "timeout" : "network");
    }
    const text = await res.text().catch(() => "");
    let body: any;
    try { body = parseLossless(text); } catch {
      const diagnostic = path === "/openApi/swap/v2/quote/contracts"
        ? `; type=${(res.headers.get("content-type") ?? "unknown").replace(/[\r\n]/g, " ").slice(0, 40)}; chars=${text.length}; preview=${JSON.stringify(text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48))}`
        : "";
      throw new BingXError(`${method} ${path}: invalid JSON HTTP ${res.status}${diagnostic}`, null, res.status >= 500 ? "network" : "http");
    }
    if (body?.code !== 0) {
      const code = Number(body?.code ?? -1);
      const msg = String(body?.msg ?? "");
      if (code === 100410 || code === 100429 || code === 109429 || res.status === 429) {
        const until = Number(/(?:unblocked after|(?:can\s+)?retry after time:)\s*(\d{13})/i.exec(msg)?.[1]);
        const fallbackMs = code === 109429 ? 480_000 : 2_000;
        blockedUntil.set(path, Number.isFinite(until) && until > Date.now() ? until : Date.now() + fallbackMs);
        const hits = health.rateHits.get(path) ?? [];
        hits.push(Date.now());
        health.rateHits.set(path, hits.filter((t) => t > Date.now() - 3_600_000));
        throw new BingXError(`${method} ${path}: ${code} ${msg}`.trim(), code, "rate");
      }
      health.lastError = { at: Date.now(), message: `${method} ${path}: ${body?.code} ${msg}`.trim().slice(0, 200) };
      throw new BingXError(`${method} ${path}: ${body?.code} ${msg}`.trim(), code, "exchange");
    }
    return body.data;
  }
  async function syncClock(): Promise<void> {
    if (!canSyncClock) throw new BingXError("Server-time sync is unavailable for this custom client", 109400, "exchange");
    if (clockSyncInFlight) return clockSyncInFlight;
    const sync = (async () => {
      const sentAt = now();
      let res: Response;
      try {
        res = await doFetch(`${host}/openApi/swap/v2/server/time`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new BingXError(`GET /openApi/swap/v2/server/time: ${timeout ? "timeout" : "network error"}`, null, timeout ? "timeout" : "network");
      }
      const receivedAt = now();
      const roundTrip = receivedAt - sentAt;
      if (roundTrip < 0 || roundTrip > CLOCK_SYNC_MAX_RTT_MS) {
        throw new BingXError(`GET /openApi/swap/v2/server/time: round trip ${roundTrip}ms is too slow to sync safely`, null, "timeout");
      }
      const text = await res.text().catch(() => "");
      let body: any;
      try { body = parseLossless(text); } catch {
        throw new BingXError(`GET /openApi/swap/v2/server/time: HTTP ${res.status}`, null, res.status >= 500 ? "network" : "http");
      }
      const code = Number(body?.code ?? -1);
      const serverTime = Number(body?.data?.serverTime);
      if (!res.ok || code !== 0 || !Number.isFinite(serverTime) || serverTime <= 0) {
        const message = String(body?.msg ?? `HTTP ${res.status}`);
        throw new BingXError(`GET /openApi/swap/v2/server/time: ${code} ${message}`.trim(), Number.isFinite(code) ? code : null, res.status >= 500 ? "network" : "exchange");
      }
      clockOffsetMs = serverTime - (sentAt + receivedAt) / 2;
    })();
    clockSyncInFlight = sync;
    try {
      await sync;
    } finally {
      if (clockSyncInFlight === sync) clockSyncInFlight = null;
    }
  }
  const blockedUntil = limiter.blockedUntil;
  // For Bot Health: requests, rate-limit hits per endpoint (times of the last hour), last refusal.
  const health = { requests: 0, rateHits: new Map<string, number[]>(), lastError: null as { at: number; message: string } | null };
  function stats() {
    const hour = Date.now() - 3_600_000;
    const rate = [...health.rateHits].map(([path, ts]) => ({ path, lastHour: ts.filter((t) => t > hour).length, lastAt: ts.length ? ts[ts.length - 1]! : null }))
      .filter((r) => r.lastHour > 0);
    return { requests: health.requests, rate, lastError: health.lastError };
  }
  const RATE_RETRY_MAX_MS = 30_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const RATE_TOTAL_MS = 120_000;
  async function waitUnblocked(path: string, attempt = 0): Promise<void> {
    const until = blockedUntil.get(path) ?? 0;
    const ms = until - Date.now();
    // Spread the waiters (more on each retry) so they do not all fire in the same instant.
    if (ms > 0 && ms <= RATE_RETRY_MAX_MS) await sleep(ms + 250 + Math.floor(Math.random() * 400 * (attempt + 1)));
  }
  async function call(priority: Priority, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | undefined> = {}, signed = true): Promise<any> {
    // A burst of signals: many requests wait for the same unblock moment and may hit the limit
    // again together — retried until it passes (with a small random spread), up to RATE_TOTAL_MS.
    const started = Date.now();
    let timestampRetries = 0;
    for (let attempt = 0; ; attempt++) {
      await waitUnblocked(path, attempt);
      try {
        return await schedule(priority, () => {
          // Blocked while this request waited in the queue (another request on the key was refused):
          // never fire into a known block — wait for the unblock moment instead.
          if ((blockedUntil.get(path) ?? 0) > Date.now()) {
            return Promise.reject(new BingXError(`${method} ${path}: blocked (waiting for the unblock)`, 100410, "rate"));
          }
          return raw(method, path, params, signed);
        });
      } catch (e) {
        if (signed && canSyncClock && e instanceof BingXError && e.code === 109400 && timestampRetries === 0) {
          timestampRetries += 1;
          await syncClock();
          continue;
        }
        if (!(e instanceof BingXError && e.kind === "rate")) throw e;
        const ms = (blockedUntil.get(path) ?? 0) - Date.now();
        if (ms > RATE_RETRY_MAX_MS || Date.now() - started > RATE_TOTAL_MS || attempt >= 8) throw e;
      }
    }
  }

  // ---- public ----
  let contracts: Map<string, Contract> | null = null;
  let contractsAt = 0;
  async function contract(symbol: string, p: Priority = "normal"): Promise<Contract> {
    // A coin missing from a list older than a minute: reload once (a new listing is not «no such contract»).
    const stale = !contracts || now() - contractsAt > 3_600_000 || (!contracts.has(exSymbol(symbol)) && now() - contractsAt > 60_000);
    if (stale) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await call(p, "GET", "/openApi/swap/v2/quote/contracts", {}, false);
          if (!Array.isArray(data) || data.length === 0) {
            throw new BingXError("GET /openApi/swap/v2/quote/contracts: empty or invalid contract list", null, "network");
          }
          const m = new Map<string, Contract>();
          for (const r of data) {
            m.set(r.symbol, {
              symbol: r.symbol, quantityPrecision: Number(r.quantityPrecision), pricePrecision: Number(r.pricePrecision),
              minQty: num(r.tradeMinQuantity) || 0, minNotional: num(r.tradeMinUSDT) || 0,
            });
          }
          contracts = m; contractsAt = now();
          break;
        } catch (e) {
          if (attempt < 2) await sleep(1_000);
          else if (!contracts) throw e;
        }
      }
    }
    const c = contracts?.get(exSymbol(symbol));
    if (!c) throw new BingXError(`${symbol}: no such contract`, null, "exchange");
    return c;
  }
  /** The contract BingX lists for a source symbol (another number of zeros) and the price factor. */
  async function resolveSymbol(symbol: string, p: Priority = "normal"): Promise<{ symbol: string; factor: number } | null> {
    try { await contract(symbol, p); return { symbol, factor: 1 }; } catch (e) {
      if (!(e instanceof BingXError && e.kind === "exchange")) throw e;
    }
    return mapSymbol(symbol, (s) => contracts?.has(s) ?? false);
  }
  async function ticker(symbol: string, p: Priority = "normal"): Promise<{ last: number; ask: number; bid: number }> {
    const d = await call(p, "GET", "/openApi/swap/v2/quote/ticker", { symbol: exSymbol(symbol) }, false);
    const r = Array.isArray(d) ? d[0] : d;
    return { last: num(r?.lastPrice), ask: num(r?.askPrice) || num(r?.lastPrice), bid: num(r?.bidPrice) || num(r?.lastPrice) };
  }

  // ---- account ----
  async function balance(p: Priority = "normal"): Promise<{ equity: number; available: number }> {
    const d = await call(p, "GET", "/openApi/swap/v3/user/balance");
    const rows: any[] = Array.isArray(d) ? d : Array.isArray(d?.balance) ? d.balance : d?.balance ? [d.balance] : [d];
    const row = rows.find((r) => r?.asset === marginAsset) ?? rows.find((r) => r?.asset === "USDT") ?? rows[0];
    return { equity: num(row?.equity ?? row?.balance), available: num(row?.availableMargin) };
  }
  async function positions(symbol?: string, p: Priority = "normal"): Promise<Position[]> {
    const d = await call(p, "GET", "/openApi/swap/v2/user/positions", symbol ? { symbol: exSymbol(symbol) } : {});
    return (Array.isArray(d) ? d : []).filter((r) => Math.abs(num(r.positionAmt)) > 0).map((r) => ({
      symbol: str(r.symbol), positionId: str(r.positionId), positionSide: (str(r.positionSide) === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT",
      qty: Math.abs(num(r.positionAmt)), avgPrice: num(r.avgPrice),
      liquidationPrice: Number.isFinite(num(r.liquidationPrice)) && num(r.liquidationPrice) > 0 ? num(r.liquidationPrice) : null,
      margin: Number.isFinite(num(r.initialMargin ?? r.isolatedMargin)) ? num(r.initialMargin ?? r.isolatedMargin) : null,
      minIncreaseMargin: num(r.minIncreaseMargin) || 0,
      leverage: Number.isFinite(num(r.leverage)) ? num(r.leverage) : null,
      isolated: typeof r.isolated === "boolean" ? r.isolated : null,
    }));
  }
  /**
   * Hedge mode (LONG and SHORT apart) is required: every order names positionSide.
   * Switched on when the account is in one-way mode (BingX allows it only with no positions).
   */
  async function ensureHedgeMode(p: Priority = "normal"): Promise<boolean> {
    const d = await call(p, "GET", "/openApi/swap/v1/positionSide/dual");
    const dual = d?.dualSidePosition;
    if (dual === true || dual === "true") return true;
    await call(p, "POST", "/openApi/swap/v1/positionSide/dual", { dualSidePosition: "true" });
    const again = await call(p, "GET", "/openApi/swap/v1/positionSide/dual");
    return again?.dualSidePosition === true || again?.dualSidePosition === "true";
  }

  /**
   * BingX caps the POSITION VALUE per symbol at the current leverage (code 101209,
   * "the maximum position value for this leverage is X USDT") — often far below
   * what the margin would allow. Returns that cap for the side, or null if unknown.
   */
  async function maxPositionValue(symbol: string, side: "LONG" | "SHORT", p: Priority = "entry"): Promise<number | null> {
    const d = await call(p, "GET", "/openApi/swap/v2/trade/leverage", { symbol: exSymbol(symbol) });
    const row = Array.isArray(d) ? d[0] : d;
    const v = num(side === "LONG" ? row?.maxPositionLongVal : row?.maxPositionShortVal);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  async function ensureIsolated(symbol: string, side: "LONG" | "SHORT", leverage: number, p: Priority = "entry"): Promise<void> {
    const s = exSymbol(symbol);
    try { await call(p, "POST", "/openApi/swap/v2/trade/marginType", { symbol: s, marginType: "ISOLATED" }); } catch (e) {
      // "already isolated" answers with an error code: confirm by reading.
      const d = await call(p, "GET", "/openApi/swap/v2/trade/marginType", { symbol: s });
      if (str(d?.marginType).toUpperCase() !== "ISOLATED") throw e;
    }
    try { await call(p, "POST", "/openApi/swap/v2/trade/leverage", { symbol: s, side, leverage }); } catch (e) {
      const d = await call(p, "GET", "/openApi/swap/v2/trade/leverage", { symbol: s });
      const cur = side === "LONG" ? num(d?.longLeverage) : num(d?.shortLeverage);
      if (cur !== leverage) throw e;
    }
  }
  async function placeOrder(params: Record<string, string | number | undefined>, p: Priority): Promise<Order> {
    if (params.symbol) { openCache.delete(String(params.symbol)); changedAt.set(String(params.symbol), Date.now()); }
    const d = await call(p, "POST", "/openApi/swap/v2/trade/order", params);
    if (params.symbol) { openCache.delete(String(params.symbol)); changedAt.set(String(params.symbol), Date.now()); }
    return toOrder(d?.order ?? d);
  }
  async function queryOrder(symbol: string, by: { orderId?: string; clientOrderId?: string }, p: Priority = "normal"): Promise<Order | null> {
    try {
      const d = await call(p, "GET", "/openApi/swap/v2/trade/order", { symbol: exSymbol(symbol), ...by });
      const o = d?.order ?? d;
      return o && (o.orderId || o.orderID) ? toOrder(o) : null;
    } catch (e) {
      if (e instanceof BingXError && e.kind === "exchange") return null; // not found
      throw e;
    }
  }
  const openCache = new Map<string, { at: number; list: Order[]; ttl: number }>();
  /** When a symbol's orders last changed (an order placed / cancelled): an older snapshot is not used for it. */
  const changedAt = new Map<string, number>();
  const OPEN_CACHE_MS = 5_000;
  /** A reconcile pass (every 20 s) may take longer than 5 s with many positions: its snapshot lives 15 s. */
  const PREFETCH_CACHE_MS = 15_000;
  let inflightAll: { at: number; p: Promise<Order[]> } | null = null;
  /**
   * Owner 2026-11-07 (100410 on openOrders during a burst of signals): every open-orders question is
   * answered from ONE request for the whole account, shared by everyone who asks while it is in flight.
   * Ten signals at once = one request, not ten.
   */
  function fetchAllOpen(p: Priority): Promise<{ at: number; all: Order[] }> {
    if (inflightAll) { const f = inflightAll; return f.p.then((all) => ({ at: f.at, all })); }
    const at = Date.now();
    const req = call(p, "GET", "/openApi/swap/v2/trade/openOrders", {})
      .then((d) => (Array.isArray(d) ? d : d?.orders ?? []).map(toOrder) as Order[])
      .finally(() => { if (inflightAll?.p === req) inflightAll = null; });
    inflightAll = { at, p: req };
    return req.then((all) => ({ at, all }));
  }
  function cacheSnapshot(symbols: Iterable<string>, at: number, all: Order[], ttl: number) {
    for (const s of symbols) {
      if ((changedAt.get(s) ?? 0) >= at) continue; // changed after the snapshot was asked for
      openCache.set(s, { at, list: all.filter((o) => o.symbol === s), ttl });
    }
  }
  async function openOrders(symbol: string, p: Priority = "normal"): Promise<Order[]> {
    const key = exSymbol(symbol);
    for (let i = 0; i < 2; i++) {
      const hit = openCache.get(key);
      if (hit && Date.now() - hit.at < hit.ttl) return hit.list;
      const { at, all } = await fetchAllOpen(p);
      // Every symbol in the answer is cached (a burst of signals asks right after), plus this one.
      cacheSnapshot(new Set([key, ...all.map((o) => o.symbol)]), at, all, OPEN_CACHE_MS);
      if ((changedAt.get(key) ?? 0) < at) return all.filter((o) => o.symbol === key);
      // This symbol changed while the request was in flight: ask once more.
    }
    const d = await call(p, "GET", "/openApi/swap/v2/trade/openOrders", { symbol: key });
    const list = (Array.isArray(d) ? d : d?.orders ?? []).map(toOrder);
    openCache.set(key, { at: Date.now(), list, ttl: OPEN_CACHE_MS });
    return list;
  }
  /** One request for all open orders of the account (a reconcile pass): every symbol asked is cached, empty ones too. */
  async function prefetchOpenOrders(symbols: string[], p: Priority = "normal"): Promise<void> {
    const { at, all } = await fetchAllOpen(p);
    cacheSnapshot(new Set([...symbols.map(exSymbol), ...all.map((o) => o.symbol)]), at, all, PREFETCH_CACHE_MS);
  }
  async function cancelOrder(symbol: string, orderId: string, p: Priority = "protect"): Promise<void> {
    openCache.delete(exSymbol(symbol)); changedAt.set(exSymbol(symbol), Date.now());
    try { await call(p, "DELETE", "/openApi/swap/v2/trade/order", { symbol: exSymbol(symbol), orderId }); } catch (e) {
      // Already filled / cancelled: nothing to cancel.
      if (!(e instanceof BingXError && e.kind === "exchange")) throw e;
    } finally {
      openCache.delete(exSymbol(symbol)); changedAt.set(exSymbol(symbol), Date.now());
    }
  }
  async function history(symbol: string, sinceMs: number, p: Priority = "normal"): Promise<Order[]> {
    const d = await call(p, "GET", "/openApi/swap/v2/trade/allOrders", { symbol: exSymbol(symbol), startTime: sinceMs, endTime: now(), limit: 500 });
    const list = Array.isArray(d) ? d : d?.orders ?? [];
    return list.map(toOrder);
  }
  async function addMargin(symbol: string, side: "LONG" | "SHORT", amount: string, p: Priority = "protect"): Promise<void> {
    await call(p, "POST", "/openApi/swap/v2/trade/positionMargin", { symbol: exSymbol(symbol), amount, type: 1, positionSide: side });
  }

  return { env: opts.env, stats, contract, resolveSymbol, ticker, balance, positions, ensureHedgeMode, ensureIsolated, maxPositionValue, placeOrder, queryOrder, openOrders, prefetchOpenOrders, cancelOrder, history, addMargin };
}

export type BingX = ReturnType<typeof createBingX>;
