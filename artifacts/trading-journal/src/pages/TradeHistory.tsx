// История торгового бота (owner 2026-11-03): closed trades and signals that were not opened, per source.
import { useState } from "react";
import { LoadingOrError, SourceSwitch, TradeTable, bySource, useExecutor, useSourceFilter } from "@/components/executor-ui";

export default function TradeHistory() {
  const q = useExecutor();
  const [filter, setFilter] = useSourceFilter();
  const [tab, setTab] = useState<"closed" | "skipped">("closed");
  const d = q.data;
  if (!d) return <LoadingOrError q={q} />;
  const closed = bySource(d.closed, filter);
  const skipped = bySource(d.skipped, filter);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SourceSwitch value={filter} onChange={setFilter} />
        <div className="inline-grid grid-cols-2 border border-border bg-card">
          {([["closed", `Закрытые (${closed.length})`], ["skipped", `Не открытые (${skipped.length})`]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}
              className={`min-h-11 px-4 text-sm font-bold ${tab === k ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>{label}</button>
          ))}
        </div>
      </div>
      {tab === "closed" ? <TradeTable rows={closed} kind="closed" empty="Закрытых сделок пока нет." /> : (
        <>
          <p className="text-sm text-muted-foreground">Сигналы, по которым бот не открыл позицию, и почему:</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {bySource(d.skippedTotals, filter).map((r) => (
              <span key={`${r.source}-${r.reason}`} className="border border-border bg-card px-2 py-1">{r.sourceName}: {r.reasonText} — <b>{r.n}</b></span>
            ))}
          </div>
          <TradeTable rows={skipped} kind="skipped" empty="Отказов нет." />
        </>
      )}
    </div>
  );
}
