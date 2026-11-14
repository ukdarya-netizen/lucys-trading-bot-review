// Bitcoin Margin Master — the third bot (owner 2026-11-14). Its tab in «Мой кабинет» and in the subscriber's cabinet:
// size, leverage (the signal's by default), margin reserve with the risk hint, management «Как Bitcoin MM», and the
// template per pattern family. The virtual ladders (owner only) are in BtcMmReport below — «решим в январе».
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Layers, ShieldCheck, Target, TrendingDown, Wallet } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { Seg, SizeInput, marginOf, num } from "@/components/form-bits";
import { BotBrand } from "@/components/BotBrand";

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
function LeverageChoice({ value, onChange, max, inherit }: {
  value: number | null; onChange: (v: number | null) => void; max: number; inherit: string;
}) {
  const sel = value === null ? "inherit" : (LEVS as readonly number[]).includes(value) ? String(value) : "own";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Seg value={sel} onChange={(v) => onChange(v === "inherit" ? null : v === "own" ? (value && !(LEVS as readonly number[]).includes(value) ? value : 25) : Number(v))}
        options={[["inherit", inherit], ["10", "x10"], ["20", "x20"], ["50", "x50"], ["own", "своё"]]} />
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

function RiskLine({ margin, leverage, fam, equity, asset, reserve }: {
  margin: number | null; leverage: number; fam: BtcMmFamily; equity: number | null; asset: string; reserve: number | null;
}) {
  const r = riskOf(margin, leverage, fam.maxStopPct);
  if (!r) return <span className="text-muted-foreground">риск посчитается, когда будет виден баланс</span>;
  const short = reserve !== null && r.reserve > reserve;
  return (
    <span className="block space-y-0.5">
      <span className="block">
        <TrendingDown className="mr-1 inline h-3.5 w-3.5 text-destructive" />
        при стопе теряешь до ≈ <b className="tabular">{num(r.loss)} {asset}</b>
        {equity ? <> (<b className="tabular">{num((r.loss / equity) * 100)}%</b> депозита)</> : null}
        <span className="text-muted-foreground"> · стоп до {String(fam.maxStopPct).replace(".", ",")}%, x{leverage}, позиция ≈ {num(r.notional, 0)}</span>
      </span>
      <span className={`block ${short ? "text-amber-300" : "text-muted-foreground"}`}>
        <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
        {r.reserve > 0 ? <>добор маржи до ≈ <b className="tabular">{num(r.reserve)} {asset}</b>{short ? " — больше запаса: такие сделки не откроются" : ""}</> : "добор маржи не нужен: ликвидация дальше стопа"}
      </span>
    </span>
  );
}

/** The settings card. `ownerNote` adds the note about the virtual ladders (owner only). */
export function BtcMmSettings({ saved, families, maxLeverage, savePath, onSaved, equity, asset, ownerNote }: {
  saved: BtcMm; families: BtcMmFamily[]; maxLeverage: number; savePath: string; onSaved: () => void;
  equity: number | null; asset: string; ownerNote?: boolean;
}) {
  const [s, setS] = useState(saved);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  useEffect(() => { if (!dirty) setS(saved); }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<BtcMm>) => { setS((x) => ({ ...x, ...p })); setMsg(null); };
  const setFam = (id: FamilyId, p: Partial<FamilyRule>) => { setS((x) => ({ ...x, families: { ...x.families, [id]: { ...x.families[id], ...p } } })); setMsg(null); };
  const save = useMutation({
    mutationFn: () => api(savePath, { method: "POST", body: s }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сигналов.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const marginFor = (a: Alloc) => marginOf(a.mode, a.value, equity);
  const levFor = (f: BtcMmFamily) => s.families[f.id].leverage ?? s.leverage ?? f.signalLeverage;
  const allocFor = (f: BtcMmFamily) => s.families[f.id].alloc ?? s.alloc;
  const generalMargin = marginFor(s.alloc);
  const h4 = families.find((f) => f.maxStopPct < 5);
  const d1 = families.find((f) => f.maxStopPct >= 5);

  return (
    <section className="btcmm-card space-y-5 p-4 sm:p-5" data-testid="btcmm-settings">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <BotBrand source="btc" size="md" />
        <span className="text-xs text-muted-foreground">BTC-USDT · изолированная маржа · сигналы и ведение — от бота</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-bold"><Wallet className="h-4 w-4" />Сумма в сделку</h3>
          <SizeInput mode={s.alloc.mode} value={s.alloc.value} asset={asset}
            onMode={(m) => set({ alloc: { mode: m, value: m === "percent" ? 1 : 50 } })}
            onValue={(v) => set({ alloc: { ...s.alloc, value: v } })} />
          <p className="text-xs text-muted-foreground">Маржа ≈ <b className="tabular text-foreground">{generalMargin !== null ? num(generalMargin) : "—"} {asset}</b>{s.alloc.mode === "percent" && equity === null ? " · баланс счёта пока не виден" : ""}</p>
        </div>
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-bold"><Layers className="h-4 w-4" />Плечо</h3>
          <LeverageChoice value={s.leverage} onChange={(v) => set({ leverage: v })} max={maxLeverage} inherit="из сигнала" />
          <p className="text-xs text-muted-foreground">«Из сигнала»: паттерны 1D — x10, 4h и каскад — x20. До x{maxLeverage}.</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-bold"><ShieldCheck className="h-4 w-4" />Запас на добор маржи</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Seg value={s.reserve === null ? "free" : "cap"} onChange={(v) => set({ reserve: v === "free" ? null : Math.max(10, Math.round(riskOf(generalMargin, s.leverage ?? 20, 3.68)?.reserve ?? 50)) })}
            options={[["free", "из свободного баланса"], ["cap", "не больше"]]} />
          {s.reserve !== null && (
            <label className="flex items-center border border-border">
              <input type="number" min={0} step={1} value={s.reserve} onChange={(e) => set({ reserve: Math.max(0, Number(e.target.value)) })}
                className="min-h-10 w-24 bg-transparent px-2 text-sm tabular outline-none" aria-label="Запас на добор маржи" />
              <span className="px-2 text-xs text-muted-foreground">{asset} на сделку</span>
            </label>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Бот доливает маржу, чтобы ликвидация была дальше стопа. Если для сделки нужно больше запаса — она не открывается, а в Telegram придёт, сколько добавить.
          После входа бот доливает столько, сколько нужно, чтобы стоп сработал раньше ликвидации. Добор не теряется: при стопе он возвращается вместе с остатком маржи.
        </p>
        <div className="btcmm-row space-y-2 p-3 text-xs">
          {h4 && <p><b className="btcmm-gold">Паттерны 4h и каскад</b><RiskLine margin={generalMargin} leverage={s.leverage ?? h4.signalLeverage} fam={h4} equity={equity} asset={asset} reserve={s.reserve} /></p>}
          {d1 && <p><b className="btcmm-gold">Паттерны 1D</b><RiskLine margin={generalMargin} leverage={s.leverage ?? d1.signalLeverage} fam={d1} equity={equity} asset={asset} reserve={s.reserve} /></p>}
          <p className="text-muted-foreground">Это потолок: стоп каждого сигнала свой и обычно ближе. Комиссии входа и выхода учтены.</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-bold"><Target className="h-4 w-4" />Ведение сделки</h3>
        <div className="btcmm-row p-3 text-sm">
          <b>Как Bitcoin MM</b> — 50% на цели 1 и стоп в безубыток, остаток на цели 2; закрытие по времени удержания (1D — до 45 дней, 4h — до 10 дней).
          {ownerNote && <span className="mt-1 block text-xs text-muted-foreground">Лесенки (безубыток после +1% и всё на +2% или +3%; по 25% на +1…+4%) пока считаются виртуально — панель ниже. Решим в январе.</span>}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-bold">Шаблон по паттернам</h3>
        <p className="text-xs text-muted-foreground">Каждый паттерн можно выключить, оставить одну сторону и задать свою сумму и плечо. «Как общие» — значения выше.</p>
        <div className="space-y-2">
          {families.map((f) => {
            const r = s.families[f.id];
            return (
              <div key={f.id} className="btcmm-row space-y-3 p-3" data-off={!r.on}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-3 font-bold">
                    <Switch checked={r.on} onCheckedChange={(v) => setFam(f.id, { on: v })} aria-label={`${f.label}: торговать`} />
                    <span className="btcmm-gold">{f.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">x{f.signalLeverage} в сигнале · стоп до {String(f.maxStopPct).replace(".", ",")}%</span>
                  </label>
                  <Seg value={r.sides} onChange={(v) => setFam(f.id, { sides: v })} disabled={!r.on}
                    options={[["both", "лонг и шорт"], ["long", "лонг"], ["short", "шорт"]]} />
                </div>
                {r.on && (
                  <div className="grid gap-3 text-xs md:grid-cols-2">
                    <div className="space-y-1">
                      <span className="block uppercase text-muted-foreground">Сумма</span>
                      <Seg value={r.alloc ? "own" : "same"} onChange={(v) => setFam(f.id, { alloc: v === "same" ? null : { ...s.alloc } })}
                        options={[["same", "как общая"], ["own", "своя"]]} />
                      {r.alloc && <SizeInput mode={r.alloc.mode} value={r.alloc.value} asset={asset}
                        onMode={(m) => setFam(f.id, { alloc: { mode: m, value: m === "percent" ? 1 : 50 } })}
                        onValue={(v) => setFam(f.id, { alloc: { ...r.alloc!, value: v } })} />}
                    </div>
                    <div className="space-y-1">
                      <span className="block uppercase text-muted-foreground">Плечо</span>
                      <LeverageChoice value={r.leverage} onChange={(v) => setFam(f.id, { leverage: v })} max={maxLeverage} inherit="как общее" />
                    </div>
                    <div className="md:col-span-2">
                      <span className="text-muted-foreground">Ведение: как Bitcoin MM · </span>
                      <RiskLine margin={marginFor(allocFor(f))} leverage={levFor(f)} fam={f} equity={equity} asset={asset} reserve={s.reserve} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {(dirty || save.isPending || msg) && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
            className="min-h-11 border border-[#f2b10f] bg-[#f2b10f] px-5 text-sm font-bold uppercase text-[#1a1306] disabled:opacity-40">
            {save.isPending ? "Сохраняю…" : "Сохранить"}
          </button>
          {dirty && !save.isPending && <button type="button" onClick={() => { setS(saved); setMsg(null); }} className="text-sm text-muted-foreground underline">отменить</button>}
          {msg && <span className={`text-sm ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
        </div>
      )}
    </section>
  );
}

type Cell = { n: number; pending: number; wins: number; losses: number; breakeven: number; sumPct: number; best: number | null; worst: number | null };
type Report = {
  asOf: string; feePct: number; candles: string;
  ways: Array<{ id: string; label: string }>;
  families: Array<{ id: string; label: string }>;
  groups: Array<{ family: string; side: "long" | "short"; signals: number; firstAt: string; lastAt: string; ways: Record<string, Cell> }>;
};
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")}%`);
const d8 = (v: string) => new Date(v).toLocaleDateString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", year: "2-digit" });

/** Virtual panel (owner only): each way of leading on every Bitcoin MM signal, by pattern family and side. */
export function BtcMmReport({ families }: { families: BtcMmFamily[] }) {
  const q = useQuery({ queryKey: ["btcmm-report"], queryFn: () => api<Report>("/journal/executor/btcmm-report"), refetchInterval: 5 * 60_000 });
  const r = q.data;
  const lev = (fam: string) => families.find((f) => f.id === fam)?.signalLeverage ?? 10;
  return (
    <section className="btcmm-card space-y-3 p-4 sm:p-5" data-testid="btcmm-report">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold"><Layers className="h-4 w-4" />Лесенки — виртуально</h2>
        {r && <span className="text-xs text-muted-foreground">посчитано {new Date(r.asOf).toLocaleString("ru-RU", { timeZone: "Europe/Samara" })}</span>}
      </header>
      <p className="text-xs text-muted-foreground">
        Все сигналы Bitcoin MM, как если бы сделку вели каждым способом: тот же вход, стоп и время удержания. Свечи {r?.candles ?? "15m"};
        внутри свечи сначала проверяется стоп, безубыток включается со следующей свечи — так результат скорее занижен, чем завышен.
        Комиссии {r ? String(r.feePct).replace(".", ",") : "0,1"}% цены на сделку учтены. «% маржи» — при плече сигнала. Незакрытые — «в пути».
      </p>
      {q.isLoading && <p className="text-sm text-muted-foreground">Считается…</p>}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {r && !r.groups.length && <p className="text-sm text-muted-foreground">Сигналов пока нет.</p>}
      {r && r.groups.map((g) => {
        const best = Math.max(...r.ways.map((w) => g.ways[w.id]?.n ? g.ways[w.id]!.sumPct : -Infinity));
        return (
          <div key={`${g.family}-${g.side}`} className="btcmm-row overflow-x-auto p-3">
            <p className="mb-2 text-sm">
              <b className="btcmm-gold">{r.families.find((f) => f.id === g.family)?.label ?? g.family}</b>
              {" · "}<b className={g.side === "long" ? "text-success" : "text-destructive"}>{g.side === "long" ? "лонг" : "шорт"}</b>
              <span className="text-xs text-muted-foreground"> · сигналов {g.signals} · {d8(g.firstAt)} — {d8(g.lastAt)}</span>
            </p>
            <table className="w-full min-w-[620px] text-xs">
              <thead className="text-left text-[10px] uppercase text-muted-foreground">
                <tr><th className="py-1 pr-3">Способ</th><th className="pr-3">Закрыто</th><th className="pr-3">+ / б/у / −</th><th className="pr-3">Сумма, % цены</th><th className="pr-3">В среднем</th><th className="pr-3">% маржи (x{lev(g.family)})</th><th className="pr-3">Лучшая / худшая</th></tr>
              </thead>
              <tbody>
                {r.ways.map((w) => {
                  const c = g.ways[w.id];
                  const top = c && c.n > 0 && c.sumPct === best;
                  return (
                    <tr key={w.id} className="border-t border-border/60">
                      <td className={`py-1.5 pr-3 ${top ? "btcmm-best" : ""}`}>{w.label}</td>
                      <td className="whitespace-nowrap pr-3 tabular">{c ? c.n : 0}{c?.pending ? <span className="text-muted-foreground"> (+{c.pending} в пути)</span> : null}</td>
                      <td className="whitespace-nowrap pr-3 tabular"><span className="text-success">{c?.wins ?? 0}</span> / {c?.breakeven ?? 0} / <span className="text-destructive">{c?.losses ?? 0}</span></td>
                      <td className={`pr-3 tabular font-bold ${c && c.sumPct > 0 ? "text-success" : c && c.sumPct < 0 ? "text-destructive" : ""}`}>{c?.n ? pct(c.sumPct) : "—"}</td>
                      <td className="pr-3 tabular">{c?.n ? pct(c.sumPct / c.n) : "—"}</td>
                      <td className="pr-3 tabular">{c?.n ? pct((c.sumPct / c.n) * lev(g.family)) : "—"}</td>
                      <td className="whitespace-nowrap pr-3 tabular">{c?.n ? `${pct(c.best)} / ${pct(c.worst)}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      {r && <p className="text-xs text-muted-foreground">Мало сигналов — выводы ненадёжны: смотрите на число закрытых в каждой строке.</p>}
    </section>
  );
}
