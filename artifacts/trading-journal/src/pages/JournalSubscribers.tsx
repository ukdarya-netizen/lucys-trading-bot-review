import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SubscriberAccessToggles } from "@/components/SourceToggles";
import { Check, Pause, Play, ShieldOff, X } from "lucide-react";
import { formatUsdt, toneClass } from "@/lib/performance";
import { BotBrand, BOT_BRAND_NAMES, type BotSource } from "@/components/BotBrand";
import { api, ApiFailure, positionSettingsText, runtimeText, type Subscription } from "@/lib/subscriber-api";

type SrcStat = { closed: number; pnl: number };
type Row = Subscription & { stats: { closed: number; netUsdt: number; openPositions: number; bySource: { cab: SrcStat; nihilist: SrcStat } } };

const STATUS: Record<Subscription["status"], { label: string; cls: string }> = {
  pending: { label: "Ждёт решения", cls: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  approved: { label: "Одобрен", cls: "border-success/40 bg-success/10 text-success" },
  rejected: { label: "Отклонён", cls: "border-border text-muted-foreground" },
  blocked: { label: "Заблокирован", cls: "border-destructive/40 bg-destructive/10 text-destructive" },
};


function date(value: string | null) {
  return value ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}

function normalizedSources(sources: string[] | null | undefined): BotSource[] {
  return (["cab", "nihilist"] as const).filter((source) => (sources ?? ["cab"]).includes(source));
}

function sameSources(a: BotSource[], b: BotSource[]) {
  return a.length === b.length && a.every((source, index) => source === b[index]);
}

export default function JournalSubscribers() {
  const queryClient = useQueryClient();
  const [sourceDrafts, setSourceDrafts] = useState<Record<number, BotSource[]>>({});
  const query = useQuery({
    queryKey: ["owner-subscribers"],
    queryFn: () => api<{ subscribers: Row[]; keysConfigured: boolean }>("/journal/subscribers"),
    refetchInterval: 15_000,
  });
  const currentSources = (row: Row) => normalizedSources(row.tradeSources);
  const selectedSources = (row: Row) => sourceDrafts[row.id] ?? currentSources(row);
  const saveSources = useMutation({
    mutationFn: ({ id, sources }: { id: number; sources: BotSource[] }) =>
      api<{ id: number; tradeSources: BotSource[] }>(`/journal/subscribers/${id}/sources`, {
        method: "POST",
        body: { sources },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData<{ subscribers: Row[]; keysConfigured: boolean }>(["owner-subscribers"], (current) =>
        current ? {
          ...current,
          subscribers: current.subscribers.map((row) =>
            row.id === saved.id ? { ...row, tradeSources: saved.tradeSources } : row),
        } : current);
      setSourceDrafts((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["owner-subscribers"] }),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: string }) =>
      api(`/journal/subscribers/${id}/decision`, { method: "POST", body: { decision } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["owner-subscribers"] }),
  });
  const real = useMutation({
    mutationFn: ({ id, allowed }: { id: number; allowed: boolean }) =>
      api(`/journal/subscribers/${id}/real`, { method: "POST", body: { allowed } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["owner-subscribers"] }),
  });
  const approveWithSources = async (row: Row) => {
    const sources = selectedSources(row);
    if (!sources.length) return;
    try {
      if (!sameSources(sources, currentSources(row))) {
        await saveSources.mutateAsync({ id: row.id, sources });
      }
      await decide.mutateAsync({ id: row.id, decision: "approve" });
    } catch {
      // The mutation errors are shown below the page heading.
    }
  };
  const saveApprovedSources = async (row: Row) => {
    const sources = selectedSources(row);
    if (!sources.length) return;
    if (row.tradingEnabled && !window.confirm(
      `Подписчик сейчас торгует (${row.tradingAccount === "real" ? "реальный счёт" : "демо VST"}). Изменить доступ к ботам для новых сигналов? Уже открытые позиции продолжат сопровождаться.`,
    )) return;
    try {
      await saveSources.mutateAsync({ id: row.id, sources });
    } catch {
      // The mutation error is shown below the page heading.
    }
  };
  const toggleSource = (row: Row, source: BotSource) => {
    const selected = selectedSources(row);
    const next = selected.includes(source)
      ? selected.filter((item) => item !== source)
      : [...selected, source];
    setSourceDrafts((current) => ({
      ...current,
      [row.id]: (["cab", "nihilist"] as const).filter((item) => next.includes(item)),
    }));
  };
  const rows = query.data?.subscribers ?? [];
  const pending = rows.filter((row) => row.status === "pending");
  const others = rows.filter((row) => row.status !== "pending");

  const card = (row: Row) => {
    const state = runtimeText(row);
    const selected = selectedSources(row);
    const sourcesChanged = !sameSources(selected, currentSources(row));
    return (
      <li key={row.id} className="border border-border bg-card p-4" data-testid={`subscriber-${row.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-bold">{row.name || row.email || `Пользователь #${row.id}`}</p>
            <p className="truncate text-xs text-muted-foreground">{row.email ?? "email не указан"} · заявка {date(row.requestedAt)}</p>
          </div>
          <span className={`shrink-0 border px-2 py-0.5 text-[11px] font-bold uppercase ${STATUS[row.status].cls}`}>{STATUS[row.status].label}</span>
        </div>
        {row.status === "approved" && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div><p className="text-[10px] uppercase text-muted-foreground">Ключ</p><p className={row.apiKeyVerifiedAt ? "text-success" : "text-muted-foreground"}>{row.apiKeyVerifiedAt ? `••••${row.apiKeyLast4}` : "нет"}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Стратегия</p><p>{row.strategyText ?? "—"}</p><p className="text-[11px] text-muted-foreground">{positionSettingsText(row.positionSettings, row.tradingAccount)}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Торговля</p><p className="flex items-center gap-1">{row.tradingEnabled ? <><Play className="h-3 w-3 text-success" />вкл</> : <><Pause className="h-3 w-3" />выкл</>}</p>
              <p className={`text-[11px] font-bold ${row.tradingAccount === "real" ? "text-destructive" : "text-muted-foreground"}`}>{row.tradingAccount === "real" ? "РЕАЛЬНЫЙ счёт" : "демо VST"}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Торгует по</p>
              <p className="flex flex-wrap gap-1">{currentSources(row).map((source) => <span key={source} className="border border-primary/40 px-1.5 text-[11px] font-bold text-primary">{BOT_BRAND_NAMES[source]}</span>)}</p>
              <p className="text-[11px] text-muted-foreground">{row.stats.openPositions} откр.</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Результат</p>
              {(["cab", "nihilist"] as const).map((s) => (
                <p key={s} className="text-[11px]">{s === "cab" ? BOT_BRAND_NAMES.cab : BOT_BRAND_NAMES.nihilist}: {row.stats.bySource[s].closed} сд. · <b className={`tabular ${toneClass(row.stats.bySource[s].closed ? row.stats.bySource[s].pnl : null)}`}>{row.stats.bySource[s].closed ? formatUsdt(row.stats.bySource[s].pnl) : "—"}</b></p>
              ))}</div>
          </div>
        )}
        {row.status === "approved" && <p className="mt-2 text-xs text-muted-foreground">{state.text}</p>}
        {(row.status === "pending" || row.status === "approved") && (
          <fieldset className="mt-3 border-t border-border pt-3">
            <legend className="px-1 text-xs font-bold">
              {row.status === "pending" ? "Доступ при одобрении" : "Доступные боты для подписчика"}
            </legend>
            <div className="flex flex-wrap gap-2">
              {(["cab", "nihilist"] as const).map((source) => (
                <label key={source} className={`flex min-h-11 cursor-pointer items-center border px-3 py-2 transition-colors ${
                  selected.includes(source) ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted"
                }`}>
                  <input
                    type="checkbox"
                    className="mr-2 accent-primary"
                    checked={selected.includes(source)}
                    disabled={saveSources.isPending || decide.isPending}
                    onChange={() => toggleSource(row, source)}
                    aria-label={`Доступ: ${BOT_BRAND_NAMES[source]}`}
                  />
                  <BotBrand source={source} size="xs" />
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Можно выбрать один бот или оба. Общие настройки владельца остаются верхним ограничением; открытые позиции не закрываются при смене доступа.
            </p>
            {selected.length === 0 && <p className="mt-1 text-xs text-destructive">Выберите хотя бы один бот.</p>}
            {row.status === "approved" && sourcesChanged && (
              <button type="button" disabled={saveSources.isPending || selected.length === 0}
                onClick={() => void saveApprovedSources(row)}
                className="mt-2 h-9 border border-primary/50 px-3 text-xs font-bold text-primary disabled:opacity-50">
                {saveSources.isPending ? "Сохраняю доступ…" : "Сохранить доступ"}
              </button>
            )}
          </fieldset>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {row.status === "approved" && (row.subscriptionEnded
            ? <span className="font-bold text-destructive">Подписка закончилась {date(row.subscribedUntil)} — торговля остановлена · </span>
            : <span>Подписка до {row.subscribedUntil ? date(row.subscribedUntil) : "без даты окончания"} · </span>)}
          {row.telegramChatId ? `Telegram ${row.telegramUsername ? `@${row.telegramUsername}` : row.telegramChatId}` : <span className="text-amber-300">Telegram не привязан — сообщения о подписке ему не придут</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {row.status === "pending" && <>
            <button type="button" disabled={decide.isPending || saveSources.isPending || selected.length === 0}
              onClick={() => void approveWithSources(row)}
              className="flex h-10 items-center gap-2 bg-success px-4 text-sm font-bold text-success-foreground"><Check className="h-4 w-4" />Одобрить</button>
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "reject" })}
              className="flex h-10 items-center gap-2 border border-border px-4 text-sm"><X className="h-4 w-4" />Отклонить</button>
          </>}
          {row.status === "approved" && (
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "extend" })}
              className="flex h-9 items-center gap-2 border border-success/50 px-3 text-xs font-bold text-success"><Check className="h-3.5 w-3.5" />Продлить на месяц</button>
          )}
          {row.status === "approved" && (
            <button type="button" onClick={() => real.mutate({ id: row.id, allowed: !row.realAllowed })}
              className={`flex h-9 items-center gap-2 border px-3 text-xs font-bold ${row.realAllowed ? "border-destructive/40 text-destructive" : "border-border"}`}>
              {row.realAllowed ? "Закрыть реальный счёт" : "Разрешить реальный счёт"}
            </button>
          )}
          {row.status === "approved" && (
            <button type="button" onClick={() => { if (window.confirm("Заблокировать? Торговля подписчика остановится сразу; открытые позиции останутся на его бирже со стоп-лоссом.")) decide.mutate({ id: row.id, decision: "block" }); }}
              className="flex h-9 items-center gap-2 border border-destructive/40 px-3 text-xs font-bold text-destructive"><ShieldOff className="h-3.5 w-3.5" />Заблокировать</button>
          )}
          {(row.status === "blocked" || row.status === "rejected") && (
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "unblock" })}
              className="flex h-9 items-center gap-2 border border-border px-3 text-xs font-bold"><Check className="h-3.5 w-3.5" />Одобрить</button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="page-frame mx-auto max-w-4xl space-y-5" data-testid="page-subscribers">
      <p className="text-sm text-muted-foreground">
        Любой, кто зарегистрировался, появляется здесь как заявка — и приходит вам в Telegram с кнопками «Одобрить» / «Отклонить».
        Одобрение даёт подписку на месяц, «Продлить на месяц» добавляет месяц к оставшемуся. Подписчику о каждом решении и об окончании подписки пишет бот (если он привязал Telegram в кабинете). После одобрения человек сам вводит ключ BingX,
        выбирает стратегию и нажимает «Старт». По умолчанию торговля идёт на демо-счёте BingX VST; реальный счёт человек может выбрать, только если вы его разрешили. «Закрыть реальный счёт» сразу останавливает новые входы, открытые сделки бот доводит до закрытия. Ключи хранятся зашифрованными, их не видно даже здесь.
      </p>
      <SubscriberAccessToggles />
      {query.data && !query.data.keysConfigured && (
        <p className="border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-200">
          Не задан секрет SUBSCRIBER_KEYS_SECRET — подписчики не смогут сохранить ключи. Добавьте его в Secrets Replit (длинная случайная строка, 32+ символа).
        </p>
      )}
      {(decide.error || saveSources.error) && <p role="alert" className="text-sm text-destructive">
        {((decide.error || saveSources.error) instanceof ApiFailure) ? (decide.error || saveSources.error as ApiFailure).message : "Не удалось сохранить доступ или решение"}
      </p>}
      {query.isLoading ? <div className="h-32 animate-pulse border border-border bg-card" /> : query.error ? (
        <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить подписчиков.</p>
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-bold">Новые заявки {pending.length > 0 && <span className="ml-1 bg-amber-400 px-1.5 text-xs text-black">{pending.length}</span>}</h2>
            {pending.length ? <ul className="space-y-2">{pending.map(card)}</ul> : <p className="text-sm text-muted-foreground">Новых заявок нет.</p>}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-bold">Подписчики</h2>
            {others.length ? <ul className="space-y-2">{others.map(card)}</ul> : <p className="text-sm text-muted-foreground">Пока никого.</p>}
          </div>
        </>
      )}
    </section>
  );
}
