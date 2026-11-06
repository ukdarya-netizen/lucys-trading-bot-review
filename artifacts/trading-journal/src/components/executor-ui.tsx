// Shared pieces of the trading pages (owner 2026-11-03: two signal sources, CAB and Nihilist).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatUsdt, toneClass } from "@/lib/performance";
import { api } from "@/lib/subscriber-api";
import type { BtcSettings } from "@/components/BtcCard";
import { InboxLine, type InboxInfo, type SourceSettingsValue } from "@/components/SourceSettings";
import { Link } from "wouter";
import { BotBrand, BOT_BRAND_NAMES } from "@/components/BotBrand";
import type { ExecutorTradingControlState } from "@workspace/api-client-react";

export type Trade = {
  id: number; accountId: string; source: string; sourceName: string; sourceSignalId: string; symbol: string; side: "long" | "short";
  pattern: string | null; env: string; status: string; statusText: string; reason: string | null; reasonText: string | null; takePct: number | null;
  mgmt: string | null; mgmtLabel: string | null; peakPct: number | null;
  signalAt: string | null; receivedAt: string | null; entrySentAt: string | null; openedAt: string | null; closedAt: string | null;
  entryDelaySec: number | null; qty: number | null; entryPrice: number | null; stopPrice: number | null; takePrice: number | null;
  liquidationPrice: number | null; margin: number | null; marginAdded: number; exitPrice: number | null; pnl: number | null; pnlPct: number | null;
  price: number | null; unrealized: number | null; unrealizedPct: number | null;
};
export type NhSettings = { source: string; enabled: boolean; allocationMode: "percent" | "amount"; allocationValue: number; strategy: string; subscribers: boolean };
export type Status = {
  enabled: boolean; asOf: string;
  tradingControls?: ExecutorTradingControlState[];
  inbox: Record<"cab" | "nihilist", InboxInfo>;
  telegram: { pending: number; oldestPendingAt: string | null; failed24h: number; lastError: string | null; lastErrorAt: string | null; lastSentAt: string | null } | null;
  cab: { settings: SourceSettingsValue };
  nihilist: { settings: NhSettings; strategies: Array<{ id: string; label: string }> };
  btc: { settings: BtcSettings[]; maxLeverage: number };
  accounts: Array<{ id: string; label: string; env: string; strategy: string; takePct: number | null; balance: { equity: number; available: number } | null }>;
  ownerAccount?: {
    id: string; label: string; env: string; tradingEnabled: boolean;
    balance: { equity: number; available: number } | null;
    balanceStatus: "available" | "unavailable"; balanceError: string | null; checkedAt: string;
  } | null;
  sync: Record<string, { at: string | null; ok: boolean | null; error: string | null }>;
  open: Trade[]; closed: Trade[]; skipped: Trade[];
  totals: Array<{ accountId: string; source: string; sourceName: string; side: "long" | "short"; closed: number; wins: number; losses: number; liquidations: number; pnl: number }>;
  skippedTotals: Array<{ source: string; sourceName: string; reason: string; reasonText: string; n: number }>;
};
type Events = { trade: Trade; events: Array<{ id: number; kind: string; detail: Record<string, unknown>; at: string }> };

export const ownerAccountOf = (d: Status) =>
  d.ownerAccount ?? d.accounts.find((account) => account.id === "owner-vst") ?? null;

export function OwnerAccountNotice({ d }: { d: Status }) {
  const account = d.ownerAccount;
  if (account === undefined) return null;
  if (account === null) {
    return <p role="status" className="border border-border bg-card p-3 text-sm text-muted-foreground">Основной счёт BingX не настроен: нужны BINGX_API_KEY и BINGX_API_SECRET.</p>;
  }
  return (
    <div role="status" data-testid="owner-account-status" className="space-y-1 border border-border bg-card p-3 text-sm">
      <p>{account.balanceStatus === "available" ? "BingX VST: баланс доступен." : "Ключи BingX сохранены; подключение не подтверждено."}</p>
      <p className={account.tradingEnabled && account.balanceStatus === "available" ? "text-success" : "text-amber-300"}>
        {account.tradingEnabled ? "Приём новых сигналов разрешён." : "Новые входы основного счёта остановлены или заблокированы."}
        {" "}<Link href="/journal/my-bot" className="underline">Управление — в «Мой кабинет»</Link>.
      </p>
      {account.balanceError && <p className="text-destructive">{account.balanceError}</p>}
    </div>
  );
}

