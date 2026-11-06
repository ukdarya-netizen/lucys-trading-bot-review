import { useMemo, useState } from "react";
import { PERIODS, inPeriod, summarize, type PeriodId } from "@/lib/performance";
import { BotFilterTabs, duration, formatPercent, formatUsdt, Kpi, px, toneClass, TradeTitle, useSubTrades, when, type BotFilter } from "./shared";

/** Owner 2026-11-06: the subscriber's closed trades — entry, exit, result, why it closed. */
export default function SubHistory() {
  const q = useSubTrades("closed");
  const [bot, setBot] = useState<BotFilter>("all");
  const [period, setPeriod] = useState<PeriodId>("30d");
  const rows = useMemo(() => {
    const all = (q.data?.trades ?? []).filter((t) => t.closedAt && (bot === "all" || t.source === bot));
    return inPeriod(all.map((t) => ({ ...t, closedAt: t.closedAt! })), period, Date.now());
  }, [q.data, bot, period]);
  const s = summarize(rows.map((t) => ({ id: String(t.id), symbol: t.symbol, patternId: t.pattern, closedAt: t.closedAt, pnlUsdt: t.pnl, roePercent: t.pnlPct })));
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-grid grid-cols-4 border border-border">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}
              className={`min-h-10 px-2 text-xs font-bold sm:px-3 ${period === p.id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{p.label}</button>
          ))}
        </div>
        <BotFilterTabs value={bot} onChange={setBot} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Результат" value={formatUsdt(s.counted ? s.netUsdt : null)} tone={s.counted ? s.netUsdt : null} />
        <Kpi label="В плюс" value={s.winRate === null ? "—" : `${Math.round(s.winRate)}%`} hint={`${s.wins} из ${s.wins + s.losses}`} />
        <Kpi label="Сделок" value={String(s.trades)} />
        <Kpi label="Средняя" value={formatUsdt(s.avgUsdt)} tone={s.avgUsdt} />
      </div>
      {q.isLoading && <div className="h-32 animate-pulse border border-border bg-card" />}
      {q.error && <p className="border border-destructive/40 p-4 text-sm text-destructive">Не удалось загрузить историю. Обновите страницу.</p>}
      {!q.isLoading && !q.error && rows.length === 0 && (
        <p className="border border-border bg-card p-6 text-center text-sm text-muted-foreground">За этот период закрытых сделок нет.</p>
      )}
      <ul className="space-y-2">
        {rows.map((t) => (
          <li key={t.id} className="border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <TradeTitle t={t} />
              <div className="text-right">
                <p className={`font-bold tabular ${toneClass(t.pnl)}`}>{formatUsdt(t.pnl)}</p>
                <p className={`text-xs tabular ${toneClass(t.pnlPct)}`}>{formatPercent(t.pnlPct, 2)}</p>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
              <p><span className="text-muted-foreground">Вход </span><span className="tabular">{px(t.entryPrice)}</span></p>
              <p><span className="text-muted-foreground">Выход </span><span className="tabular">{px(t.exitPrice)}</span></p>
              <p className="col-span-2 truncate"><span className="text-muted-foreground">Закрыта: </span>{t.closeText ?? "—"}</p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{when(t.openedAt)} → {when(t.closedAt)} · {duration(t.openedAt, t.closedAt)}{t.peakPct ? ` · лучший момент ${formatPercent(t.peakPct, 1)}` : ""}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
