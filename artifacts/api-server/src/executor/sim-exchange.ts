/**
 * Simulated BingX perpetual exchange (owner 2026-11-04: shared by the test fake and the PAPER
 * account): contracts, ticker, balance, hedge-mode isolated positions with a liquidation price,
 * LIMIT IOC / MARKET orders, attached and standalone STOP_MARKET / TAKE_PROFIT_MARKET triggers,
 * margin top-ups and order history. `setPrice` moves the market and fires triggers. Pure state,
 * no I/O; `snapshot` / `restore` keep it across restarts (PAPER).
 */
type Pos = { symbol: string; side: "LONG" | "SHORT"; qty: number; avg: number; margin: number; id: string };
type Ord = {
  orderId: string; clientOrderId: string | null; symbol: string; side: string; positionSide: "LONG" | "SHORT"; type: string;
  status: string; origQty: number; executedQty: number; avgPrice: number; stopPrice: number | null; time: number; updateTime: number;
};
export type SimSnapshot = {
  v: 1; seq: string; equity: number; dual: boolean; positions: Pos[]; orders: Ord[];
  leverage: Array<[string, number]>;
};

export function createSimExchange(opts: { equity?: number; prices?: Record<string, number> } = {}) {
  let seq = 1_000_000_000_000_000_000n;
  const nextId = () => String(++seq);
  const prices = new Map<string, number>(Object.entries(opts.prices ?? { "BIRB-USDT": 100 }));
  let equity = opts.equity ?? 10_000;
  const positions: Pos[] = [];
  const orders: Ord[] = [];
  const calls: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const MMR = 0.005;
  let dropNextOrderResponse = false;
  let rejectTakes = 0;
  const rateLimited = new Map<string, number>();
  let rejectMarginType = false;
  let dual = true;
  const maxVal = new Map<string, number>(); // symbol → max position value at the leverage (BingX 101209)
  const leverage = new Map<string, number>(); // "SYMBOL|SIDE" → leverage set by the client (default 10)
  const levOf = (symbol: string, side: string) => leverage.get(`${symbol}|${side}`) ?? 10;

  const liq = (p: Pos) => {
    const notional = p.qty * p.avg;
    const maint = notional * MMR;
    return p.side === "LONG" ? p.avg - (p.margin - maint) / p.qty : p.avg + (p.margin - maint) / p.qty;
  };
  const usedMargin = () => positions.reduce((s, p) => s + p.margin, 0);
  const pos = (symbol: string, side: "LONG" | "SHORT") => positions.find((p) => p.symbol === symbol && p.side === side);

  function fillClose(symbol: string, side: "LONG" | "SHORT", qty: number, price: number, type: string, ord?: Ord) {
    const p = pos(symbol, side);
    if (!p) return;
    const q = Math.min(qty, p.qty);
    const realized = (price - p.avg) * q * (side === "LONG" ? 1 : -1);
    equity += realized;
    p.margin -= p.margin * (q / p.qty);
    p.qty -= q;
    const now = Date.now();
    const o: Ord = ord ?? {
      orderId: nextId(), clientOrderId: null, symbol, side: side === "LONG" ? "SELL" : "BUY", positionSide: side, type,
      status: "FILLED", origQty: q, executedQty: 0, avgPrice: 0, stopPrice: null, time: now, updateTime: now,
    };
    o.status = "FILLED"; o.executedQty = q; o.avgPrice = price; o.updateTime = now;
    if (!ord) orders.push(o);
    if (p.qty <= 1e-12) {
      positions.splice(positions.indexOf(p), 1);
      for (const x of orders) if (x.symbol === symbol && x.positionSide === side && x.status === "NEW") x.status = "CANCELLED";
    }
  }

  function setPrice(symbol: string, price: number) {
    prices.set(symbol, price);
    for (const p of [...positions]) {
      if (p.symbol !== symbol) continue;
      const l = liq(p);
      if (p.side === "LONG" ? price <= l : price >= l) { fillClose(symbol, p.side, p.qty, l, "LIQUIDATION"); continue; }
      for (const o of orders.filter((x) => x.symbol === symbol && x.positionSide === p.side && x.status === "NEW")) {
        const hit = o.type === "STOP_MARKET" ? (p.side === "LONG" ? price <= o.stopPrice! : price >= o.stopPrice!)
          : o.type === "TAKE_PROFIT_MARKET" ? (p.side === "LONG" ? price >= o.stopPrice! : price <= o.stopPrice!) : false;
        if (hit && pos(symbol, p.side)) fillClose(symbol, p.side, o.origQty, o.stopPrice!, o.type, o);
      }
    }
  }

  const ok = (data: unknown) => ({ code: 0, msg: "", data });
  const err = (code: number, msg: string) => ({ code, msg });

  function handle(method: string, path: string, q: Record<string, string>): unknown {
    const left = rateLimited.get(path) ?? 0;
    if (left > 0) {
      rateLimited.set(path, left - 1);
      return err(100410, `code:100410:The endpoint trigger frequency limit rule is currently in the disabled period and will be unblocked after ${Date.now() + 300}`);
    }
    calls.push({ method, path, params: q });
    const sym = q.symbol;
    switch (`${method} ${path}`) {
      case "GET /openApi/swap/v2/quote/contracts":
        return ok([...prices.entries()].map(([s, p]) => ({ symbol: s, quantityPrecision: 2, pricePrecision: Math.max(4, Math.ceil(-Math.log10(p)) + 4), tradeMinQuantity: 0.01, tradeMinUSDT: 2, status: 1 })));
      case "GET /openApi/swap/v2/quote/ticker": {
        const p = prices.get(sym!)!;
        return ok({ symbol: sym, lastPrice: String(p), askPrice: String(p * 1.0005), bidPrice: String(p * 0.9995) });
      }
      case "GET /openApi/swap/v3/user/balance":
        return ok([{ asset: "VST", balance: String(equity), equity: String(equity), availableMargin: String(equity - usedMargin()) }]);
      case "GET /openApi/swap/v1/positionSide/dual":
        return ok({ dualSidePosition: dual });
      case "POST /openApi/swap/v1/positionSide/dual":
        if (positions.length) return err(80001, "position exists");
        dual = q.dualSidePosition === "true";
        return ok({ dualSidePosition: dual });
      case "POST /openApi/swap/v2/trade/marginType":
        return rejectMarginType ? err(80001, "no need to change") : ok({});
      case "GET /openApi/swap/v2/trade/marginType":
        return ok({ marginType: "ISOLATED" });
      case "GET /openApi/swap/v2/trade/leverage": {
        const cap = maxVal.get(sym!) ?? 1e12;
        return ok({ symbol: sym, longLeverage: levOf(sym!, "LONG"), shortLeverage: levOf(sym!, "SHORT"), maxPositionLongVal: cap, maxPositionShortVal: cap });
      }
      case "POST /openApi/swap/v2/trade/leverage":
        leverage.set(`${sym}|${q.side}`, Number(q.leverage));
        return ok({ leverage: Number(q.leverage) });
      case "GET /openApi/swap/v2/user/positions":
        return ok(positions.filter((p) => !sym || p.symbol === sym).map((p) => ({
          symbol: p.symbol, positionId: p.id, positionSide: p.side, isolated: true, positionAmt: String(p.qty), avgPrice: String(p.avg),
          liquidationPrice: liq(p), initialMargin: String(p.margin), minIncreaseMargin: "0.01", leverage: 10,
        })));
      case "POST /openApi/swap/v2/trade/positionMargin": {
        const p = pos(sym!, q.positionSide as "LONG" | "SHORT");
        if (!p) return err(101400, "no position");
        const a = Number(q.amount);
        if (a > equity - usedMargin()) return err(101204, "insufficient margin");
        p.margin += a;
        return ok({ amount: a });
      }
      case "POST /openApi/swap/v2/trade/order": {
        const side = q.positionSide as "LONG" | "SHORT";
        const now = Date.now();
        const o: Ord = {
          orderId: nextId(), clientOrderId: q.clientOrderId ?? null, symbol: sym!, side: q.side!, positionSide: side, type: q.type!,
          status: "NEW", origQty: Number(q.quantity), executedQty: 0, avgPrice: 0, stopPrice: q.stopPrice ? Number(q.stopPrice) : null, time: now, updateTime: now,
        };
        if (o.clientOrderId && orders.some((x) => x.clientOrderId === o.clientOrderId)) return err(80014, "duplicate clientOrderId");
        if ((q.type === "LIMIT" || q.type === "MARKET") && (q.side === "BUY") === (q.positionSide === "LONG")) {
          const cap = maxVal.get(sym!);
          const have = pos(sym!, q.positionSide as "LONG" | "SHORT");
          if (cap !== undefined && (Number(q.quantity) + (have?.qty ?? 0)) * prices.get(sym!)! > cap) return err(101209, `The maximum position value for this leverage is ${cap} USDT.`);
        }
        orders.push(o);
        const price = prices.get(sym!)!;
        const opening = (q.side === "BUY") === (side === "LONG");
        if (q.type === "LIMIT" || q.type === "MARKET") {
          const fillPx = q.side === "BUY" ? price * 1.0005 : price * 0.9995;
          if (q.type === "LIMIT" && (q.side === "BUY" ? fillPx > Number(q.price) : fillPx < Number(q.price))) {
            o.status = "CANCELLED";
          } else if (opening) {
            const qty = Number(q.quantity);
            const p = pos(sym!, side);
            const lev = levOf(sym!, side);
            if (p) { p.avg = (p.avg * p.qty + fillPx * qty) / (p.qty + qty); p.qty += qty; p.margin += (fillPx * qty) / lev; }
            else positions.push({ symbol: sym!, side, qty, avg: fillPx, margin: (fillPx * qty) / lev, id: nextId() });
            o.status = "FILLED"; o.executedQty = qty; o.avgPrice = fillPx;
            if (q.stopLoss) {
              const sl = JSON.parse(q.stopLoss);
              orders.push({ orderId: nextId(), clientOrderId: null, symbol: sym!, side: side === "LONG" ? "SELL" : "BUY", positionSide: side,
                type: "STOP_MARKET", status: "NEW", origQty: qty, executedQty: 0, avgPrice: 0, stopPrice: Number(sl.stopPrice), time: now, updateTime: now });
            }
          } else {
            fillClose(sym!, side, Number(q.quantity), fillPx, q.type, o);
          }
        } else if (q.type === "STOP_MARKET" || q.type === "TAKE_PROFIT_MARKET") {
          if (q.type === "TAKE_PROFIT_MARKET" && rejectTakes > 0) { rejectTakes -= 1; orders.pop(); return err(109400, "take refused (test)"); }
          const sp = Number(q.stopPrice);
          const bad = q.type === "STOP_MARKET" ? (side === "LONG" ? sp >= price : sp <= price) : (side === "LONG" ? sp <= price : sp >= price);
          if (bad) { orders.pop(); return err(101211, "trigger price would trigger immediately"); }
        }
        if (dropNextOrderResponse) { dropNextOrderResponse = false; return "DROP"; }
        return ok({ order: { ...o, clientOrderId: o.clientOrderId } });
      }
      case "GET /openApi/swap/v2/trade/order": {
        const o = orders.find((x) => (q.orderId && x.orderId === q.orderId) || (q.clientOrderId && x.clientOrderId === q.clientOrderId));
        return o ? ok({ order: o }) : err(80016, "order not exist");
      }
      case "GET /openApi/swap/v2/trade/openOrders":
        return ok({ orders: orders.filter((o) => (!sym || o.symbol === sym) && o.status === "NEW") });
      case "DELETE /openApi/swap/v2/trade/order": {
        const o = orders.find((x) => x.orderId === q.orderId);
        if (!o || o.status !== "NEW") return err(80018, "order not cancellable");
        o.status = "CANCELLED";
        return ok({});
      }
      case "GET /openApi/swap/v2/trade/allOrders":
        return ok({ orders: orders.filter((o) => o.symbol === sym && o.updateTime >= Number(q.startTime ?? 0)) });
      default:
        return err(100400, `unknown ${method} ${path}`);
    }
  }

  /** State for storage: open positions, waiting orders and the last 500 finished ones. */
  function snapshot(): SimSnapshot {
    const waiting = orders.filter((o) => o.status === "NEW");
    const done = orders.filter((o) => o.status !== "NEW").slice(-500);
    return { v: 1, seq: seq.toString(), equity, dual, positions: positions.map((p) => ({ ...p })), orders: [...done, ...waiting].map((o) => ({ ...o })),
      leverage: [...leverage.entries()] };
  }
  function restore(s: SimSnapshot) {
    seq = BigInt(s.seq); equity = s.equity; dual = s.dual;
    positions.splice(0, positions.length, ...s.positions.map((p) => ({ ...p })));
    orders.splice(0, orders.length, ...s.orders.map((o) => ({ ...o })));
    leverage.clear(); for (const [k, v] of s.leverage) leverage.set(k, v);
  }

  return {
    handle, setPrice, positions, orders, calls, snapshot, restore,
    hasPrice: (symbol: string) => prices.has(symbol),
    dropNextOrderResponse: () => { dropNextOrderResponse = true; },
    rejectTakes: (n: number) => { rejectTakes = n; },
    rateLimit: (path: string, n: number) => { rateLimited.set(path, n); },
    rejectMarginType: (v: boolean) => { rejectMarginType = v; },
    setOneWay: () => { dual = false; },
    setMaxPositionValue: (symbol: string, v: number) => { maxVal.set(symbol, v); },
    isHedge: () => dual,
    liq: (symbol: string, side: "LONG" | "SHORT") => { const p = pos(symbol, side); return p ? liq(p) : null; },
    equity: () => equity,
  };
}

/** Body of a simulated answer as BingX sends it: ids as JSON numbers (the client must keep them exact). */
export const simText = (out: unknown) => JSON.stringify(out).replace(/"(orderId|positionId)":"(\d{16,})"/g, '"$1":$2');
