// Открытые позиции торгового бота (owner 2026-11-03): CAB and Nihilist, one filter.
import { formatUsdt, toneClass } from "@/lib/performance";
import { LoadingOrError, SourceSwitch, TradeTable, bySource, dt, useExecutor, useSourceFilter } from "@/components/executor-ui";

export default function TradePositions() {
  const q = useExecutor();
  const [filter, setFilter] = useSourceFilter();
  const d = q.data;
  if (!d) return <LoadingOrError q={q} />;
  const open = bySource(d.open, filter);
  // Owner 2026-11-06: bots may sit on different accounts — VST and USDT are never added together.
  const ACC: Array<[string, string]> = [["owner-real", "REAL"], ["owner-vst", "VST"], ["owner-paper", "PAPER"]];
  const parts = ACC.map(([id, label]) => {
    const rows = open.filter((t) => t.accountId === id);
    return { label, n: rows.length, sum: rows.reduce((s, t) => s + (t.unrealized ?? 0), 0), asset: id === "owner-vst" ? "VST" : "USDT" };
  }).filter((p) => p.n > 0);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
        <p className="text-sm">Открыто: <b>{open.length}</b>{parts.map((p) => (
          <span key={p.label}> · {p.label}: <b className={toneClass(p.sum)}>{formatUsdt(p.sum)} {p.asset}</b></span>
        ))}</p>
      </div>
      <TradeTable rows={open} kind="open" empty="Открытых позиций нет." />
      <p className="text-[11px] text-muted-foreground">Клик по строке — история сделки: вход, долив маржи, переносы стопа. Обновлено {dt(d.asOf)}, каждые 15 с.</p>
    </div>
  );
}
