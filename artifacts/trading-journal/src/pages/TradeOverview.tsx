// Обзор торгового бота (owner 2026-11-03): all signal sources at a glance — or one of them.
import { useMemo, useState, type ReactNode } from "react";
import { Crosshair, Percent, ShieldAlert, TrendingUp, Wallet } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsdt, toneClass } from "@/lib/performance";
import { BOT_BRAND_NAMES } from "@/components/BotBrand";
import {
  ACCOUNT_TEXT, LoadingOrError, OwnerAccountNotice, SourceSwitch, SourcesStatus, TotalsTable, accountKind, assetOfAccount, bySource, useExecutor, useSourceFilter,
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
function Hero({ enabled, kind }: { enabled: boolean; kind: "REAL" | "VST" | "PAPER" }) {
  return (
    <section className="lucy-hero">
      <img className="lucy-hero-img" src={`${import.meta.env.BASE_URL}lucy-hero.webp`} alt="" width={820} height={640} />
      <div className="lucy-hero-body">
        <p className="lucy-hero-kicker">BingX · {ACCOUNT_TEXT[kind]}</p>
        <h2 className="lucy-hero-title">Lucy&apos;s<br />Trading Bot</h2>
        <p className="lucy-hero-text">Сделки по сигналам {BOT_BRAND_NAMES.cab}, {BOT_BRAND_NAMES.nihilist} и {BOT_BRAND_NAMES.btc}: вход, стоп и выход — автоматически, по выбранной стратегии.</p>
        {enabled && <span className="lucy-online"><i />Приём сигналов</span>}
      </div>
    </section>
  );
}

type Period = "today" | "7" | "30" | "all";
const PERIODS: Array<[Period, string]> = [["today", "сегодня"], ["7", "7 дней"], ["30", "30 дней"], ["all", "всё время"]];
const ACC_KEY = "overview-account", PER_KEY = "overview-period";
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
/** Samara calendar day of a time, YYYY-MM-DD. */
const samaraDay = (t: number) => new Date(t + 4 * 3_600_000).toISOString().slice(0, 10);
const d8 = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/**
 * Owner 2026-11-16: one account at a time (REAL — USDT, VST — VST, PAPER — paper USDT; never summed together) and
 * a period (today / 7 / 30 days / all time) with its dates written out — every number on the page is for them.
 */
export default function TradeOverview() {
  const q = useExecutor();
  const [filter, setFilter] = useSourceFilter();
  const [period, setPeriodRaw] = useState<Period>(() => (recall(PER_KEY) as Period | null) ?? "all");
  const [acc, setAccRaw] = useState<string | null>(() => recall(ACC_KEY));
  const setPeriod = (v: Period) => { setPeriodRaw(v); remember(PER_KEY, v); };
  const setAcc = (v: string) => { setAccRaw(v); remember(ACC_KEY, v); };
  const d = q.data;
  // The owner's accounts: the running ones and every one that has trades.
  const accounts = useMemo(() => {
    if (!d) return [] as string[];
    const ids = new Set<string>();
    for (const a of d.accounts) if (a.id.startsWith("owner-")) ids.add(a.id);
    for (const t of [...d.totals, ...d.open]) if (t.accountId.startsWith("owner-")) ids.add(t.accountId);
    const order = { REAL: 0, VST: 1, PAPER: 2 };
    return [...ids].sort((a, b) => order[accountKind(a)] - order[accountKind(b)]);
  }, [d]);
  const account = acc && accounts.includes(acc) ? acc : accounts[0] ?? "owner-vst";
  const today = samaraDay(Date.now());
  const fromDay = period === "all" ? null : period === "today" ? today : samaraDay(Date.now() - (Number(period) - 1) * 86_400_000);
  const totals = useMemo(() => (d ? bySource(d.totals, filter).filter((t) => t.accountId === account && t.day && (!fromDay || t.day >= fromDay)) : []), [d, filter, account, fromDay]);
  const curve = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const t of totals) byDay.set(t.day!, (byDay.get(t.day!) ?? 0) + t.pnl);
    let cum = 0;
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => { cum += v; return { at: d8(day), pnl: Math.round(cum * 100) / 100 }; });
  }, [totals]);
  if (!d) return <LoadingOrError q={q} />;
  const asset = assetOfAccount(account);
  const kind = accountKind(account);
  const open = bySource(d.open, filter).filter((t) => t.accountId === account);
  const floating = open.reduce((s, t) => s + (t.unrealized ?? 0), 0);
  const pnl = totals.reduce((s, t) => s + t.pnl, 0);
  const n = totals.reduce((s, t) => s + t.closed, 0);
  const wins = totals.reduce((s, t) => s + t.wins, 0);
  // Owner 2026-11-09: closes by a source's cancellation are not wins or losses; their money stays in the result.
  const cancelled = totals.reduce((s, t) => s + (t.cancelled ?? 0), 0);
  const cancelledPnl = totals.reduce((s, t) => s + (t.cancelledPnl ?? 0), 0);
  const counted = n - cancelled;
  const liq = totals.reduce((s, t) => s + t.liquidations, 0);
  const days = totals.map((t) => t.day!).sort();
  const firstDay = fromDay ?? days[0] ?? null;
  const span = firstDay ? `${d8(firstDay)} — ${d8(today)}` : "сделок ещё нет";
  const bal = d.accounts.find((a) => a.id === account)?.balance ?? null;
  const name = filter === "all" ? "все боты" : BOT_BRAND_NAMES[filter];
  // Owner 2026-11-16 («как человек должен понять, сколько бот зарабатывает»): every account in % of its deposit —
  // the accounts differ in size and money, the percent compares them. Deposit at the start of the period = balance
  // now − closed result of the period − result of the open positions (deposits / withdrawals not known).
  const earn = accounts.map((id) => {
    const rows = d.totals.filter((t) => t.accountId === id && t.day && (!fromDay || t.day >= fromDay) && (filter === "all" || t.source === filter));
    const p = rows.reduce((s, t) => s + t.pnl, 0);
    const c = rows.reduce((s, t) => s + t.closed - (t.cancelled ?? 0), 0);
    const w = rows.reduce((s, t) => s + t.wins, 0);
    const fl = d.open.filter((t) => t.accountId === id && (filter === "all" || t.source === filter)).reduce((s, t) => s + (t.unrealized ?? 0), 0);
    const b = d.accounts.find((a) => a.id === id)?.balance ?? null;
    const start = b ? b.equity - p - fl : null;
    return { id, p, n: rows.reduce((s, t) => s + t.closed, 0), c, w, pct: start && start > 0 ? (p / start) * 100 : null };
  });
  const num2 = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <Hero enabled={d.enabled && Boolean(d.ownerAccount?.tradingEnabled && d.ownerAccount.balanceStatus === "available")} kind={kind} />
      <OwnerAccountNotice d={d} />
      {!d.enabled && <p className="border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Торговый бот выключен: в Secrets нет EXECUTOR_V2=1.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
        <div role="tablist" aria-label="Счёт" className="inline-flex border border-border bg-card">
          {accounts.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={id === account} onClick={() => setAcc(id)}
              className={`min-h-10 px-3 text-xs font-bold ${id === account ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {accountKind(id)} <span className="font-normal">· {assetOfAccount(id)}</span>
            </button>
          ))}
        </div>
        <div role="tablist" aria-label="Период" className="inline-flex border border-border bg-card">
          {PERIODS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={id === period} onClick={() => setPeriod(id)}
              className={`min-h-10 px-3 text-xs font-bold ${id === period ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Счёт <b className="text-foreground">{kind}</b> ({ACCOUNT_TEXT[kind]}) · {name} · период <b className="text-foreground">{span}</b>. Все суммы — в {asset}; счета не складываются.
      </p>

      <section className="border border-border bg-card p-4" data-testid="earnings">
        <h2 className="text-base font-bold">Сколько заработал бот · {name} · {span}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {earn.map((e) => (
            <button key={e.id} type="button" onClick={() => setAcc(e.id)} className={`border p-4 text-left ${e.id === account ? "border-primary" : "border-border"}`}>
              <p className="text-xs font-bold uppercase text-muted-foreground">{accountKind(e.id)} · {ACCOUNT_TEXT[accountKind(e.id)]}</p>
              <p className={`mt-1 text-3xl font-bold tabular ${toneClass(e.n ? e.p : null)}`}>{e.pct === null ? "—" : `${e.pct > 0 ? "+" : ""}${e.pct.toFixed(1).replace(".", ",")}%`}</p>
              <p className="text-xs text-muted-foreground">к депозиту</p>
              <p className="mt-2 text-sm tabular"><b className={toneClass(e.n ? e.p : null)}>{formatUsdt(e.p)} {assetOfAccount(e.id)}</b> · {e.n} сделок{e.c > 0 ? ` · ${Math.round((e.w / e.c) * 100)}% в плюс` : ""}</p>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Счета разного размера и в разных деньгах — сравнивайте проценты. Процент — закрытые сделки за период к депозиту на начало периода; пополнения и выводы не учитываются. Нажмите на счёт — ниже подробности по нему.</p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div className="col-span-2 lg:col-span-3"><Kpi icon={<Wallet className="h-5 w-5" />} label={`Баланс счёта ${kind}`} value={bal ? `${num2(bal.equity)} ${asset}` : "—"} hint={bal ? `свободно ${num2(bal.available)} ${asset} · сейчас` : "баланс этого счёта сейчас не прочитан"} /></div>
        <div className="col-span-2 lg:col-span-3"><Kpi icon={<TrendingUp className="h-5 w-5" />} label={`Результат закрытых · ${span}`} value={`${formatUsdt(pnl)} ${asset}`} tone={toneClass(n ? pnl : null)} hint={`${n} сделок${cancelled ? ` · из них отмены источника: ${cancelled} (${formatUsdt(cancelledPnl)} ${asset})` : ""}`} /></div>
        <div className="lg:col-span-2"><Kpi icon={<Percent className="h-5 w-5" />} label={`Доля плюсовых · ${span}`} value={counted > 0 ? `${Math.round((wins / counted) * 100)}%` : "—"} hint={counted > 0 ? `${wins} из ${counted} закрытых${cancelled ? " · отмены не считаются" : ""}` : "сделок за период нет"} /></div>
        <div className="lg:col-span-2"><Kpi icon={<Crosshair className="h-5 w-5" />} label="Открыто сейчас" value={String(open.length)} tone={toneClass(open.length ? floating : null)} hint={open.length ? `результат открытых позиций: ${formatUsdt(floating)} ${asset}` : "открытых позиций нет"} /></div>
        <div className="lg:col-span-2"><Kpi icon={<ShieldAlert className="h-5 w-5" />} label={`Ликвидаций · ${span}`} value={String(liq)} tone={liq ? "text-destructive" : ""} hint={liq ? "нужно разобрать" : "ни одной"} /></div>
      </section>

      <SourcesStatus d={d} />

      <section className="border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-bold">Накопленный результат закрытых сделок по дням · {kind} · {name} · {span}, {asset}</h2>
        {curve.length < 2 ? <p className="text-sm text-muted-foreground">График появится, когда в периоде будет хотя бы два дня с закрытыми сделками.</p> : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="at" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={56} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }} formatter={(v: number) => [`${formatUsdt(v)} ${asset}`, "С начала периода"]} />
                <Line type="monotone" dataKey="pnl" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-bold">Итог по ботам — лонги и шорты отдельно · {kind} · {span}</h2>
        <TotalsTable rows={totals} asset={asset} />
      </section>

    </div>
  );
}
