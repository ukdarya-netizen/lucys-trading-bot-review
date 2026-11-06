/**
 * Owner 2026-11-06: the bots' own results for a subscriber — what each way of leading the trades gives,
 * on the bots' real signals (and the Nihilist backtest). Works even while the subscriber's own account
 * has no trades. Read only; the deposit is counted at the subscriber's own size and leverage.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BotBrand, BOT_BRAND_NAMES, type BotSource } from "@/components/BotBrand";
import { api, type PositionSettings } from "@/lib/subscriber-api";
import { useSubscription } from "./shared";

type Stats = {
  n: number; open: number; winPct: number; stopPct: number; avg: number; sum: number; maxDd: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
};
type CabReport = { days: number | null; from: string | null; to: string | null; trades: number; exits: Record<string, Stats>; byPattern: Record<string, Record<string, Stats>> };
type Group = "long_filtered" | "long_all" | "short";
type NhReport = {
  status: string; finishedAt: string | null; error: string | null;
  datasets: Array<{ name: "live" | "history"; from: string | null; to: string | null; trades: number; groups: Record<Group, Array<{ id: string; label: string; stats: Stats }>> }>;
};

const CAB_EXITS: Array<[string, string]> = [["follow_cab", `Как ${BOT_BRAND_NAMES.cab}`], ["take5", "Фикс +5%"], ["take8", "Фикс +8%"], ["take10", "Фикс +10%"]];
const CAB_PATTERNS: Array<[string, string]> = [
  ["stealth_breakout", "Stealth"], ["neon_support_bounce", "ABNeon"], ["impulse_buy", "Impulse Buy"], ["liquidation_cascade", "Liquidation Cascade"],
];
const PERIODS: Array<[number, string]> = [[30, "30 дней"], [60, "60 дней"], [90, "90 дней"], [0, "всё время"]];

const fmt = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("ru-RU", { maximumFractionDigits: d })}`;
const tone = (v: number | null) => (v === null ? "" : v > 0 ? "text-success" : v < 0 ? "text-destructive" : "");
const d8 = (s: string | null) => (s ? new Date(s).toLocaleDateString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit" }) : "—");
const stable = (s: Stats) => (s.half1.avg ?? -1) > 0 && (s.half2.avg ?? -1) > 0;

/** A price move in % → the subscriber's result: % of deposit (size in %) or USDT (fixed size). */
function money(ps: PositionSettings | undefined, account: "vst" | "real") {
  const lev = ps?.leverage ?? 10;
  if (!ps || ps.allocationMode === "percent") {
    const share = (ps?.allocationValue ?? 1) / 100;
    return { label: `% депозита`, of: (pricePct: number) => pricePct * lev * share, unit: "%", size: `${ps?.allocationValue ?? 1}% от баланса · ${lev}x` };
  }
  const asset = account === "real" ? "USDT" : "VST";
  return { label: asset, of: (pricePct: number) => (pricePct / 100) * ps.allocationValue * lev, unit: ` ${asset}`, size: `${ps.allocationValue} ${asset} · ${lev}x` };
}
type Money = ReturnType<typeof money>;

