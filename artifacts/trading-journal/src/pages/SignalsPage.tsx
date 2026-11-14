// «Сигналы» (owner 2026-11-04): every signal CAB and Nihilist sent to the bot — what it was and what
// each account did with it: opened, closed with the result, not opened and why — or nothing, when
// there was no account to trade it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/subscriber-api";
import { BotBrand, BOT_BRAND_NAMES } from "@/components/BotBrand";
import { SourceSwitch, useSourceFilter, px, sideCls, sideText } from "@/components/executor-ui";
import { formatUsdt, toneClass } from "@/lib/performance";

type SignalRow = {
  sourceSignalId: string; source: "cab" | "nihilist" | "btc"; symbol: string; side: "long" | "short"; pattern: string | null;
  signalAt: string | null; receivedAt: string; entry: number | null; stop: number | null;
  trades: Array<{ id: number; accountId: string; status: string; reason: string | null; reasonText: string | null; pnl: number | null }>;
};
const STATUS: Record<string, string> = {
  opening: "открывается", open: "открыта", closing: "закрывается", closed: "закрыта", skipped: "не открыта", failed: "не открыта — ошибка", unknown: "проверяется",
};
const ACCOUNT = (id: string) => (id === "owner-paper" ? "PAPER" : id === "owner-vst" ? "VST" : id === "owner-real" ? "REAL" : id.startsWith("sub-") ? `подписчик ${id.split("-")[1]}` : id);
const when = (v: string | null) => (v ? new Date(v).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const DAYS: Array<[number, string]> = [[1, "сутки"], [3, "3 дня"], [7, "7 дней"]];

export default function SignalsPage() {
  const [days, setDays] = useState(3);
  const [filter, setFilter] = useSourceFilter();
  const q = useQuery({ queryKey: ["executor-signals", days], queryFn: () => api<{ signals: SignalRow[] }>(`/journal/executor/signals?days=${days}`), refetchInterval: 15_000 });
  const rows = (q.data?.signals ?? []).filter((s) => filter === "all" || s.source === filter);
  const traded = rows.filter((s) => s.trades.length).length;
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
        <div className="inline-grid grid-cols-3 border border-border">
          {DAYS.map(([n, label]) => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}
              className={`min-h-10 px-3 text-xs font-bold ${days === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{q.data ? `Сигналов: ${rows.length} · торговались: ${traded}` : q.error ? (q.error as Error).message : "Загрузка…"}</span>
      </div>
      <section className="border border-border bg-card">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{q.data ? "За этот период сигналов не было." : ""}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase">
                  {["Пришёл", "Бот", "Монета", "Сторона", "Вход", "Стоп", "Что сделал бот"].map((h) => <th key={h} className="px-3 py-2 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.sourceSignalId} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular text-muted-foreground">{when(s.receivedAt)}</td>
                    <td className="px-3 py-2"><BotBrand source={s.source} size="xs" />{s.pattern ? <span className="block text-xs text-muted-foreground">{s.pattern}</span> : null}</td>
                    <td className="px-3 py-2 font-bold">{s.symbol.replace(/USDT$/, "")}</td>
                    <td className={`px-3 py-2 ${sideCls(s.side)}`}>{sideText(s.side)}</td>
                    <td className="px-3 py-2 tabular">{px(s.entry)}</td>
                    <td className="px-3 py-2 tabular">{px(s.stop)}</td>
                    <td className="px-3 py-2">
                      {s.trades.length === 0
                        ? <span className="text-amber-200">не торговался — у бота не было счёта</span>
                        : s.trades.map((t) => (
                          <span key={t.id} className="block">
                            <span className="text-muted-foreground">{ACCOUNT(t.accountId)}: </span>
                            <span className={t.status === "skipped" || t.status === "failed" ? "text-destructive" : ""}>{STATUS[t.status] ?? t.status}</span>
                            {t.status === "closed" && t.pnl !== null && <span className={`tabular ${toneClass(t.pnl)}`}> {formatUsdt(t.pnl)}</span>}
                            {(t.status === "skipped" || t.status === "failed") && t.reasonText && <span className="text-muted-foreground"> — {t.reasonText}</span>}
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-muted-foreground">Каждый сигнал от {BOT_BRAND_NAMES.cab} и {BOT_BRAND_NAMES.nihilist}, и что с ним сделал каждый счёт. Обновляется каждые 15 с.</p>
    </div>
  );
}
