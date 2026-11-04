// «Мой кабинет» (owner 2026-11-04): every setting of the main account in one place — one tab per signal
// bot (as the subscriber cabinet): open trades on/off, trade size, how trades are led, Bitcoin.
// «CAB и Нигилист» only shows the strategies' results. Which bots subscribers may choose — on «Подписчики».
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { useExecutor, type Status } from "@/components/executor-ui";
import { InboxLine } from "@/components/SourceSettings";
import { BtcCard, defaultBtc } from "@/components/BtcCard";
import { OwnerStrategyCard } from "@/components/owner-strategy-card";
import { StrategyCard, StrategySection, NIHILIST_DESCRIPTIONS } from "@/components/StrategyCard";
import { SizeInput, marginOf, num } from "@/components/form-bits";

const LEVERAGE = 10;

type Source = "cab" | "nihilist";
const NAME: Record<Source, string> = { cab: "CAB", nihilist: "Нигилист" };
const SOURCES: Source[] = ["cab", "nihilist"];

function useToggle(onDone: () => void) {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const m = useMutation({
    mutationFn: (x: { path: string; body: unknown }) => api(x.path, { method: "POST", body: x.body }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сигналов.", bad: false }); onDone(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  return { save: m.mutate, pending: m.isPending, msg };
}

const sizeText = (mode: "percent" | "amount", value: number, asset: string) => (mode === "percent" ? `${value}% от баланса` : `${value} ${asset}`);

/** «Мой кабинет», owner only: the main account — per bot: trading on/off, size, strategy, Bitcoin. */
export function MainAccountToggles() {
  const ex = useExecutor();
  const [tab, setTab] = useState<Source>(() => { try { return localStorage.getItem("cabinet-tab") === "nihilist" ? "nihilist" : "cab"; } catch { return "cab"; } });
  const choose = (t: Source) => { setTab(t); try { localStorage.setItem("cabinet-tab", t); } catch { /* private mode */ } };
  const d = ex.data;
  if (!d) return null;
  const account = d.accounts[0];
  const refetch = () => void ex.refetch();
  return (
    <div className="space-y-4" data-testid="main-account-toggles">
      <section className="space-y-1 border border-primary/40 bg-card p-5">
        <h2 className="text-base font-bold">Основной счёт{account ? ` · ${account.env === "real" ? "реальный" : "демо VST"}` : ""}</h2>
        <p className="text-xs text-muted-foreground">
          Все настройки счёта — здесь, отдельно для каждого бота. Сравнить результаты стратегий — на странице{" "}
          <Link href="/journal/bots" onClick={() => { try { localStorage.setItem("strategies-tab", tab); } catch { /* private mode */ } }} className="text-primary underline">«CAB и Нигилист»</Link>.
          Изменения действуют для новых сделок; открытые бот доводит до закрытия по своей стратегии.
        </p>
      </section>
      <div role="tablist" className="flex gap-1 border-b border-border">
        {SOURCES.map((s) => (
          <button key={s} role="tab" type="button" aria-selected={tab === s} onClick={() => choose(s)}
            className={`-mb-px min-h-11 border border-b-0 px-5 text-sm font-bold ${tab === s ? "border-border bg-card" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {NAME[s]}
          </button>
        ))}
      </div>
      <BotTrading key={`t-${tab}`} source={tab} d={d} onSaved={refetch} />
      {tab === "cab" ? <OwnerStrategyCard /> : <NihilistStrategyChoice d={d} onSaved={refetch} />}
      <BtcCard key={`b-${tab}`} title={`Биткоин (BTC) в сделках ${tab === "cab" ? "CAB" : "Нигилиста"}`}
        saved={d.btc.settings.find((b) => b.source === tab) ?? defaultBtc(tab)} maxLeverage={d.btc.maxLeverage}
        savePath="/journal/executor/btc-settings" onSaved={refetch}
        otherMargin={marginOf(d[tab].settings.allocationMode, d[tab].settings.allocationValue, account?.balance?.equity ?? null)}
        otherText={sizeText(d[tab].settings.allocationMode, d[tab].settings.allocationValue, account?.env === "real" ? "USDT" : "VST")}
        equity={account?.balance?.equity ?? null} asset={account?.env === "real" ? "USDT" : "VST"}
        note={tab === "cab" ? "Ведение BTC — по правилам CAB для BTC при любой стратегии." : "Ведение BTC — по выбранной стратегии Нигилиста."} />
    </div>
  );
}

/** One bot: its signals, open trades on/off (saves at once), trade size. */
function BotTrading({ source, d, onSaved }: { source: Source; d: Status; onSaved: () => void }) {
  const t = useToggle(onSaved);
  const settings = d[source].settings;
  return (
    <section className="space-y-3 border border-border bg-card p-4">
      <p className="text-xs">Сигналы: <InboxLine name={NAME[source]} info={d.inbox?.[source]} /></p>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Открывать сделки по сигналам {NAME[source]}
          <span className={`block text-xs ${settings.enabled ? "text-success" : "text-destructive"}`}>{settings.enabled ? "включено" : "выключено"}</span>
        </span>
        <Switch checked={settings.enabled} disabled={t.pending} aria-label={`Открывать сделки по сигналам ${NAME[source]}`}
          onCheckedChange={(v) => t.save({ path: `/journal/executor/source-settings/${source}`, body: { ...settings, enabled: v } })} />
      </label>
      {t.msg && <p className={`text-sm ${t.msg.bad ? "text-destructive" : "text-success"}`}>{t.msg.text}</p>}
      <SizeEditor source={source} d={d} onSaved={onSaved} />
    </section>
  );
}

/** Nihilist: how its trades are led (saves on click). */
function NihilistStrategyChoice({ d, onSaved }: { d: Status; onSaved: () => void }) {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const pick = useMutation({
    mutationFn: (strategy: string) => api("/journal/executor/source-settings/nihilist", { method: "POST", body: { strategy } }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сделок; открытые закрываются по своей стратегии.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const current = d.nihilist.settings.strategy;
  const strategies = d.nihilist.strategies;
  return (
    <StrategySection title="Как вести сделки Нигилиста" current={strategies.find((x) => x.id === current)?.label ?? current} message={msg}>
      <div className="grid gap-3 sm:grid-cols-2">
        {strategies.map((st, i) => (
          <StrategyCard key={st.id} index={i + 1} label={st.label} description={NIHILIST_DESCRIPTIONS[st.id]}
            saved={current === st.id} active={current === st.id} disabled={pick.isPending}
            onClick={() => { if (current !== st.id) pick.mutate(st.id); }} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Если Нигилист закрывает сделку по сроку, бот закрывает её при любой стратегии.</p>
    </StrategySection>
  );
}

/** Trade size of the main account for one bot (not BTC): % of the balance or an amount, 10x isolated. */
function SizeEditor({ source, d, onSaved }: { source: Source; d: Status; onSaved: () => void }) {
  const saved = d[source].settings;
  const [mode, setMode] = useState(saved.allocationMode);
  const [value, setValue] = useState(saved.allocationValue);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setMode(saved.allocationMode); setValue(saved.allocationValue); }, [saved.allocationMode, saved.allocationValue]);
  const equity = d.accounts[0]?.balance?.equity ?? null;
  const asset = d.accounts[0]?.env === "real" ? "USDT" : "VST";
  const margin = marginOf(mode, value, equity);
  const dirty = mode !== saved.allocationMode || value !== saved.allocationValue;
  const save = useMutation({
    mutationFn: () => api(`/journal/executor/source-settings/${source}`, { method: "POST", body: { ...saved, allocationMode: mode, allocationValue: value } }),
    onSuccess: () => { setMsg({ text: "Сохранено. Действует для новых сделок.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs uppercase text-muted-foreground">Размер сделки (кроме BTC)</p>
      <SizeInput mode={mode} value={value} asset={asset}
        onMode={(m) => { setMode(m); setValue(m === "percent" ? 1 : Math.max(10, Math.round(margin ?? 10))); setMsg(null); }}
        onValue={(v) => { setValue(v); setMsg(null); }} />
      <p className="text-xs">Маржа ≈ <b className="tabular">{margin !== null ? num(margin) : "—"} {asset}</b> · позиция ≈ <b className="tabular">{margin !== null ? num(margin * LEVERAGE) : "—"} {asset}</b> · плечо {LEVERAGE}x, изолированная</p>
      {(dirty || msg) && (
        <div className="flex flex-wrap items-center gap-3">
          {dirty && <>
            <button type="button" disabled={save.isPending} onClick={() => save.mutate()}
              className="min-h-10 border border-primary bg-primary px-4 text-xs font-bold uppercase text-primary-foreground disabled:opacity-40">{save.isPending ? "Сохраняю…" : "Сохранить"}</button>
            <button type="button" onClick={() => { setMode(saved.allocationMode); setValue(saved.allocationValue); }} className="text-xs text-muted-foreground underline">отменить</button>
          </>}
          {msg && <span className={`text-xs ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}

/** «Подписчики», owner only: which bots subscribers may choose in their cabinet. */
export function SubscriberAccessToggles() {
  const ex = useExecutor();
  const t = useToggle(() => void ex.refetch());
  const d = ex.data;
  if (!d) return null;
  return (
    <section className="space-y-3 border border-border bg-card p-5" data-testid="subscriber-access">
      <h2 className="text-base font-bold">Какие боты доступны подписчикам</h2>
      <p className="text-xs text-muted-foreground">Выключенный бот подписчик не сможет выбрать в своём кабинете.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SOURCES.map((s) => {
          const settings = d[s].settings;
          return (
            <label key={s} className="flex items-center justify-between gap-3 border border-border bg-background p-4 text-sm">
              <span>
                <span className="block font-bold">{NAME[s]}</span>
                <span className={`text-xs ${settings.subscribers ? "text-success" : "text-destructive"}`}>{settings.subscribers ? "доступен подписчикам" : "закрыт для подписчиков"}</span>
              </span>
              <Switch checked={settings.subscribers} disabled={t.pending} aria-label={`${NAME[s]} доступен подписчикам`}
                onCheckedChange={(v) => t.save({ path: `/journal/executor/source-settings/${s}`, body: { ...settings, subscribers: v } })} />
            </label>
          );
        })}
      </div>
      {t.msg && <p className={`text-sm ${t.msg.bad ? "text-destructive" : "text-success"}`}>{t.msg.text}</p>}
    </section>
  );
}
