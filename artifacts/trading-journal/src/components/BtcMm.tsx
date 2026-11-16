// Bitcoin Margin Master — the third bot (owner 2026-11-14). Its tab in «Мой кабинет» and in the subscriber's cabinet:
// size, leverage (the signal's by default), margin reserve with the risk hint, management «Как Bitcoin MM», and which
// patterns to trade. Owner 2026-11-16: the same look as CAB and Nihilist; the results of every way are on «Боты».
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { Seg, SizeInput, marginOf, num } from "@/components/form-bits";
import { BOT_BRAND_NAMES } from "@/components/BotBrand";
import { StrategyCard, StrategySection } from "@/components/StrategyCard";

export type Alloc = { mode: "percent" | "amount"; value: number };
export type FamilyId = "range_1d" | "levels_1d" | "smc_4h" | "smc_1d" | "cascade";
export type FamilyRule = { on: boolean; sides: "both" | "long" | "short"; leverage: number | null; alloc: Alloc | null };
export type BtcMm = { alloc: Alloc; leverage: number | null; reserve: number | null; families: Record<FamilyId, FamilyRule> };
export type BtcMmFamily = { id: FamilyId; label: string; signalLeverage: number; maxStopPct: number };

/** Bitcoin MM's maintenance margin and the bot's buffer beyond the stop (executor/btcmm.ts, plan.ts). */
const MMR_PCT = 0.4;
const BUFFER_PCT = 0.5;
const FEES_PCT = 0.1;

/** What one trade of a family risks at the largest stop of its profile (a ceiling, never a typical value). */
export function riskOf(margin: number | null, leverage: number, maxStopPct: number) {
  if (margin === null) return null;
  const notional = margin * leverage;
  const loss = (notional * (maxStopPct + FEES_PCT)) / 100;
  const liqDistance = 100 / leverage - MMR_PCT;
  const reserve = Math.max(0, (notional * (maxStopPct + BUFFER_PCT - liqDistance)) / 100);
  return { notional, loss, reserve };
}

const LEVS = [10, 20, 50] as const;
function LeverageChoice({ value, onChange, max }: { value: number | null; onChange: (v: number | null) => void; max: number }) {
  const sel = value === null ? "inherit" : (LEVS as readonly number[]).includes(value) ? String(value) : "own";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Seg value={sel} onChange={(v) => onChange(v === "inherit" ? null : v === "own" ? (value && !(LEVS as readonly number[]).includes(value) ? value : 25) : Number(v))}
        options={[["inherit", "из сигнала"], ["10", "x10"], ["20", "x20"], ["50", "x50"], ["own", "своё"]]} />
      {sel === "own" && (
        <label className="flex items-center border border-border">
          <input type="number" min={1} max={max} step={1} value={value ?? 25} onChange={(e) => onChange(Math.round(Number(e.target.value)))}
            className="min-h-10 w-16 bg-transparent px-2 text-sm tabular outline-none" aria-label="Своё плечо" />
          <span className="px-2 text-xs text-muted-foreground">x</span>
        </label>
      )}
    </div>
  );
}

const SIDE_TEXT = { both: "лонг и шорт", long: "только лонг", short: "только шорт" } as const;
export const BTCMM_DESCRIPTION = "50% позиции закрывается на цели 1, стоп переносится на вход; остаток — на цели 2. "
  + "Если цели не достигнуты — закрытие по сроку: паттерны 1D — до 45 дней, 4h и каскад — до 10 дней.";

/**
 * Owner 2026-11-16 («сделать простой логичный вид, как у CAB и Нигилиста»): two plain blocks in the look of the
 * other bots — «Размер сделки» (size, leverage, margin reserve; saved by the button) and «Как вести сделки» (the
 * strategy card and one card per pattern: on/off and side; saved on click). Per-pattern size and leverage are gone
 * from the page: every pattern trades at the size and leverage above (a saved per-pattern value is cleared on save).
 */
