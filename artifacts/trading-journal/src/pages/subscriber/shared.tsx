/**
 * Subscriber pages (owner 2026-11-06): what an approved subscriber sees on desktop and in the Telegram
 * Mini App — overview, own positions, own history, cabinet. Own account only (/api/me/*).
 */
import { useQuery } from "@tanstack/react-query";
import { BotBrand, BOT_BRAND_NAMES, BOT_SOURCES, type BotSource } from "@/components/BotBrand";
import { api, type Subscription } from "@/lib/subscriber-api";
import { formatPercent, formatUsdt, patternName, toneClass } from "@/lib/performance";

export type SubTrade = {
  id: number; account: "vst" | "real"; source: string; pattern: string | null; symbol: string;
  side: "long" | "short"; status: string; openedAt: string | null; closedAt: string | null;
  entryPrice: number | null; exitPrice: number | null; stopPrice: number | null; stopKind: string; stopLabel: string;
  takePrice: number | null; qty: number | null; margin: number | null; leverage: number | null; peakPct: number | null;
  pnl: number | null; pnlPct: number | null; closeReason: string | null; closeText: string | null;
  currentPrice: number | null; livePnl: number | null; livePricePct: number | null; stopDistancePct: number | null;
};

export function useSubTrades(scope: "open" | "closed" | "all", days = 3650) {
  return useQuery({
    queryKey: ["me-trades", scope, days],
    queryFn: () => api<{ trades: SubTrade[] }>(`/me/trades?scope=${scope}&days=${days}`),
    refetchInterval: scope === "closed" ? 60_000 : 15_000,
  });
}

export function useSubscription() {
  return useQuery({
    queryKey: ["me-subscription"],
    queryFn: () => api<{ subscription: Subscription }>("/me/subscription"),
    refetchInterval: 15_000,
  });
}

export type BotFilter = "all" | BotSource;
export function BotFilterTabs({ value, onChange }: { value: BotFilter; onChange: (v: BotFilter) => void }) {
  return (
    <div className="inline-grid grid-cols-4 border border-border">
      {(["all", ...BOT_SOURCES] as const).map((id) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}
          aria-label={id === "all" ? "Все боты" : BOT_BRAND_NAMES[id]}
          className={`min-h-10 min-w-0 px-2 text-xs font-bold sm:px-3 ${value === id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
          {id === "all" ? "Все" : <BotBrand source={id} size="xs" />}
        </button>
      ))}
    </div>
  );
}

export const coin = (s: string) => s.replace(/-?USDT$/, "");
export const px = (v: number | null) => {
  if (v === null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(2) : a >= 1 ? v.toFixed(4) : Number(v.toPrecision(4)).toString();
};
export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" }) : "—";
export function duration(from: string | null, to: string | null) {
  if (!from) return "—";
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000), d = Math.floor(h / 24);
  return d >= 1 ? `${d} д ${h % 24} ч` : h >= 1 ? `${h} ч ${Math.floor((ms % 3_600_000) / 60_000)} мин` : `${Math.max(1, Math.floor(ms / 60_000))} мин`;
}
export function TradeTitle({ t }: { t: SubTrade }) {
  const src = (t.source === "nihilist" || t.source === "btc" ? t.source : "cab") as BotSource;
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 font-bold">
        {coin(t.symbol)}
        <span className={`text-xs ${t.side === "long" ? "text-success" : "text-destructive"}`}>{t.side === "long" ? "лонг" : "шорт"}</span>
        {t.account === "real" && <span className="border border-amber-400/40 px-1 text-[10px] text-amber-300">реальный</span>}
      </p>
      <p className="truncate text-xs text-muted-foreground">{BOT_BRAND_NAMES[src]}{t.pattern ? ` · ${patternName(t.pattern)}` : ""}</p>
    </div>
  );
}
export function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: number | null; hint?: string }) {
  return (
    <div className="border border-border bg-card p-3">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular ${tone === undefined ? "" : toneClass(tone)}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
export { formatPercent, formatUsdt, toneClass };