export const dt = (v: string | null) =>
  v ? new Date(v).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const px = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : Number(v.toPrecision(6)).toString().replace(".", ","));
export const pc = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")}%`);
export const sideText = (s: string) => (s === "long" ? "Лонг" : "Шорт");
export const sideCls = (s: string) => (s === "long" ? "text-success" : "text-destructive");
const distPct = (from: number | null, to: number | null) => (from && to ? ((to - from) / from) * 100 : null);
export const duration = (a: string | null, b: string | null) => {
  if (!a) return "—";
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)} д ${h % 24} ч` : h ? `${h} ч ${m} м` : `${m} м`;
};

const EVENT_TEXT: Record<string, string> = {
  entry_filled: "Вход исполнен", opened: "Позиция открыта и защищена", adopted: "Позиция найдена на бирже и взята под контроль",
  entry_ambiguous: "Ответ биржи на вход потерян — ищу ордер", entry_error: "Ошибка входа — сверка с биржей",
  stop_placed: "Стоп поставлен", stop_moved: "Стоп перенесён", margin_added: "Маржа долита",
  close_sent: "Отправлено закрытие", command: "Команда источника", command_failed: "Команда источника не выполнена",
  closed: "Позиция закрыта", skipped: "Не открыта", failed: "Не открыта",
};


/** The executor's status (accounts, settings, trades, totals), every 15 s. */
export function useExecutor() {
  return useQuery({ queryKey: ["executor-status"], queryFn: () => api<Status>("/journal/executor"), refetchInterval: 15_000 });
}

export type SourceFilter = "all" | "cab" | "nihilist";
const SF_KEY = "trading-source-filter";
/** One source filter shared by Обзор, Позиции and История (remembered in this browser). */
export function useSourceFilter(): [SourceFilter, (v: SourceFilter) => void] {
  const [v, setV] = useState<SourceFilter>(() => {
    try { const x = localStorage.getItem(SF_KEY); return x === "cab" || x === "nihilist" ? x : "all"; } catch { return "all"; }
  });
  return [v, (x) => { setV(x); try { localStorage.setItem(SF_KEY, x); } catch { /* private mode */ } }];
}
export function SourceSwitch({ value, onChange }: { value: SourceFilter; onChange: (v: SourceFilter) => void }) {
  return (
    <div role="tablist" aria-label="Источник сигналов" className="inline-grid grid-cols-3 border border-border bg-card">
      {(["all", "cab", "nihilist"] as const).map((id) => (
        <button key={id} role="tab" type="button" aria-label={id === "all" ? "Оба бота" : BOT_BRAND_NAMES[id]} aria-selected={value === id} onClick={() => onChange(id)}
          className={`flex min-h-12 min-w-0 items-center justify-center px-1.5 text-xs font-bold sm:px-3 ${value === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
          {id === "all" ? "Оба бота" : <BotBrand source={id} size="xs" />}
        </button>
      ))}
    </div>
  );
}
export const bySource = <T extends { source: string }>(rows: T[], f: SourceFilter) => (f === "all" ? rows : rows.filter((r) => r.source === f));

export function LoadingOrError({ q }: { q: ReturnType<typeof useExecutor> }) {
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  return <p className="text-sm text-destructive">Не удалось загрузить данные торгового бота. {(q.error as Error | null)?.message ?? ""}</p>;
}

/** Telegram (owner 2026-11-03): shown only when messages wait over a minute or Telegram refused one. */
function TelegramWarning({ d }: { d: Status }) {
  const t = d.telegram;
  if (!t) return null;
  const waitS = t.oldestPendingAt ? (Date.now() - new Date(t.oldestPendingAt).getTime()) / 1000 : 0;
  const late = t.pending > 0 && waitS > 60;
  if (!late && !t.failed24h) return null;
  return (
    <p className="border border-amber-400/50 bg-amber-400/10 p-3 text-sm text-amber-200">
      Telegram: {late ? `в очереди ${t.pending} сообщ., старейшее ждёт ${Math.round(waitS / 60)} мин. — бот дошлёт их сам` : ""}
      {late && t.failed24h ? " · " : ""}{t.failed24h ? `не доставлено за сутки: ${t.failed24h}` : ""}
      {t.lastError ? <span className="block text-xs">Ответ Telegram: {t.lastError}</span> : null}
    </p>
  );
}

