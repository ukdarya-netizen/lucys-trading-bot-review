// Small form pieces shared by Settings, Strategies and the cabinet.
export const num = (v: number, d = 2) => v.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Own margin of one trade: a % of the balance or a fixed amount. */
export const marginOf = (mode: "percent" | "amount", value: number, equity: number | null) =>
  mode === "amount" ? value : equity !== null ? (equity * value) / 100 : null;

export function Seg<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-grid border border-border" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([id, label]) => (
        <button key={id} type="button" disabled={disabled} aria-pressed={value === id} onClick={() => onChange(id)}
          className={`min-h-10 px-3 text-xs font-bold disabled:cursor-not-allowed ${value === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{label}</button>
      ))}
    </div>
  );
}

export function SizeInput({ mode, value, asset, onMode, onValue, disabled }: {
  mode: "percent" | "amount"; value: number; asset: string; onMode: (m: "percent" | "amount") => void; onValue: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Seg value={mode} onChange={onMode} disabled={disabled} options={[["percent", "% от баланса"], ["amount", "Сумма"]]} />
      <label className="flex items-center border border-border">
        <input type="number" min={0} step={mode === "percent" ? 0.1 : 1} value={Number.isFinite(value) ? value : ""} disabled={disabled}
          onChange={(e) => onValue(Number(e.target.value))}
          className="min-h-10 w-24 bg-transparent px-2 text-sm tabular outline-none" aria-label="Размер" />
        <span className="px-2 text-xs text-muted-foreground">{mode === "percent" ? "%" : asset}</span>
      </label>
    </div>
  );
}
