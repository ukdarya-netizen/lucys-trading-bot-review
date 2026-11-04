// On/off moved off «CAB и Нигилист» (owner 2026-11-03): the main VST account's trading per bot
// and BTC live in «Мой кабинет»; which bots subscribers may choose — on «Подписчики».
// Each switch saves at once.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { useExecutor, type Status } from "@/components/executor-ui";
import { InboxLine } from "@/components/SourceSettings";
import { defaultBtc } from "@/components/BtcCard";
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

/** «Мой кабинет», owner only: the main VST account — which bots it trades, the trade size, whether it opens BTC. */
export function MainAccountToggles() {
  const ex = useExecutor();
  const t = useToggle(() => void ex.refetch());
  const cabStrategy = useQuery({ queryKey: ["owner-trading-strategy"], queryFn: () => api<{ strategyText: string }>("/journal/trading-strategy") });
  const d = ex.data;
  if (!d) return null;
  const account = d.accounts[0];
  return (
    <section className="space-y-3 border border-primary/40 bg-card p-5" data-testid="main-account-toggles">
      <h2 className="text-base font-bold">Основной счёт{account ? ` · ${account.env === "real" ? "реальный" : "демо VST"}` : ""}</h2>
      <p className="text-xs text-muted-foreground">
        Твой единственный торговый счёт: здесь включается торговля и задаётся размер сделки. Как вести сделки и плечо BTC — на странице «CAB и Нигилист».
        Выключение останавливает только новые входы: открытые сделки бот доводит до закрытия.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SOURCES.map((s) => {
          const settings = d[s].settings;
          const btc = d.btc.settings.find((b) => b.source === s) ?? defaultBtc(s);
          const strategy = s === "cab" ? cabStrategy.data?.strategyText ?? "…" : d.nihilist.strategies.find((x) => x.id === d.nihilist.settings.strategy)?.label ?? d.nihilist.settings.strategy;
          return (
            <div key={s} className="space-y-3 border border-border bg-background p-4">
              <p className="font-bold">{NAME[s]}</p>
              <p className="text-xs">Сигналы: <InboxLine name={NAME[s]} info={d.inbox?.[s]} /></p>
              <p className="text-xs">Стратегия: <b>{strategy}</b> · <Link href="/journal/bots" onClick={() => { try { localStorage.setItem("strategies-tab", s); } catch { /* private mode */ } }} className="text-primary underline">изменить</Link></p>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Открывать сделки
                  <span className={`block text-xs ${settings.enabled ? "text-success" : "text-destructive"}`}>{settings.enabled ? "включено" : "выключено"}</span>
                </span>
                <Switch checked={settings.enabled} disabled={t.pending} aria-label={`Открывать сделки по сигналам ${NAME[s]}`}
                  onCheckedChange={(v) => t.save({ path: `/journal/executor/source-settings/${s}`, body: { ...settings, enabled: v } })} />
              </label>
              <SizeEditor source={s} d={d} onSaved={() => void ex.refetch()} />
              <label className={`flex items-center justify-between gap-3 text-sm ${settings.enabled ? "" : "opacity-50"}`}>
                <span>
                  Открывать BTC
                  <span className={`block text-xs ${btc.enabled ? "text-success" : "text-destructive"}`}>{btc.enabled ? `включено · ${btc.leverage}x` : "выключено"}</span>
                </span>
                <Switch checked={btc.enabled} disabled={t.pending} aria-label={`Открывать BTC по сигналам ${NAME[s]}`}
                  onCheckedChange={(v) => t.save({ path: "/journal/executor/btc-settings", body: { ...btc, enabled: v, allocationMode: btc.allocationMode ?? "same" } })} />
              </label>
            </div>
          );
        })}
      </div>
      {t.msg && <p className={`text-sm ${t.msg.bad ? "text-destructive" : "text-success"}`}>{t.msg.text}</p>}
    </section>
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