function Row({ name, s, m }: { name: string; s: Stats | undefined; m: Money }) {
  if (!s || !s.n) return <tr className="border-t border-border"><td className="py-2 pr-2 font-bold">{name}</td><td colSpan={4} className="py-2 text-muted-foreground">сделок нет</td></tr>;
  const res = m.of(s.sum), dd = m.of(s.maxDd);
  return (
    <tr className="border-t border-border tabular">
      <td className="py-2 pr-2 font-bold">{name}</td>
      <td className="py-2 pr-2 text-right">{s.n}</td>
      <td className="py-2 pr-2 text-right">{Math.round(s.winPct)}%</td>
      <td className={`py-2 pr-2 text-right font-bold ${tone(res)}`}>{fmt(res)}{m.unit}</td>
      <td className="py-2 pr-2 text-right text-destructive">{dd ? `−${Math.abs(dd).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${m.unit}` : "—"}</td>
      <td className="py-2 text-right">{stable(s) ? <span className="text-success">да</span> : <span className="text-destructive">нет</span>}</td>
    </tr>
  );
}
function Table({ children, m }: { children: React.ReactNode; m: Money }) {
  return (
    <div className="overflow-x-auto border border-border bg-card px-3">
      <table className="w-full min-w-[480px] text-xs">
        <thead><tr className="text-muted-foreground">
          <th className="py-2 pr-2 text-left font-normal">Как вести</th><th className="py-2 pr-2 text-right font-normal">Сделок</th>
          <th className="py-2 pr-2 text-right font-normal">В плюс</th><th className="py-2 pr-2 text-right font-normal">Результат, {m.label}</th>
          <th className="py-2 pr-2 text-right font-normal">Просадка</th><th className="py-2 text-right font-normal">Устойчиво</th>
        </tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Fail({ q }: { q: { isLoading: boolean; error: unknown } }) {
  if (q.isLoading) return <div className="h-32 animate-pulse border border-border bg-card" />;
  if (q.error) return <p className="border border-destructive/40 p-4 text-sm text-destructive">{(q.error as Error).message || "Не удалось загрузить"}</p>;
  return null;
}

function Cab({ m }: { m: Money }) {
  const [days, setDays] = useState(60);
  const q = useQuery({ queryKey: ["me-bot-cab", days], queryFn: () => api<CabReport>(`/me/bot-report/cab${days ? `?days=${days}` : ""}`), refetchInterval: 300_000 });
  const r = q.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-grid grid-cols-4 border border-border">
          {PERIODS.map(([n, label]) => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}
              className={`min-h-10 px-2 text-xs font-bold sm:px-3 ${days === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
        {r && <span className="text-xs text-muted-foreground">Сигналы {d8(r.from)} — {d8(r.to)} · закрытых {r.trades}</span>}
      </div>
      <Fail q={q} />
      {r && (
        <>
          <Table m={m}>{CAB_EXITS.map(([id, name]) => <Row key={id} name={name} s={r.exits?.[id]} m={m} />)}</Table>
          <h3 className="pt-2 text-sm font-bold">По паттернам</h3>
          {CAB_PATTERNS.map(([pid, pname]) => (
            <div key={pid} className="space-y-1">
              <p className="text-xs font-bold">{pname}</p>
              <Table m={m}>{CAB_EXITS.map(([id, name]) => <Row key={id} name={name} s={r.byPattern?.[pid]?.[id]} m={m} />)}</Table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Nihilist({ m }: { m: Money }) {
  const q = useQuery({ queryKey: ["me-bot-nihilist"], queryFn: () => api<{ running: boolean; report: NhReport | null; historyDays: number }>("/me/bot-report/nihilist"), refetchInterval: 60_000 });
  const [ds, setDs] = useState<"history" | "live">("live");
  const report = q.data?.report ?? null;
  const dataset = report?.datasets?.find((x) => x.name === ds) ?? report?.datasets?.[0] ?? null;
  const ids = dataset ? [...new Map([...(dataset.groups?.long_filtered ?? []), ...(dataset.groups?.short ?? [])].map((x) => [x.id, x.label])).entries()] : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-grid grid-cols-2 border border-border">
          {(["live", "history"] as const).map((n) => (
            <button key={n} type="button" aria-pressed={dataset?.name === n} onClick={() => setDs(n)} disabled={!report?.datasets?.some((x) => x.name === n)}
              className={`min-h-10 px-3 text-xs font-bold disabled:opacity-40 ${dataset?.name === n ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {n === "history" ? `Бэктест ${q.data?.historyDays ?? 60} дней` : "Реальные сигналы"}
            </button>
          ))}
        </div>
        {dataset && <span className="text-xs text-muted-foreground">{d8(dataset.from)} — {d8(dataset.to)} · посчитано {d8(report?.finishedAt ?? null)}</span>}
      </div>
      <Fail q={q} />
      {q.data && !dataset && <p className="border border-border bg-card p-4 text-sm text-muted-foreground">Результаты ещё не посчитаны.</p>}
      {dataset && (["long_filtered", "short"] as const).map((g) => (
        <div key={g} className="space-y-1">
          <p className="text-xs font-bold">{g === "short" ? "Шорты" : "Лонги"}</p>
          <Table m={m}>{ids.map(([id, label]) => <Row key={id} name={label} s={dataset.groups?.[g]?.find((x) => x.id === id)?.stats} m={m} />)}</Table>
        </div>
      ))}
    </div>
  );
}

export default function SubBots() {
  const sub = useSubscription().data?.subscription;
  const [tab, setTab] = useState<BotSource>("cab");
  const m = money(sub?.positionSettings, sub?.tradingAccount ?? "vst");
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div role="tablist" className="flex gap-1 border-b border-border">
        {(["cab", "nihilist"] as const).map((id) => (
          <button key={id} role="tab" type="button" aria-label={BOT_BRAND_NAMES[id]} aria-selected={tab === id} onClick={() => setTab(id)}
            className={`-mb-px flex min-h-14 min-w-0 flex-1 items-center justify-center border border-b-0 px-2 ${tab === id ? "border-border bg-card" : "border-transparent text-muted-foreground"}`}>
            <BotBrand source={id} size="sm" />
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Результаты самого бота на всех его сигналах — не ваши сделки. Результат посчитан при вашем размере ({m.size}), с комиссиями, без реинвеста.
        «Устойчиво» — в плюсе в обеих половинах периода.
      </p>
      {tab === "cab" ? <Cab m={m} /> : <Nihilist m={m} />}
    </div>
  );
}
