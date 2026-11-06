import { useState } from "react";
import { BotFilterTabs, coin, duration, formatPercent, formatUsdt, Kpi, px, toneClass, TradeTitle, useSubTrades, when, type BotFilter } from "./shared";

/** Owner 2026-11-06: the subscriber's open positions — price now, result now, which stop protects it. */
export default function SubPositions() {
  const q = useSubTrades("open");
  const [bot, setBot] = useState<BotFilter>("all");
  const rows = (q.data?.trades ?? []).filter((t) => bot === "all" || t.source === bot);
  const floating = rows.reduce((s, t) => s + (t.livePnl ?? 0), 0);
  const margin = rows.reduce((s, t) => s + (t.margin ?? 0), 0);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Цены обновляются раз в 15 секунд.</p>
        <BotFilterTabs value={bot} onChange={setBot} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Открыто" value={String(rows.length)} />
        <Kpi label="Сейчас" value={formatUsdt(rows.length ? floating : null)} tone={rows.length ? floating : null} hint="плавающий результат" />
        <Kpi label="В сделках" value={rows.length ? formatUsdt(margin).replace("+", "") : "—"} hint="маржа" />
      </div>
      {q.isLoading && <div className="h-32 animate-pulse border border-border bg-card" />}
      {q.error && <p className="border border-destructive/40 p-4 text-sm text-destructive">Не удалось загрузить позиции. Обновите страницу.</p>}
      {!q.isLoading && !q.error && rows.length === 0 && (
        <p className="border border-border bg-card p-6 text-center text-sm text-muted-foreground">Открытых позиций нет.</p>
      )}
      <ul className="space-y-2">
        {rows.map((t) => (
          <li key={t.id} className="border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <TradeTitle t={t} />
              <div className="text-right">
                <p className={`font-bold tabular ${toneClass(t.livePnl)}`}>{formatUsdt(t.livePnl)}</p>
                <p className={`text-xs tabular ${toneClass(t.livePricePct)}`}>{formatPercent(t.livePricePct, 2)}</p>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
              <p><span className="text-muted-foreground">Вход </span><span className="tabular">{px(t.entryPrice)}</span></p>
              <p><span className="text-muted-foreground">Сейчас </span><span className="tabular">{px(t.currentPrice)}</span></p>
              <p>
                <span className="text-muted-foreground">{t.stopLabel[0]!.toUpperCase() + t.stopLabel.slice(1)} </span>
                <span className="tabular">{px(t.stopPrice)}</span>
                {t.stopDistancePct !== null && <span className="text-muted-foreground"> · до него {formatPercent(t.stopDistancePct, 1, false)}</span>}
              </p>
              <p><span className="text-muted-foreground">Маржа </span><span className="tabular">{t.margin !== null ? `${formatUsdt(t.margin).replace("+", "")}` : "—"}{t.leverage ? ` · ${t.leverage}x` : ""}</span></p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Открыта {when(t.openedAt)} · {duration(t.openedAt, null)} назад{t.peakPct ? ` · лучший момент ${formatPercent(t.peakPct, 1)}` : ""}{t.status === "opening" ? " · открывается" : ""}{t.status === "closing" ? " · закрывается" : ""}{t.status === "unknown" ? " · бот проверяет на бирже, открылась ли позиция" : ""}</p>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">Монеты: {rows.map((t) => coin(t.symbol)).join(", ") || "—"}</p>
    </div>
  );
}
