// «Мой кабинет» (owner 2026-11-04): every setting of the main account in one place — one tab per signal
// bot (as the subscriber cabinet): open trades on/off, trade size, how trades are led, Bitcoin.
// «CAB и Нигилист» only shows the strategies' results. Which bots subscribers may choose — on «Подписчики».
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Switch } from "@/components/ui/switch";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { LoadingOrError, useExecutor, type Status } from "@/components/executor-ui";
import { InboxLine } from "@/components/SourceSettings";
import { BtcCard, defaultBtc } from "@/components/BtcCard";
import { OwnerStrategyCard } from "@/components/owner-strategy-card";
import { NihilistSideSettings } from "@/components/NihilistSideSettings";
import { SizeInput, marginOf, num } from "@/components/form-bits";
import { BotBrand, BOT_BRAND_NAMES, type BotSource } from "@/components/BotBrand";

const LEVERAGE = 10;

type Source = BotSource;
const NAME = BOT_BRAND_NAMES;
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

/** «Мой кабинет», owner only. Owner 2026-11-06: each bot has its OWN account (PAPER / VST / REAL), its own
 * on/off and its own size — CAB can trade REAL while Nihilist stays on VST, or one bot can be off. One BingX key. */
export function MainAccountToggles() {
  const ex = useExecutor();
  const acc = useOwnerAccount();
  const [tab, setTab] = useState<Source>(() => { try { return localStorage.getItem("cabinet-tab") === "nihilist" ? "nihilist" : "cab"; } catch { return "cab"; } });
  const choose = (t: Source) => { setTab(t); try { localStorage.setItem("cabinet-tab", t); } catch { /* private mode */ } };
  const d = ex.data;
  // Never an empty page: while loading or on an error, say so (owner 2026-11-04).
  if (!d) return <LoadingOrError q={ex} />;
  const refetch = () => { void ex.refetch(); void acc.refetch(); };
  const bots = acc.data?.bots;
  const mode = bots?.[tab].mode ?? "vst";
  const account = accountOfMode(d, mode);
  const asset = assetOf(mode);
  return (
    <div className="space-y-4" data-testid="main-account-toggles">
      <section className="space-y-2 border border-primary/40 bg-card p-5">
        <h2 className="text-base font-bold">Мои счета</h2>
        <p className="text-xs text-muted-foreground">
          У каждого бота свой счёт, своё включение и свой размер сделки — настраиваются независимо во вкладке бота.
          Сравнить результаты стратегий —{" "}
          <Link href="/journal/bots" onClick={() => { try { localStorage.setItem("strategies-tab", tab); } catch { /* private mode */ } }} className="text-primary underline">на странице «Боты»</Link>.
        </p>
        {bots && (
          <div className="grid gap-2 sm:grid-cols-2">
            {SOURCES.map((s) => (
              <button key={s} type="button" onClick={() => choose(s)} className="flex items-center justify-between gap-2 border border-border bg-background p-3 text-left">
                <BotBrand source={s} size="xs" />
                <span className="text-right text-xs">
                  <b>{MODE_TEXT[bots[s].mode]}</b>
                  <span className={`block ${bots[s].enabled && !bots[s].blockedReason ? "text-success" : "text-destructive"}`}>
                    {bots[s].enabled ? (bots[s].blockedReason ? "включено, но заблокировано" : "торгует") : "не торгует"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <OwnerKeyCard q={acc} onSaved={refetch} />
      <div role="tablist" className="flex gap-1 border-b border-border">
        {SOURCES.map((s) => (
          <button key={s} role="tab" type="button" aria-label={NAME[s]} aria-selected={tab === s} onClick={() => choose(s)}
            className={`-mb-px flex min-h-14 min-w-0 flex-1 items-center justify-center border border-b-0 px-2 sm:px-5 ${tab === s ? "border-border bg-card" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            <BotBrand source={s} size="sm" />
          </button>
        ))}
      </div>
      {acc.data ? <BotTrading key={`t-${tab}`} source={tab} d={d} info={acc.data} onSaved={refetch} />
        : <p className={`text-sm ${acc.error ? "text-destructive" : "text-muted-foreground"}`}>{acc.error ? `Счета не загрузились: ${(acc.error as Error).message}` : "Загрузка счетов…"}</p>}
      {tab === "cab" ? <OwnerStrategyCard /> : <NihilistStrategyChoice d={d} onSaved={refetch} />}
      <BtcCard key={`b-${tab}-${mode}`} title={`Биткоин (BTC) · ${NAME[tab]}`}
        saved={d.btc.settings.find((b) => b.source === tab) ?? defaultBtc(tab)} maxLeverage={d.btc.maxLeverage}
        savePath="/journal/executor/btc-settings" onSaved={refetch}
        otherMargin={marginOf(d[tab].settings.allocationMode, d[tab].settings.allocationValue, account?.balance?.equity ?? null)}
        otherText={sizeText(d[tab].settings.allocationMode, d[tab].settings.allocationValue, asset)}
        equity={account?.balance?.equity ?? null} asset={asset}
        note={tab === "cab" ? `Ведение BTC — по правилам ${NAME.cab} при любой стратегии.` : `Ведение BTC — по выбранной стратегии ${NAME.nihilist}.`} />
    </div>
  );
}

type OwnerMode = "paper" | "vst" | "real";
type OwnerBot = { mode: OwnerMode; enabled: boolean; blockedReason: string | null; openByMode: Partial<Record<OwnerMode, number>> };
type OwnerAccount = {
  mode: OwnerMode; keyLast4: string | null; verifiedAt: string | null; error: string | null;
  secretsKey: boolean; secretsOff: boolean; keysStorable: boolean; openTrades: number;
  bots: Record<Source, OwnerBot>;
};
const MODE_TEXT: Record<OwnerMode, string> = { paper: "PAPER", vst: "VST (демо)", real: "REAL" };
const MODE_HINT: Record<OwnerMode, string> = {
  paper: "Бумажная торговля: виртуальные 10 000 USDT, настоящие цены BingX, на биржу ничего не уходит. Ключ не нужен.",
  vst: "Демо-счёт BingX (VST): настоящая биржа, виртуальные деньги VST.",
  real: "Реальный счёт BingX: настоящие деньги (USDT).",
};
const assetOf = (m: OwnerMode) => (m === "real" ? "USDT" : m === "paper" ? "USDT (бумажные)" : "VST");
const accountOfMode = (d: Status, m: OwnerMode) => d.accounts.find((a) => a.id === `owner-${m}`) ?? null;
function useOwnerAccount() {
  return useQuery({ queryKey: ["owner-account"], queryFn: () => api<OwnerAccount>("/journal/executor/owner-account"), refetchInterval: 15_000 });
}

/** One BingX key for the owner — it serves both VST and REAL (owner 2026-11-06). */
function OwnerKeyCard({ q, onSaved }: { q: ReturnType<typeof useOwnerAccount>; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => api<OwnerAccount & { equity: number | null }>("/journal/executor/owner-account", { method: "POST", body: { apiKey: key, apiSecret: secret } }),
    onSuccess: (r) => { setKey(""); setSecret(""); setMsg({ text: `Ключ сохранён${r.equity !== null ? ` · баланс ${num(r.equity)}` : ""}.`, bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const d = q.data;
  if (!d) return null;
  const now = d.keyLast4 ? `ключ ••••${d.keyLast4}${d.verifiedAt ? ", проверен" : ""}`
    : d.secretsKey && !d.secretsOff ? "ключ из Secrets (BINGX_API_KEY) — только для VST; для REAL вставьте ключ здесь" : "ключа нет";
  return (
    <section className="space-y-2 border border-border bg-card p-4" data-testid="owner-key">
      <h2 className="font-bold">Ключ BingX</h2>
      <p className="text-sm">Сейчас: {now}.</p>
      <p className="text-xs text-muted-foreground">Один ключ работает и для VST, и для REAL. PAPER ключа не требует.</p>
      <input type="text" autoComplete="off" spellCheck={false} placeholder="API Key BingX" value={key} onChange={(e) => { setKey(e.target.value.trim()); setMsg(null); }}
        className="min-h-10 w-full border border-border bg-background px-3 text-sm" aria-label="API Key BingX" />
      <input type="password" autoComplete="off" placeholder="Secret Key BingX" value={secret} onChange={(e) => { setSecret(e.target.value.trim()); setMsg(null); }}
        className="min-h-10 w-full border border-border bg-background px-3 text-sm" aria-label="Secret Key BingX" />
      <p className="text-xs text-muted-foreground">Права ключа: только «чтение» и «торговля фьючерсами». Ключ с выводом или переводом средств не примется. Хранится зашифрованным.</p>
      {!d.keysStorable && <p className="text-xs text-destructive">В Secrets нет SUBSCRIBER_KEYS_SECRET — без него ключ не сохранить.</p>}
      {d.error && !msg && <p className="text-xs text-destructive">Последняя ошибка: {d.error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={save.isPending || !key || !secret} onClick={() => save.mutate()}
          className="min-h-10 border border-primary bg-primary px-5 text-xs font-bold uppercase text-primary-foreground disabled:opacity-40">
          {save.isPending ? "Проверяю…" : "Проверить и сохранить"}
        </button>
        {msg && <span className={`text-sm ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
      </div>
    </section>
  );
}

/** One bot's account: PAPER / VST / REAL (owner 2026-11-06). Open trades stay where they are and are led to the end. */
function BotAccountChoice({ source, info, onSaved }: { source: Source; info: OwnerAccount; onSaved: () => void }) {
  const bot = info.bots[source];
  const [mode, setMode] = useState<OwnerMode>(bot.mode);
  const [confirmReal, setConfirmReal] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setMode(bot.mode); }, [bot.mode]);
  const save = useMutation({
    mutationFn: () => api<OwnerAccount & { equity: number | null }>("/journal/executor/owner-account", { method: "POST", body: { source, mode, confirmReal } }),
    onSuccess: (r) => { setConfirmReal(false); setMsg({ text: `${NAME[source]} теперь на ${MODE_TEXT[mode]}${r.equity !== null ? ` · баланс ${num(r.equity)}` : ""}. Действует для новых сигналов.`, bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const changed = mode !== bot.mode;
  const elsewhere = (Object.entries(bot.openByMode) as Array<[OwnerMode, number]>).filter(([m, n]) => n > 0 && m !== mode);
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase text-muted-foreground">Счёт для сделок {NAME[source]}</p>
      <div className="inline-grid grid-cols-3 border border-border">
        {(["paper", "vst", "real"] as const).map((x) => (
          <button key={x} type="button" aria-pressed={mode === x} onClick={() => { setMode(x); setMsg(null); }}
            className={`min-h-10 px-4 text-xs font-bold ${mode === x ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{MODE_TEXT[x]}</button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{MODE_HINT[mode]}</p>
      {elsewhere.map(([m, n]) => (
        <p key={m} className="text-xs text-amber-200">На {MODE_TEXT[m]} открыто сделок {NAME[source]}: {n}. Они остаются там, бот ведёт их до закрытия; новые пойдут на {MODE_TEXT[mode]}.</p>
      ))}
      {changed && mode === "real" && (
        <label className="flex items-start gap-2 text-sm text-amber-200">
          <input type="checkbox" checked={confirmReal} onChange={(e) => setConfirmReal(e.target.checked)} className="mt-1" />
          <span>Понимаю: бот будет открывать сделки {NAME[source]} на реальные деньги.</span>
        </label>
      )}
      {(changed || msg) && (
        <div className="flex flex-wrap items-center gap-3">
          {changed && <button type="button" disabled={save.isPending || (mode === "real" && !confirmReal)} onClick={() => save.mutate()}
            className="min-h-10 border border-primary bg-primary px-5 text-xs font-bold uppercase text-primary-foreground disabled:opacity-40">
            {save.isPending ? "Проверяю счёт…" : `Перевести на ${MODE_TEXT[mode]}`}
          </button>}
          {msg && <span className={`text-sm ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}

/** One bot's new trades on/off — this bot only (owner 2026-11-06). */
function BotSwitch({ source, info, onSaved }: { source: Source; info: OwnerAccount; onSaved: () => void }) {
  const bot = info.bots[source];
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const m = useMutation({
    mutationFn: (enabled: boolean) => api<OwnerAccount>(`/journal/executor/owner-bot/${source}/trading`, { method: "POST", body: { enabled } }),
    onSuccess: (_r, enabled) => { setMsg({ text: enabled ? "Включено. Новые сигналы будут открываться." : "Выключено. Открытые сделки бот ведёт до закрытия.", bad: false }); onSaved(); },
    onError: (e) => setMsg({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const live = bot.enabled && !bot.blockedReason;
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          <b>Открывать новые сделки {NAME[source]}</b> · {MODE_TEXT[bot.mode]}
          <span className={`block text-xs ${live ? "text-success" : "text-destructive"}`}>{!bot.enabled ? "выключено" : bot.blockedReason ? "включено, но заблокировано" : "включено"}</span>
        </span>
        <Switch checked={bot.enabled} disabled={m.isPending || (!bot.enabled && Boolean(bot.blockedReason))} aria-label={`Открывать новые сделки ${NAME[source]}`}
          onCheckedChange={(v) => m.mutate(v)} />
      </label>
      <p className="text-xs text-muted-foreground">Только этот бот: второй не затрагивается. Выключение не закрывает открытые сделки — бот ведёт их до закрытия.</p>
      {bot.blockedReason && <p className="text-xs text-amber-300">{bot.blockedReason}</p>}
      {msg && <p className={`text-xs ${msg.bad ? "text-destructive" : "text-success"}`}>{msg.text}</p>}
    </div>
  );
}

/** One bot: its signals, its account, its on/off, its trade size (owner 2026-11-06: all independent of the other bot). */
function BotTrading({ source, d, info, onSaved }: { source: Source; d: Status; info: OwnerAccount; onSaved: () => void }) {
  const mode = info.bots[source].mode;
  return (
    <section className="space-y-4 border border-border bg-card p-4">
      <p className="text-xs">Сигналы: <InboxLine name={NAME[source]} info={d.inbox?.[source]} /></p>
      <BotAccountChoice source={source} info={info} onSaved={onSaved} />
      <div className="border-t border-border pt-3"><BotSwitch source={source} info={info} onSaved={onSaved} /></div>
      <SizeEditor source={source} d={d} mode={mode} onSaved={onSaved} />
    </section>
  );
}

/** Nihilist: how its trades are led (saves on click). */
function NihilistStrategyChoice({ d, onSaved }: { d: Status; onSaved: () => void }) {
  const client = useQueryClient();
  return (
    <NihilistSideSettings saved={d.nihilist.sideSettings ?? {
      sides: "both", longStrategy: d.nihilist.settings.strategy, shortStrategy: d.nihilist.settings.strategy,
    }} strategies={d.nihilist.strategies} savePath="/journal/executor/nihilist-sides"
      onSaved={(settings) => {
        client.setQueryData<Status>(["executor-status"], (old) => old ? { ...old, nihilist: { ...old.nihilist, sideSettings: settings } } : old);
        onSaved();
      }} />
  );
}

/** Trade size of the main account for one bot (not BTC): % of the balance or an amount, 10x isolated. */
function SizeEditor({ source, d, mode: accountMode, onSaved }: { source: Source; d: Status; mode: OwnerMode; onSaved: () => void }) {
  const saved = d[source].settings;
  const [mode, setMode] = useState(saved.allocationMode);
  const [value, setValue] = useState(saved.allocationValue);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setMode(saved.allocationMode); setValue(saved.allocationValue); }, [saved.allocationMode, saved.allocationValue]);
  const equity = accountOfMode(d, accountMode)?.balance?.equity ?? null;
  const asset = assetOf(accountMode);
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