export function BtcMmSettings({ saved, families, maxLeverage, savePath, onSaved, equity, asset, ownerNote }: {
  saved: BtcMm; families: BtcMmFamily[]; maxLeverage: number; savePath: string; onSaved: () => void;
  equity: number | null; asset: string; ownerNote?: boolean;
}) {
  const [s, setS] = useState(saved);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [famMsg, setFamMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const dirty = s.alloc.mode !== saved.alloc.mode || s.alloc.value !== saved.alloc.value || s.leverage !== saved.leverage || s.reserve !== saved.reserve;
  useEffect(() => { if (!dirty) setS(saved); }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<BtcMm>) => { setS((x) => ({ ...x, ...p })); setMsg(null); };
  const plain = (fam: BtcMm["families"]) => Object.fromEntries(Object.entries(fam).map(([k, r]) => [k, { ...r, alloc: null, leverage: null }])) as BtcMm["families"];
  const saveSize = useMutation({
    mutationFn: () => api(savePath, { method: "POST", body: { ...saved, alloc: s.alloc, leverage: s.leverage, reserve: s.reserve, families: plain(saved.families) } }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сигналов.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const saveFam = useMutation({
    mutationFn: (families: BtcMm["families"]) => api(savePath, { method: "POST", body: { ...saved, families: plain(families) } }),
    onSuccess: () => { setFamMsg({ text: "Сохранено. Действует для новых сигналов; открытые сделки ведутся как были.", bad: false }); onSaved(); },
    onError: (e) => setFamMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const setFam = (id: FamilyId, p: Partial<FamilyRule>) => saveFam.mutate({ ...saved.families, [id]: { ...saved.families[id], ...p } });
  const margin = marginOf(s.alloc.mode, s.alloc.value, equity);
  const h4 = families.find((f) => f.maxStopPct < 5);
  const d1 = families.find((f) => f.maxStopPct >= 5);
  const on = families.filter((f) => saved.families[f.id].on);
  const risk = (f: BtcMmFamily | undefined, name: string) => {
    if (!f) return null;
    const lev = s.leverage ?? f.signalLeverage;
    const r = riskOf(margin, lev, f.maxStopPct);
    if (!r) return <p>{name}: риск посчитается, когда будет виден баланс.</p>;
    const short = s.reserve !== null && r.reserve > s.reserve;
    return (
      <p>
        <b>{name}</b> (x{lev}, стоп до {String(f.maxStopPct).replace(".", ",")}%): при стопе до −{num(r.loss)} {asset}{equity ? ` (${num((r.loss / equity) * 100)}% счёта)` : ""}
        {" · "}<span className={short ? "text-destructive" : ""}>{r.reserve > 0 ? `добор маржи до ${num(r.reserve)} ${asset}${short ? " — больше запаса, такие сделки не откроются" : ""}` : "добор не нужен"}</span>
      </p>
    );
  };

  return (
    <div className="space-y-4" data-testid="btcmm-settings">
      <section className="space-y-3 border border-border bg-card p-4">
        <h2 className="font-bold">Размер сделки</h2>
        <SizeInput mode={s.alloc.mode} value={s.alloc.value} asset={asset}
          onMode={(m) => set({ alloc: { mode: m, value: m === "percent" ? 1 : 50 } })}
          onValue={(v) => set({ alloc: { ...s.alloc, value: v } })} />
        <p className="text-xs">Маржа ≈ <b className="tabular">{margin !== null ? num(margin) : "—"} {asset}</b> · BTC-USDT, изолированная маржа{s.alloc.mode === "percent" && equity === null ? " · баланс счёта пока не виден" : ""}</p>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs uppercase text-muted-foreground">Плечо</p>
          <LeverageChoice value={s.leverage} onChange={(v) => set({ leverage: v })} max={maxLeverage} />
          <p className="text-xs text-muted-foreground">«Из сигнала»: паттерны 1D — x10, 4h и каскад — x20. Максимум x{maxLeverage}.</p>
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs uppercase text-muted-foreground">Запас на добор маржи</p>
          <div className="flex flex-wrap items-center gap-2">
            <Seg value={s.reserve === null ? "free" : "cap"} onChange={(v) => set({ reserve: v === "free" ? null : Math.max(10, Math.round(riskOf(margin, s.leverage ?? 20, 3.68)?.reserve ?? 50)) })}
              options={[["free", "из свободного баланса"], ["cap", "не больше"]]} />
            {s.reserve !== null && (
              <label className="flex items-center border border-border">
                <input type="number" min={0} step={1} value={s.reserve} onChange={(e) => set({ reserve: Math.max(0, Number(e.target.value)) })}
                  className="min-h-10 w-24 bg-transparent px-2 text-sm tabular outline-none" aria-label="Запас на добор маржи" />
                <span className="px-2 text-xs text-muted-foreground">{asset} на сделку</span>
              </label>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Бот доливает маржу, чтобы ликвидация была дальше стопа. Добор не теряется: при стопе он возвращается вместе с остатком маржи.</p>
        </div>
        <div className="space-y-1 border-t border-border pt-3 text-xs">
          {risk(h4, "4h и каскад")}
          {risk(d1, "1D")}
          <p className="text-muted-foreground">Это потолок: стоп каждого сигнала свой и обычно ближе. Комиссии учтены.</p>
        </div>
        {(dirty || saveSize.isPending || msg) && (
          <div className="flex flex-wrap items-center gap-3">
            {dirty && <>
              <button type="button" disabled={saveSize.isPending} onClick={() => saveSize.mutate()}
                className="min-h-10 border border-primary bg-primary px-4 text-xs font-bold uppercase text-primary-foreground disabled:opacity-40">{saveSize.isPending ? "Сохраняю…" : "Сохранить"}</button>
              <button type="button" onClick={() => { setS(saved); setMsg(null); }} className="text-xs text-muted-foreground underline">отменить</button>
            </>}
            {msg && <span className={`text-xs ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
          </div>
        )}
      </section>

      <StrategySection title={`Как вести сделки ${BOT_BRAND_NAMES.btc}`} message={famMsg}
        current={`Как ${BOT_BRAND_NAMES.btc} · паттернов ${on.length} из ${families.length}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <StrategyCard index={1} label={`Как ${BOT_BRAND_NAMES.btc}`} description={BTCMM_DESCRIPTION} saved active readOnly>
            {ownerNote && <span className="mt-2 block text-xs text-muted-foreground">Другие способы ведения пока только считаются — их результаты на странице «Боты».</span>}
          </StrategyCard>
        </div>
        <h3 className="pt-2 text-sm font-bold">Какие паттерны торговать</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {families.map((f) => {
            const r = saved.families[f.id];
            return (
              <div key={f.id} className={`space-y-3 border p-4 ${r.on ? "border-primary bg-primary/10" : "border-border"}`}>
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block font-bold">{f.label}</span>
                    <span className="block text-xs text-muted-foreground">x{f.signalLeverage} в сигнале · стоп до {String(f.maxStopPct).replace(".", ",")}%</span>
                  </span>
                  <Switch checked={r.on} disabled={saveFam.isPending} onCheckedChange={(v) => setFam(f.id, { on: v })} aria-label={`${f.label}: торговать`} />
                </label>
                {r.on
                  ? <Seg value={r.sides} onChange={(v) => setFam(f.id, { sides: v })} disabled={saveFam.isPending}
                      options={[["both", SIDE_TEXT.both], ["long", "лонг"], ["short", "шорт"]]} />
                  : <p className="text-xs text-muted-foreground">Не торгуется</p>}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Выключенный паттерн не открывает новых сделок. Закрытие по сроку действует всегда.</p>
      </StrategySection>
    </div>
  );
}

type Cell = { n: number; pending: number; wins: number; losses: number; breakeven: number; sumPct: number; best: number | null; worst: number | null };
type Report = {
  staleAt?: string; staleError?: string;
  asOf: string; feePct: number; candles: string;
  ways: Array<{ id: string; label: string }>;
  families: Array<{ id: string; label: string }>;
  groups: Array<{ family: string; side: "long" | "short"; signals: number; firstAt: string; lastAt: string; ways: Record<string, Cell> }>;
};
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2).replace(".", ",")}%`);
const tone = (v: number) => (v > 0 ? "text-success" : v < 0 ? "text-destructive" : "");

/**
 * Owner 2026-11-16: the results in the look of CAB and Nihilist — one card per way of leading, the lines «Лонги» and
 * «Шорты» under it, a filter by pattern. «Как Bitcoin MM» is the way the bot trades; the others are counted only.
 */
export function BtcMmReport({ families }: { families: BtcMmFamily[] }) {
  const q = useQuery({ queryKey: ["btcmm-report"], queryFn: () => api<Report>("/journal/executor/btcmm-report"), refetchInterval: 5 * 60_000 });
  const [fam, setFam] = useState("all");
  const r = q.data;
  const lev = (id: string) => families.find((f) => f.id === id)?.signalLeverage ?? 10;
  const line = (wayId: string, side: "long" | "short") => {
    const gs = (r?.groups ?? []).filter((g) => g.side === side && (fam === "all" || g.family === fam));
    let n = 0, pending = 0, wins = 0, be = 0, sum = 0, marginSum = 0;
    for (const g of gs) {
      const c = g.ways[wayId];
      if (!c) continue;
      n += c.n; pending += c.pending; wins += c.wins; be += c.breakeven; sum += c.sumPct; marginSum += c.sumPct * lev(g.family);
    }
    const name = side === "long" ? "Лонги" : "Шорты";
    if (!n) return <span key={side} className="block text-muted-foreground">{name}: закрытых сделок нет{pending ? ` · в пути ${pending}` : ""}</span>;
    return (
      <span key={side} className="block tabular">
        <b>{name}</b> · {n} сделок{pending ? ` (+${pending} в пути)` : ""} · в плюс {Math.round((wins / n) * 100)}%{be ? ` · б/у ${be}` : ""}
        {" "}· результат <b className={tone(marginSum)}>{pct(marginSum)}</b> маржи <span className="text-muted-foreground">({pct(sum)} цены)</span>
      </span>
    );
  };
  return (
    <StrategySection title={`Как вести сделки ${BOT_BRAND_NAMES.btc} — результаты`} current={`Как ${BOT_BRAND_NAMES.btc}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Seg value={fam} onChange={setFam} options={[["all", "все паттерны"], ...(r?.families ?? families).map((f): [string, string] => [f.id, f.label])]} />
        <span className="text-xs text-muted-foreground">{q.isLoading ? "Загрузка…" : q.error ? (q.error as Error).message : r ? `посчитано ${new Date(r.asOf).toLocaleString("ru-RU", { timeZone: "Europe/Samara" })}` : ""}</span>
      </div>
      {r?.staleError && <p className="text-xs text-destructive">{BOT_BRAND_NAMES.btc} сейчас не отвечает ({r.staleError}) — показан расчёт от {new Date(r.staleAt ?? r.asOf).toLocaleString("ru-RU", { timeZone: "Europe/Samara" })}.</p>}
      {r && (
        <p className="text-xs text-muted-foreground">
          Все сигналы {BOT_BRAND_NAMES.btc}, как если бы каждую сделку вели каждым способом: тот же вход, стоп и срок. Результат — сумма по сделкам в % маржи при плече сигнала
          (1D x10, 4h и каскад x20), в скобках — в % цены. Комиссии учтены. Внутри свечи сначала проверяется стоп — результат скорее занижен, чем завышен.
        </p>
      )}
      {r && (
        <div className="grid gap-3 sm:grid-cols-2">
          {r.ways.map((w, i) => (
            <StrategyCard key={w.id} index={i + 1} label={w.id === "mm" ? `Как ${BOT_BRAND_NAMES.btc}` : w.label}
              description={w.id === "mm" ? BTCMM_DESCRIPTION : "Только расчёт: так бот пока не торгует."} saved={w.id === "mm"} active={w.id === "mm"} readOnly>
              <span className="mt-3 block space-y-1 border-t border-border pt-2 text-xs">{line(w.id, "long")}{line(w.id, "short")}</span>
            </StrategyCard>
          ))}
        </div>
      )}
      {r && <p className="text-xs text-muted-foreground">Сигналов пока мало — смотрите на число сделок в каждой строке, прежде чем делать выводы.</p>}
    </StrategySection>
  );
}
