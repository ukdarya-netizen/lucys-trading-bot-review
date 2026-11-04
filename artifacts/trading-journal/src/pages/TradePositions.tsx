// Открытые позиции торгового бота (owner 2026-11-03): CAB and Nihilist, one filter.
import { formatUsdt, toneClass } from "@/lib/performance";
import { LoadingOrError, SourceSwitch, TradeTable, bySource, dt, useExecutor, useSourceFilter } from "@/components/executor-ui";

export default function TradePositions() {
  const q = useExecutor();
  const [filter, setFilter] = useSourceFilter();
  const d = q.data;
  if (!d) return <LoadingOrError q={q} />;
  const open = bySource(d.open, filter);
  const floating = open.reduce((s, t) => s + (t.unrealized ?? 0), 0);
  const asset = d.accounts[0]?.env === "real" ? "USDT" : "VST";
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
        <p className="text-sm">Открыто: <b>{open.length}</b> · плавающий результат <b className={toneClass(open.length ? floating : null)}>{formatUsdt(floating)} {asset}</b></p>
      </div>
      <TradeTable rows={open} kind="open" empty="Открытых позиций нет." />
      <p className="text-[11px] text-muted-foreground">Клик по строке — история сделки: вход, долив маржи, переносы стопа. Обновлено {dt(d.asOf)}, каждые 15 с.</p>
    </div>
  );
}
