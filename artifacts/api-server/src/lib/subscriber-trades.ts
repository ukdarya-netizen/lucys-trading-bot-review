/**
 * A subscriber's own trades for the subscriber pages (owner 2026-11-06): open positions with the live
 * price, and closed trades. Only the person's own accounts (sub-<id>-vst / sub-<id>-real); nothing of
 * the owner or of other subscribers. Keys and order ids are never returned.
 */
import { pool } from "@workspace/db";
import { closeReasonText } from "../executor/texts";

const PRICE_TTL_MS = 15_000;
const prices = new Map<string, { at: number; price: number | null }>();
const exSymbol = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"));

/** BingX public last price (no key), cached 15 s; null when BingX does not answer. */
async function lastPrice(symbol: string): Promise<number | null> {
  const sym = exSymbol(symbol);
  const hit = prices.get(sym);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  let price: number | null = null;
  try {
    const res = await fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(sym)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { code?: number; data?: { lastPrice?: string } };
    const p = Number(body?.data?.lastPrice);
    price = body?.code === 0 && p > 0 ? p : null;
  } catch {
    price = null;
  }
  prices.set(sym, { at: Date.now(), price });
  return price;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const STOP_LABEL: Record<string, string> = {
  initial: "стоп",
  breakeven: "Б/У",
  trailing: "трейлинг",
  source: "стоп по сигналу",
};

export type SubscriberTrade = {
  id: number;
  account: "vst" | "real";
  source: string;
  pattern: string | null;
  symbol: string;
  side: "long" | "short";
  status: string;
  openedAt: string | null;
  closedAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  stopPrice: number | null;
  stopKind: string;
  stopLabel: string;
  takePrice: number | null;
  qty: number | null;
  margin: number | null;
  leverage: number | null;
  peakPct: number | null;
  pnl: number | null;
  pnlPct: number | null;
  closeReason: string | null;
  closeText: string | null;
  currentPrice: number | null;
  livePnl: number | null;
  livePricePct: number | null;
  stopDistancePct: number | null;
};

export async function subscriberTrades(subscriberId: number, opts: { scope: "open" | "closed" | "all"; days: number }) {
  const accounts = [`sub-${subscriberId}-vst`, `sub-${subscriberId}-real`];
    // "unknown" = the entry order's fate is unclear (BingX error/timeout); shown with the open ones so a
  // possibly live position is never hidden from its owner.
  const OPEN = ["opening", "open", "closing", "unknown"]; // same open set as the executor (store.ts)
  const statuses = opts.scope === "open" ? OPEN : opts.scope === "closed" ? ["closed"] : [...OPEN, "closed"];
  const { rows } = await pool.query(
    `SELECT id, account_id, source, pattern, symbol, side, status, opened_at, closed_at, entry_price, exit_price,
            stop_price, stop_kind, take_price, qty, margin, leverage, peak_pct, pnl, pnl_pct, close_reason
       FROM ex_trades
      WHERE account_id = ANY($1::text[]) AND status = ANY($2::text[])
        AND (status <> 'closed' OR closed_at > now() - ($3::int * interval '1 day'))
      ORDER BY coalesce(closed_at, opened_at) DESC NULLS LAST
      LIMIT 2000`,
    [accounts, statuses, Math.max(1, Math.min(3650, opts.days))],
  );
  const open = rows.filter((r: any) => r.status !== "closed");
  const priceBySymbol = new Map<string, number | null>();
  await Promise.all([...new Set(open.map((r: any) => String(r.symbol)))].map(async (s) => priceBySymbol.set(s, await lastPrice(s))));
  const trades: SubscriberTrade[] = rows.map((r: any) => {
    const side = r.side === "short" ? "short" : "long";
    const entry = num(r.entry_price), stop = num(r.stop_price), qty = num(r.qty);
    const cur = r.status === "closed" ? null : priceBySymbol.get(String(r.symbol)) ?? null;
    const dir = side === "long" ? 1 : -1;
    const kind = String(r.stop_kind ?? "initial");
    return {
      id: Number(r.id),
      account: String(r.account_id).endsWith("-real") ? "real" : "vst",
      source: String(r.source),
      pattern: r.pattern ?? null,
      symbol: String(r.symbol),
      side,
      status: String(r.status),
      openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      entryPrice: entry,
      exitPrice: num(r.exit_price),
      stopPrice: stop,
      stopKind: kind,
      stopLabel: STOP_LABEL[kind] ?? "стоп",
      takePrice: num(r.take_price),
      qty,
      margin: num(r.margin),
      leverage: num(r.leverage),
      peakPct: num(r.peak_pct),
      pnl: num(r.pnl),
      pnlPct: num(r.pnl_pct),
      closeReason: r.close_reason ?? null,
      closeText: r.close_reason ? closeReasonText(r.close_reason, String(r.source)) : null,
      currentPrice: cur,
      livePnl: cur !== null && entry !== null && qty !== null ? dir * (cur - entry) * qty : null,
      livePricePct: cur !== null && entry ? dir * ((cur - entry) / entry) * 100 : null,
      stopDistancePct: cur !== null && stop ? dir * ((cur - stop) / cur) * 100 : null,
    };
  });
  return { trades };
}
