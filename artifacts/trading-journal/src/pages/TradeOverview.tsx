// Обзор торгового бота (owner 2026-11-03): both signal sources at a glance — or one of them.
import { useMemo, type ReactNode } from "react";
import { Crosshair, Percent, ShieldAlert, TrendingUp, Wallet } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsdt, toneClass } from "@/lib/performance";
import {
  LoadingOrError, SourceSwitch, SourcesStatus, TotalsTable, bySource, useExecutor, useSourceFilter,
} from "@/components/executor-ui";

function Kpi({ label, value, hint, tone, icon }: { label: string; value: string; hint?: string; tone?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full items-start gap-3 border border-border bg-card p-4">
      {icon && <span className="lucy-kpi-icon">{icon}</span>}
      <div className="min-w-0">
        <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
        <p className={`mt-1 text-xl font-bold tabular ${tone ?? ""}`}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/** Header with the owner's picture (owner 2026-11-04). */
function Hero({ enabled, env }: { enabled: boolean; env: string | undefined }) {
  return (
    <section className="lucy-hero">
      <img className="lucy-hero-img" src={`${import.meta.env.BASE_URL}lucy-hero.webp`} alt="" width={820} height={640} />
      <div className="lucy-hero-body">
        <p className="lucy-hero-kicker">BingX · {env === "real" ? "реальный счёт" : "демо VST"}</p>
        <h2 className="lucy-hero-title">Lucy&apos;s<br />Trading Bot</h2>
        <p className="lucy-hero-text">Сделки по сигналам CAB и Нигилиста: вход, стоп и выход — автоматически, по выбранной стратегии.</p>
        {enabled && <span className="lucy-online"><i />Online</span>}
      </div>
    </section>
  );
}

export default function TradeOverview() {
  const q = useExecutor();
  const [filter, setFilter] = useSourceFilter();
  const d = q.data;
  const closed = useMemo(() => (d ? bySource(d.closed, filter) : []), [d, filter]);
  const curve = useMemo(() => {
    let cum = 0;
    return [...closed].filter((t) => t.closedAt && t.pnl !== null).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))
      .map((t) => { cum += t.pnl!; return { at: new Date(t.closedAt!).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Samara" }), pnl: Math.round(cum * 100) / 100 }; });
  }, [closed]);
  if (!d) return <LoadingOrError q={q} />;
  const open = bySource(d.open, filter);
  const floating = open.reduce((s, t) => s + (t.unrealized ?? 0), 0);
  const totals = bySource(d.totals, filter);
  const pnl = totals.reduce((s, t) => s + t.pnl, 0);
  const n = totals.reduce((s, t) => s + t.closed, 0);
  const wins = totals.reduce((s, t) => s + t.wins, 0);
  const liq = totals.reduce((s, t) => s + t.liquidations, 0);
  const a = d.accounts[0];
  const asset = a?.env === "real" ? "USDT" : "VST";
  const name = filter === "all" ? "оба бота" : filter === "cab" ? "CAB" : "Нигилист";

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <Hero enabled={d.enabled} env={a?.env} />
      {!d.enabled && <p className="border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Торговый бот выключен: в Secrets нет EXECUTOR_V2=1.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div className="col-span-2 lg:col-span-3"><Kpi icon={<Wallet className="h-5 w-5" />} label={a?.label ?? "Счёт"} value={a?.balance ? `${a.balance.equity.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${asset}` : "—"} hint={a?.balance ? `свободно ${a.balance.available.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}` : undefined} /></div>
        <div className="col-span-2 lg:col-span-3"><Kpi icon={<TrendingUp className="h-5 w-5" />} label={`Результат закрытых · ${name}`} value={`${formatUsdt(pnl)} ${asset}`} tone={toneClass(n ? pnl : null)} hint={`${n} сделок`} /></div>
        <div className="lg:col-span-2"><Kpi icon={<Percent className="h-5 w-5" />} label="Доля плюсовых" value={n ? `${Math.round((wins / n) * 100)}%` : "—"} hint={n ? `${wins} из ${n}` : "сделок ещё нет"} /></div>
        <div className="lg:col-span-2"><Kpi icon={<Crosshair className="h-5 w-5" />} label="Открыто сейчас" value={String(open.length)} tone={toneClass(open.length ? floating : null)} hint={`плавающий ${formatUsdt(floating)} ${asset}`} /></div>
        <div className="lg:col-span-2"><Kpi icon={<ShieldAlert className="h-5 w-5" />} label="Ликвидаций" value={String(liq)} tone={liq ? "text-destructive" : ""} hint={liq ? "нужно разобрать" : "ни одной"} /></div>
      </section>

      <SourcesStatus d={d} />

      <section className="border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-bold">Накопленный результат закрытых сделок · {name}</h2>
        {curve.length < 2 ? <p className="text-sm text-muted-foreground">График появится после второй закрытой сделки.</p> : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="at" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={56} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }} formatter={(v: number) => [`${formatUsdt(v)} ${asset}`, "Итог"]} />
                <Line type="monotone" dataKey="pnl" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-bold">Итог по ботам — лонги и шорты отдельно</h2>
        <TotalsTable d={d} filter={filter} />
      </section>

    </div>
  );
}
