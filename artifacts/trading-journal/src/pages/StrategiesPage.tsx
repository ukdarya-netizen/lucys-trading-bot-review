// «CAB и Нигилист» (owner 2026-11-03): one tab per signal bot with its rules only — how trades are
// led (numbered cards, same look for both) and Bitcoin. On/off and the trade size are in «Мой кабинет».
// Each strategy card shows what that way of leading would have given to the deposit at the owner's size:
// CAB on its real closed signals (computed in CAB), Nihilist on its backtest and real signals.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { OwnerStrategyCard } from "@/components/owner-strategy-card";
import { StrategyCard, StrategySection, NIHILIST_DESCRIPTIONS } from "@/components/StrategyCard";
import { BtcCard, defaultBtc } from "@/components/BtcCard";
import { LoadingOrError, useExecutor, type Status } from "@/components/executor-ui";
import { marginOf, num } from "@/components/form-bits";
import { api, ApiFailure } from "@/lib/subscriber-api";

type Source = "cab" | "nihilist";
const LEVERAGE = 10;

export default function StrategiesPage() {
  const ex = useExecutor();
  const [tab, setTab] = useState<Source>(() => { try { return localStorage.getItem("strategies-tab") === "nihilist" ? "nihilist" : "cab"; } catch { return "cab"; } });
  const choose = (t: Source) => { setTab(t); try { localStorage.setItem("strategies-tab", t); } catch { /* private mode */ } };
  const d = ex.data;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-border">
        {([["cab", "CAB"], ["nihilist", "Нигилист"]] as const).map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => choose(id)}
            className={`-mb-px min-h-11 border border-b-0 px-5 text-sm font-bold ${tab === id ? "border-border bg-card" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>
      {!d ? <LoadingOrError q={ex} /> : (
        <>
          {!d.enabled && <p className="border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Торговый бот выключен: в Secrets нет EXECUTOR_V2=1.</p>}
          {tab === "cab" ? <CabStrategies d={d} /> : <NihilistStrategies d={d} onSaved={() => void ex.refetch()} />}
          <BotBtc key={tab} source={tab} d={d} onSaved={() => void ex.refetch()} />
        </>
      )}
    </div>
  );
}

function money(d: Status) {
  const equity = d.accounts[0]?.balance?.equity ?? null;
  const asset = d.accounts[0]?.env === "real" ? "USDT" : "VST";
  return { equity, asset };
}
const sizeText = (mode: "percent" | "amount", value: number, asset: string) => (mode === "percent" ? `${value}% от баланса` : `${value} ${asset}`);

function BotBtc({ source, d, onSaved }: { source: Source; d: Status; onSaved: () => void }) {
  const { equity, asset } = money(d);
  const s = source === "cab" ? d.cab.settings : d.nihilist.settings;
  return (
    <BtcCard title={`Биткоин (BTC) в сделках ${source === "cab" ? "CAB" : "Нигилиста"}`}
      saved={d.btc.settings.find((b) => b.source === source) ?? defaultBtc(source)} maxLeverage={d.btc.maxLeverage}
      savePath="/journal/executor/btc-settings" onSaved={onSaved}
      otherMargin={marginOf(s.allocationMode, s.allocationValue, equity)} otherText={sizeText(s.allocationMode, s.allocationValue, asset)}
      equity={equity} asset={asset} showEnable={false}
      note={source === "cab" ? "Ведение BTC — по правилам CAB для BTC при любой стратегии." : "Ведение BTC — по выбранной выше стратегии Нигилиста."} />
  );
}

type Stats = {
  n: number; open: number; winPct: number; stopPct: number; avg: number; sum: number; maxDd: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
};
type Group = "long_filtered" | "long_all" | "short";
type Report = {
  status: string; finishedAt: string | null; error: string | null; progress: { stage: string; done: number; total: number };
  datasets: Array<{ name: "live" | "history"; from: string | null; to: string | null; trades: number; groups: Record<Group, Array<{ id: string; label: string; stats: Stats }>> }>;
};
const SIDES: Array<[Group, string]> = [["long_filtered", "Лонги"], ["short", "Шорты"]];
const sg = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-success" : v < 0 ? "text-destructive" : "");
const stable = (s: Stats) => (s.half1.avg ?? -1) > 0 && (s.half2.avg ?? -1) > 0;
const d8 = (s: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

/** Deposit growth at the owner's size for this bot: a trade's price move × 10x × the share of the balance put in. */
function depositOf(d: Status, s: { allocationMode: "percent" | "amount"; allocationValue: number }) {
  const { equity, asset } = money(d);
  const share = s.allocationMode === "percent" ? s.allocationValue / 100 : equity ? s.allocationValue / equity : null;
  const dep = (pricePct: number) => (share === null ? null : pricePct * LEVERAGE * share);
  const cash = (depPct: number | null) => (depPct === null || equity === null ? "" : ` (${sg((equity * depPct) / 100)} ${asset})`);
  return { dep, cash, asset, size: sizeText(s.allocationMode, s.allocationValue, asset) };
}
type Dep = ReturnType<typeof depositOf>;

function ResultLine({ name, r, money: m }: { name: string; r: Stats | undefined; money: Dep }) {
  if (!r || !r.n) return <span className="block text-muted-foreground">{name}: сделок нет</span>;
  const grow = m.dep(r.sum), dd = m.dep(r.maxDd);
  return (
    <span className="block tabular">
      <b>{name}</b> · {r.n} сделок · в плюс {Math.round(r.winPct)}% · депозит{" "}
      <b className={grow === null ? "" : tone(grow)}>{grow === null ? "—" : `${sg(grow)}%${m.cash(grow)}`}</b>
      {" "}· просадка <span className="text-destructive">{dd === null ? "—" : `−${num(dd)}%`}</span>
      {" "}· устойчиво {stable(r) ? <span className="text-success">да</span> : <span className="text-destructive">нет</span>}
    </span>
  );
}

type CabReport = {
  days: number | null; from: string | null; to: string | null; trades: number;
  exits: Record<string, Stats>; byPattern: Record<string, Record<string, Stats>>;
};
const CAB_PERIODS: Array<[number, string]> = [[30, "30 дней"], [60, "60 дней"], [90, "90 дней"], [0, "всё время"]];
const CAB_EXITS: Array<[string, string]> = [["follow_cab", "как CAB"], ["take5", "+5%"], ["take8", "+8%"], ["take10", "+10%"]];

/** CAB: the owner's strategy picker with results inside each card. */
function CabStrategies({ d }: { d: Status }) {
  const [days, setDays] = useState(60);
  const rep = useQuery({ queryKey: ["cab-report", days], queryFn: () => api<CabReport>(`/journal/executor/cab-report${days ? `?days=${days}` : ""}`), refetchInterval: 300_000 });
  const m = depositOf(d, d.cab.settings);
  const r = rep.data;
  const toolbar = (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-grid grid-cols-4 border border-border">
          {CAB_PERIODS.map(([n, label]) => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}
              className={`min-h-10 px-3 text-xs font-bold ${days === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{rep.isLoading ? "Считается…" : rep.error ? (rep.error as Error).message : r ? `Сигналы ${d8(r.from)} — ${d8(r.to)}, закрытых сделок ${r.trades}` : ""}</span>
      </div>
      {r && (
        <p className="text-xs text-muted-foreground">
          Реальные закрытые сигналы CAB четырёх паттернов (без BTC). Фикс засчитывается, если цена дошла до уровня, иначе — выход CAB.
          Депозит — прирост при вашем размере сделки ({m.size}, плечо {LEVERAGE}x), с комиссиями, без реинвеста. «Устойчиво» — в плюсе в обеих половинах периода.
        </p>
      )}
    </>
  );
  const extra = (id: string, choices: { patterns: Array<{ id: string; label: string }> }) => {
    if (!r) return null;
    if (id === "patterns") {
      return (
        <span className="mt-3 block space-y-1 border-t border-border pt-2 text-xs">
          {choices.patterns.map((p) => {
            const st = r.byPattern[p.id];
            return (
              <span key={p.id} className="block tabular">
                <b>{p.label}</b>{!st ? <span className="text-muted-foreground"> · сделок нет</span> : <> · {st.follow_cab?.n ?? 0} сделок · депозит{" "}
                  {CAB_EXITS.map(([e, label], i) => {
                    const g = st[e] ? m.dep(st[e]!.sum) : null;
                    return <span key={e}>{i ? " · " : ""}{label} <span className={g === null ? "" : tone(g)}>{g === null ? "—" : `${sg(g)}%`}</span></span>;
                  })}</>}
              </span>
            );
          })}
        </span>
      );
    }
    return <span className="mt-3 block border-t border-border pt-2 text-xs"><ResultLine name="Лонги" r={r.exits[id]} money={m} /></span>;
  };
  return <OwnerStrategyCard toolbar={toolbar} extra={extra} />;
}

function NihilistStrategies({ d, onSaved }: { d: Status; onSaved: () => void }) {
  const rep = useQuery({ queryKey: ["nihilist-report"], queryFn: () => api<{ running: boolean; report: Report | null; historyDays: number }>("/journal/executor/nihilist-report"), refetchInterval: 15_000 });
  const [ds, setDs] = useState<"history" | "live">("history");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const run = useMutation({ mutationFn: () => api("/journal/executor/nihilist-report/run", { method: "POST" }), onSuccess: () => void rep.refetch(), onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось запустить", bad: true }) });
  const pick = useMutation({
    mutationFn: (strategy: string) => api("/journal/executor/source-settings/nihilist", { method: "POST", body: { strategy } }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сделок; открытые закрываются по своей стратегии.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const current = d.nihilist.settings.strategy;
  const strategies = d.nihilist.strategies;
  const report = rep.data?.report ?? null;
  const running = Boolean(rep.data?.running) || report?.status === "running";
  const dataset = report?.datasets.find((x) => x.name === ds) ?? report?.datasets[0] ?? null;

  const m = depositOf(d, d.nihilist.settings);

  return (
    <StrategySection title="Как вести сделки Нигилиста" current={strategies.find((x) => x.id === current)?.label ?? current} message={msg}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-grid grid-cols-2 border border-border">
          {(["history", "live"] as const).map((n) => (
            <button key={n} type="button" aria-pressed={dataset?.name === n} onClick={() => setDs(n)} disabled={!report?.datasets.some((x) => x.name === n)}
              className={`min-h-10 px-3 text-xs font-bold disabled:opacity-40 ${dataset?.name === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {n === "history" ? `Бэктест ${rep.data?.historyDays ?? 60} дней` : "Реальные сигналы"}
            </button>
          ))}
        </div>
        <button type="button" disabled={running || run.isPending} onClick={() => run.mutate()}
          className="flex min-h-10 items-center gap-2 border border-border px-3 text-xs font-bold hover:border-primary disabled:opacity-50">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? "Считается…" : report ? "Пересчитать" : "Посчитать результаты"}
        </button>
        <span className="text-xs text-muted-foreground">
          {rep.error ? (rep.error as Error).message
            : !report ? "Расчёт идёт в Нигилисте 20–60 минут и не задерживает сигналы."
            : report.status === "running" ? `Идёт: ${report.progress.stage === "history" ? "бэктест" : "реальные сигналы"} ${report.progress.done} из ${report.progress.total}`
            : report.status === "failed" ? `Ошибка: ${report.error}` : `Посчитано ${d8(report.finishedAt)}`}
        </span>
      </div>
      {dataset && (
        <p className="text-xs text-muted-foreground">
          {dataset.name === "history" ? "Бэктест: правила Нигилиста на истории всех пар BingX" : "Реальные сигналы Нигилиста"}, {d8(dataset.from)} — {d8(dataset.to)}.
          Депозит — прирост при вашем размере сделки ({m.size}, плечо {LEVERAGE}x), с комиссиями, без реинвеста.
          «Устойчиво» — в плюсе в обеих половинах периода.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {strategies.map((st, i) => (
          <StrategyCard key={st.id} index={i + 1} label={st.label} description={NIHILIST_DESCRIPTIONS[st.id]}
            saved={current === st.id} active={current === st.id} disabled={pick.isPending}
            onClick={() => { if (current !== st.id) pick.mutate(st.id); }}>
            {dataset && (
              <span className="mt-3 block space-y-1 border-t border-border pt-2 text-xs">
                {SIDES.map(([g, name]) => <ResultLine key={g} name={name} r={dataset.groups[g]?.find((x) => x.id === st.id)?.stats} money={m} />)}
              </span>
            )}
          </StrategyCard>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Если Нигилист закрывает сделку по сроку, бот закрывает её при любой стратегии.</p>
    </StrategySection>
  );
}
