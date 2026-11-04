// Bitcoin in the trades of one signal bot (owner 2026-11-03): part of that bot's strategy page,
// set separately for CAB and for Nihilist — on/off, leverage (50x unless changed), own size.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bitcoin } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { Seg, SizeInput, marginOf, num } from "@/components/form-bits";

export type BtcSettings = {
  source: string; enabled: boolean; leverage: number; allocationMode: "percent" | "amount" | null; allocationValue: number | null;
};
export const defaultBtc = (source: string): BtcSettings => ({ source, enabled: true, leverage: 50, allocationMode: null, allocationValue: null });

export function BtcCard({ title, saved, maxLeverage, savePath, onSaved, otherMargin, otherText, equity, asset, note, showEnable = true }: {
  title: string; saved: BtcSettings; maxLeverage: number; savePath: string; onSaved: () => void;
  /** Margin of other coins of this bot, for «как у других». */
  otherMargin: number | null; otherText: string; equity: number | null; asset: string; note?: string;
  /** Owner's «CAB и Нигилист»: no on/off here (it is in «Мой кабинет»). */
  showEnable?: boolean;
}) {
  const [b, setB] = useState(saved);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const dirty = JSON.stringify(b) !== JSON.stringify(saved);
  useEffect(() => { if (!dirty) setB(saved); }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<BtcSettings>) => { setB((x) => ({ ...x, ...p })); setMsg(null); };
  const save = useMutation({
    mutationFn: () => api(savePath, { method: "POST", body: { ...b, allocationMode: b.allocationMode ?? "same" } }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сделок.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const margin = b.allocationMode && b.allocationValue ? marginOf(b.allocationMode, b.allocationValue, equity) : otherMargin;
  return (
    <section className="space-y-3 border border-border bg-card p-4" data-testid={`btc-${saved.source}`}>
      <h2 className="flex items-center gap-2 font-bold"><Bitcoin className="h-4 w-4 text-primary" />{title}</h2>
      {showEnable && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Открывать BTC</span>
          <Switch checked={b.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Открывать BTC" />
        </label>
      )}
      <div className={`space-y-3 ${b.enabled || !showEnable ? "" : "pointer-events-none opacity-50"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-xs uppercase text-muted-foreground">Плечо</span>
          <Seg value={[10, 20, 50].includes(b.leverage) ? String(b.leverage) : "other"}
            onChange={(v) => set({ leverage: v === "other" ? (b.leverage === 50 ? 25 : b.leverage) : Number(v) })}
            options={[["10", "10x"], ["20", "20x"], ["50", "50x"], ["other", "своё"]]} />
          {![10, 20, 50].includes(b.leverage) && (
            <label className="flex items-center border border-border">
              <input type="number" min={1} max={maxLeverage} step={1} value={b.leverage}
                onChange={(e) => set({ leverage: Math.round(Number(e.target.value)) })}
                className="min-h-10 w-16 bg-transparent px-2 text-sm tabular outline-none" aria-label="Плечо BTC" />
              <span className="px-2 text-xs text-muted-foreground">x</span>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-xs uppercase text-muted-foreground">Размер</span>
          <Seg value={b.allocationMode === null ? "same" : "own"}
            onChange={(v) => set(v === "same" ? { allocationMode: null, allocationValue: null } : { allocationMode: "percent", allocationValue: 1 })}
            options={[["same", `как у других (${otherText})`], ["own", "свой"]]} />
        </div>
        {b.allocationMode !== null && (
          <SizeInput mode={b.allocationMode} value={b.allocationValue ?? 0} asset={asset}
            onMode={(m) => set({ allocationMode: m, allocationValue: m === "percent" ? 1 : 10 })}
            onValue={(v) => set({ allocationValue: v })} />
        )}
        <p className="text-sm">Маржа ≈ <b className="tabular">{margin !== null ? num(margin) : "—"} {asset}</b> · позиция ≈ <b className="tabular">{margin !== null ? num(margin * b.leverage) : "—"} {asset}</b> · маржа изолированная</p>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {(dirty || save.isPending || msg) && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
            className="min-h-11 border border-primary bg-primary px-5 text-sm font-bold uppercase text-primary-foreground disabled:opacity-40">
            {save.isPending ? "Сохраняю…" : "Сохранить"}
          </button>
          {dirty && !save.isPending && <button type="button" onClick={() => { setB(saved); setMsg(null); }} className="text-sm text-muted-foreground underline">отменить</button>}
          {msg && <span className={`text-sm ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
        </div>
      )}
    </section>
  );
}
