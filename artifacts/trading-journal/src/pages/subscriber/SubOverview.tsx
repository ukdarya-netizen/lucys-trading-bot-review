import { useMemo, useState } from "react";
import { Link } from "wouter";
import { PERIODS, dailySeries, inPeriod, summarize, formatFactor, type PeriodId } from "@/lib/performance";
import { BOT_BRAND_NAMES, type BotSource } from "@/components/BotBrand";
import { positionSettingsText, runtimeText } from "@/lib/subscriber-api";
import { BotFilterTabs, coin, formatUsdt, Kpi, useSubscription, useSubTrades, type BotFilter } from "./shared";

/** Owner 2026-11-06: the subscriber's home — is my bot trading, what did it earn, what is open now. */
export default function SubOverview() {
  const sub = useSubscription();
  const closedQ = useSubTrades("closed");
  const openQ = useSubTrades("open");
  const [bot, setBot] = useState<BotFilter>("all");
  const [period, setPeriod] = useState<PeriodId>("30d");
  const closed = useMemo(() => {
    const all = (closedQ.data?.trades ?? []).filter((t) => t.closedAt && (bot === "all" || t.source === bot));
    return inPeriod(all.map((t) => ({ id: String(t.id), symbol: t.symbol, patternId: t.pattern, closedAt: t.closedAt!, pnlUsdt: t.pnl, roePercent: t.pnlPct })), period, Date.now());
  }, [closedQ.data, bot, period]);
  const s = summarize(closed);
  const days = dailySeries(closed).slice(-30);
  const maxAbs = Math.max(1e-9, ...days.map((d) => Math.abs(d.pnl)));
  const open = (openQ.data?.trades ?? []).filter((t) => bot === "all" || t.source === bot);
  const floating = open.reduce((x, t) => x + (t.livePnl ?? 0), 0);
  const subscription = sub.data?.subscription;
  const state = subscription ? runtimeText(subscription) : null;
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {subscription && state && (
        <section className={`border p-4 ${state.tone === "ok" ? "border-success/40" : state.tone === "bad" ? "border-destructive/50" : "border-border"} bg-card`}>
          <p className={`text-sm font-bold ${state.tone === "ok" ? "text-success" : state.tone === "bad" ? "text-destructive" : ""}`}>{state.text}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Счёт: {subscription.tradingAccount === "real" ? "реальный" : "демо (VST)"}
            {" · "}Боты: {subscription.tradeSources.length ? subscription.tradeSources.map((x) => BOT_BRAND_NAMES[x as BotSource] ?? x).join(", ") : "не выбраны"}
            {" · "}{positionSettingsText(subscription.positionSettings, subscription.tradingAccount)}
            {subscription.subscribedUntil ? ` · подписка до ${new Date(subscription.subscribedUntil).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Samara" })}` : ""}
          </p>
          <Link href="/journal/my-bot" className="mt-2 inline-block text-xs font-bold text-primary">Изменить в кабинете →</Link>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-grid grid-cols-4 border border-border">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}
              className={`min-h-10 px-2 text-xs font-bold sm:px-3 ${period === p.id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{p.label}</button>
          ))}
        </div>
        <BotFilterTabs value={bot} onChange={setBot} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi label="Результат" value={formatUsdt(s.counted ? s.netUsdt : null)} tone={s.counted ? s.netUsdt : null} hint={`${s.trades} закрытых сделок`} />
        <Kpi label="В плюс" value={s.winRate === null ? "—" : `${Math.round(s.winRate)}%`} hint={`${s.wins} в плюс · ${s.losses} в минус`} />
        <Kpi label="Профит-фактор" value={formatFactor(s.profitFactor)} hint="заработано / потеряно" />
        <Kpi label="Средняя сделка" value={formatUsdt(s.avgUsdt)} tone={s.avgUsdt} />
        <Kpi label="Макс. просадка" value={s.maxDrawdownUsdt ? formatUsdt(-s.maxDrawdownUsdt) : "—"} tone={s.maxDrawdownUsdt ? -1 : null} hint="от пика результата" />
        <Kpi label="Открыто сейчас" value={String(open.length)} hint={open.length ? `сейчас ${formatUsdt(floating)}` : "позиций нет"} />
      </div>
      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-bold">Результат по дням</h2>
        {days.length === 0 ? <p className="text-sm text-muted-foreground">Пока нет закрытых сделок.</p> : (
          <div className="flex h-32 items-center gap-[2px]" aria-label="Результат по дням">
            {days.map((d) => (
              <div key={d.day} className="flex h-full flex-1 flex-col justify-center" title={`${d.day}: ${formatUsdt(d.pnl)} · ${d.trades} сделок`}>
                <div className="flex h-1/2 items-end">{d.pnl > 0 && <div className="w-full bg-success" style={{ height: `${(d.pnl / maxAbs) * 100}%` }} />}</div>
                <div className="flex h-1/2 items-start">{d.pnl < 0 && <div className="w-full bg-destructive" style={{ height: `${(-d.pnl / maxAbs) * 100}%` }} />}</div>
              </div>
            ))}
          </div>
        )}
      </section>
      {s.best && s.worst && (
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Лучшая" value={formatUsdt(s.best.pnlUsdt)} tone={s.best.pnlUsdt} hint={coin(s.best.symbol)} />
          <Kpi label="Худшая" value={formatUsdt(s.worst.pnlUsdt)} tone={s.worst.pnlUsdt} hint={coin(s.worst.symbol)} />
        </div>
      )}
      <div className="flex gap-4 text-sm">
        <Link href="/journal/positions" className="font-bold text-primary">Открытые позиции →</Link>
        <Link href="/journal/trades" className="font-bold text-primary">История →</Link>
      </div>
    </div>
  );
}