/** Each signal bot: do its signals arrive, and does the trading bot open them. */
export function SourcesStatus({ d }: { d: Status }) {
  return (
    <>
    <TelegramWarning d={d} />
    <div className="grid gap-3 sm:grid-cols-2">
      {(["cab", "nihilist"] as const).map((src) => {
        const name = BOT_BRAND_NAMES[src];
        const on = d[src].settings.enabled;
        return (
          <Link key={src} href="/journal/my-bot" className="block border border-border bg-card p-3 hover:border-primary/50">
            <p className="text-sm font-bold"><BotBrand source={src} size="sm" /></p>
            <p className="mt-1 text-xs">Сигналы: <InboxLine name={name} info={d.inbox?.[src]} /></p>
            <p className="text-xs">Сделки: <span className={on ? "text-success" : "text-destructive"}>{on ? "открываются" : "не открываются (выключено)"}</span></p>
          </Link>
        );
      })}
    </div>
    </>
  );
}

/** Closed results by source and side (longs and shorts apart). */
export function TotalsTable({ d, filter }: { d: Status; filter: SourceFilter }) {
  const rows = bySource(d.totals, filter);
  if (!rows.length) return <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-[10px] uppercase text-muted-foreground">
          <tr><th className="py-1 pr-3">Бот</th><th className="pr-3">Сторона</th><th className="pr-3">Сделок</th><th className="pr-3">В плюс</th><th className="pr-3">В минус</th><th className="pr-3">Доля плюсовых</th><th className="pr-3">Ликвидаций</th><th className="pr-3">Результат</th></tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.accountId}-${t.source}-${t.side}`} className="border-t border-border">
              <td className="py-1.5 pr-3 font-bold">{t.sourceName}</td>
              <td className={`pr-3 font-bold ${sideCls(t.side)}`}>{sideText(t.side)}</td>
              <td className="pr-3 tabular">{t.closed}</td><td className="pr-3 tabular text-success">{t.wins}</td><td className="pr-3 tabular text-destructive">{t.losses}</td>
              <td className="pr-3 tabular">{t.closed ? `${Math.round((t.wins / t.closed) * 100)}%` : "—"}</td>
              <td className={`pr-3 tabular ${t.liquidations ? "font-bold text-destructive" : ""}`}>{t.liquidations}</td>
              <td className={`pr-3 font-bold tabular ${toneClass(t.pnl)}`}>{formatUsdt(t.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TradeTable({ rows, kind, empty }: { rows: Trade[]; kind: "open" | "closed" | "skipped"; empty: string }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (!rows.length) return <p className="border border-border bg-card p-4 text-sm text-muted-foreground">{empty}</p>;
  const cols = kind === "open"
    ? ["", "Монета", "Источник", "Открыта", "В сделке", "Вход", "Цена", "Результат", "Стоп", "До стопа", "Тейк", "Ликвидация", "Маржа", "Статус"]
    : kind === "closed"
    ? ["", "Монета", "Источник", "Открыта", "Закрыта", "Длилась", "Вход", "Выход", "Ход цены", "Результат", "Причина"]
    : ["", "Монета", "Источник", "Сигнал получен", "Статус", "Причина"];
  return (
    <div className="overflow-x-auto border border-border bg-card">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-[10px] uppercase text-muted-foreground">
          <tr>{cols.map((c, i) => <th key={i} className="px-2 py-2">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const expanded = openId === t.id;
            const toStop = distPct(t.price, t.stopPrice);
            return (
              <FragmentRow key={t.id} expanded={expanded} colSpan={cols.length} tradeId={t.id}>
                <tr className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => setOpenId(expanded ? null : t.id)}>
                  <td className="px-2 py-2">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                  <td className="px-2"><b>{t.symbol.replace(/USDT$/, "")}</b> <span className={`text-xs font-bold ${sideCls(t.side)}`}>{sideText(t.side)}</span></td>
                  <td className="px-2 text-xs">{t.sourceName}{t.pattern ? <span className="block text-muted-foreground">{t.pattern}</span> : null}
                    {t.mgmtLabel ? <span className="block max-w-[220px] text-muted-foreground" title={t.mgmtLabel}>{t.mgmt === "source" ? `ведёт ${BOT_BRAND_NAMES.nihilist}` : t.mgmtLabel}</span> : null}</td>
                  {kind === "open" && <>
                    <td className="px-2 text-xs tabular">{dt(t.openedAt ?? t.receivedAt)}</td>
                    <td className="px-2 text-xs tabular">{duration(t.openedAt, null)}</td>
                    <td className="px-2 tabular">{px(t.entryPrice)}</td>
                    <td className="px-2 tabular">{px(t.price)}</td>
                    <td className={`px-2 font-bold tabular ${toneClass(t.unrealized)}`}>{formatUsdt(t.unrealized)}<span className="block text-xs font-normal">{pc(t.unrealizedPct)}</span></td>
                    <td className="px-2 tabular">{px(t.stopPrice)}</td>
                    <td className="px-2 text-xs tabular">{toStop === null ? "—" : `${Math.abs(toStop).toFixed(2).replace(".", ",")}%`}</td>
                    <td className="px-2 tabular">{t.takePrice ? <>{px(t.takePrice)}<span className="block text-xs text-muted-foreground">+{t.takePct}%</span></> : <span className="text-xs text-muted-foreground">нет (выход по источнику)</span>}</td>
                    <td className="px-2 tabular">{px(t.liquidationPrice)}</td>
                    <td className="px-2 tabular">{t.margin === null ? "—" : t.margin.toFixed(2).replace(".", ",")}{t.marginAdded > 0 && <span className="block text-xs text-muted-foreground">долито {t.marginAdded.toFixed(2).replace(".", ",")}</span>}</td>
                    <td className="px-2 text-xs">{t.statusText}</td>
                  </>}
                  {kind === "closed" && <>
                    <td className="px-2 text-xs tabular">{dt(t.openedAt)}</td>
                    <td className="px-2 text-xs tabular">{dt(t.closedAt)}</td>
                    <td className="px-2 text-xs tabular">{duration(t.openedAt, t.closedAt)}</td>
                    <td className="px-2 tabular">{px(t.entryPrice)}</td>
                    <td className="px-2 tabular">{px(t.exitPrice)}</td>
                    <td className={`px-2 tabular ${toneClass(t.pnlPct)}`}>{pc(t.pnlPct)}</td>
                    <td className={`px-2 font-bold tabular ${toneClass(t.pnl)}`}>{formatUsdt(t.pnl)}</td>
                    <td className={`px-2 text-xs ${t.reason === "liquidation" ? "font-bold text-destructive" : ""}`}>{t.reasonText ?? "—"}</td>
                  </>}
                  {kind === "skipped" && <>
                    <td className="px-2 text-xs tabular">{dt(t.receivedAt)}</td>
                    <td className="px-2 text-xs">{t.statusText}</td>
                    <td className="px-2 text-xs">{t.reasonText ?? "—"}</td>
                  </>}
                </tr>
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ children, expanded, colSpan, tradeId }: { children: React.ReactNode; expanded: boolean; colSpan: number; tradeId: number }) {
  return <>{children}{expanded && <tr><td colSpan={colSpan} className="bg-muted/30 px-4 py-3"><TradeEvents id={tradeId} /></td></tr>}</>;
}

function TradeEvents({ id }: { id: number }) {
  const q = useQuery({ queryKey: ["executor-trade", id], queryFn: () => api<Events>(`/journal/executor/trades/${id}`), refetchInterval: 15_000 });
  if (q.isLoading) return <p className="text-xs text-muted-foreground">Загрузка…</p>;
  if (!q.data) return <p className="text-xs text-destructive">Не удалось загрузить историю сделки.</p>;
  const t = q.data.trade;
  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Info label="Время сигнала у источника" value={dt(t.signalAt)} />
        <Info label="Сигнал получен" value={dt(t.receivedAt)} />
        <Info label="Ордер отправлен" value={t.entrySentAt ? `${dt(t.entrySentAt)} (через ${String(t.entryDelaySec).replace(".", ",")} с)` : "—"} />
        <Info label="Объём" value={px(t.qty)} />
        <Info label="Счёт" value={`${t.accountId} · ${t.env.toUpperCase()}`} />
        <Info label="ID сигнала" value={t.sourceSignalId} />
      </div>
      {q.data.events.length === 0 ? <p className="text-muted-foreground">Событий нет.</p> : (
        <ol className="space-y-1">
          {q.data.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 border-l-2 border-border pl-2">
              <span className="tabular text-muted-foreground">{dt(e.at)}</span>
              <span className="font-bold">{EVENT_TEXT[e.kind] ?? e.kind}</span>
              <span className="break-all text-muted-foreground">{Object.entries(e.detail ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ")}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase text-muted-foreground">{label}</p><p className="break-all">{value}</p></div>;
}
