// Bot Health (owner 2026-11-03): is the trading bot alive and doing its job — problems first,
// then the bot, sources, BingX, trades that need attention, errors of 24 h and Telegram.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, Radio, Send, Server, XCircle } from "lucide-react";
import { api } from "@/lib/subscriber-api";
import { InboxLine, type InboxInfo } from "@/components/SourceSettings";

type Sync = { at: number | null; ok: boolean | null; error: string | null };
type TradeRef = { id: number; accountId: string; source: string; symbol: string; side: string; status: string; since: string | null };
type Health = {
  asOf: string; enabled: boolean; running: boolean; startedAt: string | null;
  reconcile: { at: string | null; ms: number | null; ok: boolean | null; error: string | null };
  status: "green" | "yellow" | "red"; problems: Array<{ level: "red" | "yellow"; text: string }>;
  sources: Array<{ source: string; name: string; inbox: InboxInfo; open: number; sync: Sync }>;
  accounts: Array<{
    id: string; label: string; env: string; hedge: boolean | null;
    balance: { ok: true; equity: number; available: number } | { ok: false; error: string };
    requests: number; rate: Array<{ path: string; lastHour: number; lastAt: number | null }>; lastError: { at: number; message: string } | null;
  }>;
  stuck: TradeRef[]; unannounced: TradeRef[];
  errors: Array<{ kind: string; text: string; n: number; lastAt: string | null; lastSymbol: string | null; lastMessage: string | null }>;
  failed: Array<{ reason: string; text: string; n: number }>;
  telegram: { pending: number; oldestPendingAt: string | null; failed24h: number; lastError: string | null; lastErrorAt: string | null; lastSentAt: string | null } | null;
};

const when = (v: string | number | null) => (v ? new Date(v).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const ago = (v: string | number | null) => {
  if (!v) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 1000));
  return s < 60 ? `${s} с назад` : s < 3600 ? `${Math.round(s / 60)} мин назад` : `${Math.round(s / 3600)} ч назад`;
};
const money = (v: number, asset: string) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${asset}`;
const short = (path: string) => path.replace("/openApi/swap/", "").replace(/^v\d\//, "");

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 font-bold">{icon}{title}</h2>
      {children}
    </section>
  );
}
const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex flex-wrap justify-between gap-2 border-t border-border py-1.5 text-sm first:border-t-0"><span className="text-muted-foreground">{k}</span><span className="text-right">{children}</span></div>
);
const Ok = ({ ok, children }: { ok: boolean | null; children: ReactNode }) => (
  <span className={ok === null ? "text-muted-foreground" : ok ? "text-success" : "text-destructive"}>{children}</span>
);

function TradeList({ rows }: { rows: TradeRef[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((t) => (
        <li key={t.id} className="flex flex-wrap gap-x-3 tabular">
          <b>{t.source} · {t.symbol.replace(/-?USDT$/, "")}</b>
          <span className={t.side === "long" ? "text-success" : "text-destructive"}>{t.side === "long" ? "лонг" : "шорт"}</span>
          <span>{t.status}</span><span className="text-muted-foreground">с {when(t.since)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function BotHealth() {
  const q = useQuery({ queryKey: ["executor-health"], queryFn: () => api<Health>("/journal/executor/health"), refetchInterval: 15_000 });
  const h = q.data;
  if (!h) return <p className="text-sm text-muted-foreground">{q.error ? `Не удалось загрузить: ${(q.error as Error).message}` : "Загрузка…"}</p>;
  const tone = h.status === "green" ? "border-success/50 bg-success/10" : h.status === "yellow" ? "border-amber-400/50 bg-amber-400/10" : "border-destructive/60 bg-destructive/10";
  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="bot-health">
      <section className={`border p-4 ${tone}`}>
        <p className="flex items-center gap-2 text-lg font-bold">
          {h.status === "green" ? <CheckCircle2 className="h-5 w-5 text-success" /> : h.status === "yellow" ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <XCircle className="h-5 w-5 text-destructive" />}
          {h.status === "green" ? "Всё в порядке" : h.status === "yellow" ? "Работает, есть замечания" : "Есть проблема"}
        </p>
        {h.problems.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {h.problems.map((p, i) => <li key={i} className={p.level === "red" ? "text-destructive" : "text-amber-200"}>• {p.text}</li>)}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Обновляется каждые 15 с · {when(h.asOf)}</p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card icon={<Activity className="h-4 w-4 text-primary" />} title="Торговый бот">
          <div>
            <Row k="Состояние"><Ok ok={h.enabled && h.running}>{!h.enabled ? "выключен (EXECUTOR_V2)" : h.running ? "работает" : "не запустился"}</Ok></Row>
            <Row k="Запущен">{when(h.startedAt)}</Row>
            <Row k="Последняя сверка с биржей"><Ok ok={h.reconcile.ok}>{ago(h.reconcile.at)}</Ok>{h.reconcile.ms !== null ? <span className="text-muted-foreground"> · {(h.reconcile.ms / 1000).toFixed(1)} с</span> : null}</Row>
            {h.reconcile.error && <Row k="Ошибка сверки"><span className="text-destructive">{h.reconcile.error}</span></Row>}
          </div>
          <p className="text-xs text-muted-foreground">Сверка идёт каждые 20 с: держит стопы и тейки на бирже, подхватывает позиции после сбоев, закрывает то, что закрыл источник.</p>
        </Card>

        <Card icon={<Radio className="h-4 w-4 text-primary" />} title="Источники сигналов">
          {h.sources.map((s) => (
            <div key={s.source}>
              <p className="text-sm font-bold">{s.name}</p>
              <Row k="Сигналы"><InboxLine name={s.name} info={s.inbox} /></Row>
              <Row k="Открыто сделок">{s.open}</Row>
              <Row k="Синхронизация позиций">
                {s.sync.at === null ? <span className="text-muted-foreground">{s.open ? "ещё не было" : "не нужна — открытых сделок нет"}</span>
                  : <Ok ok={s.sync.ok}>{s.sync.ok ? "в порядке" : `ошибка: ${s.sync.error}`} · {ago(s.sync.at)}</Ok>}
              </Row>
            </div>
          ))}
        </Card>

        <Card icon={<Server className="h-4 w-4 text-primary" />} title="BingX">
          {h.accounts.length === 0 && <p className="text-sm text-muted-foreground">Счетов нет.</p>}
          {h.accounts.map((a) => {
            const asset = a.env === "real" ? "USDT" : "VST";
            return (
              <div key={a.id}>
                <p className="text-sm font-bold">{a.label}</p>
                <Row k="Баланс">{a.balance.ok ? <span className="tabular">{money(a.balance.equity, asset)} · свободно {money(a.balance.available, asset)}</span> : <span className="text-destructive">не читается: {a.balance.error}</span>}</Row>
                <Row k="Режим хеджирования"><Ok ok={a.hedge}>{a.hedge === null ? "ещё не проверялся" : a.hedge ? "включён" : "выключен"}</Ok></Row>
                <Row k="Запросов с запуска"><span className="tabular">{a.requests.toLocaleString("ru-RU")}</span></Row>
                <Row k="Лимит запросов за час">
                  {a.rate.length === 0 ? <span className="text-success">не было</span>
                    : <span className="text-amber-200">{a.rate.map((r) => `${short(r.path)}: ${r.lastHour}`).join(" · ")}</span>}
                </Row>
                {a.lastError && <Row k="Последний отказ биржи"><span className="text-muted-foreground">{a.lastError.message} · {ago(a.lastError.at)}</span></Row>}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">При лимите BingX бот ждёт разблокировки и повторяет запрос — сделки не теряются.</p>
        </Card>

        <Card icon={<Send className="h-4 w-4 text-primary" />} title="Telegram">
          {!h.telegram ? <p className="text-sm text-muted-foreground">Нет данных.</p> : (
            <div>
              <Row k="Последнее отправлено">{ago(h.telegram.lastSentAt)}</Row>
              <Row k="В очереди"><Ok ok={h.telegram.pending === 0}>{h.telegram.pending}</Ok></Row>
              <Row k="Не доставлено за сутки"><Ok ok={h.telegram.failed24h === 0}>{h.telegram.failed24h}</Ok></Row>
              {h.telegram.lastError && <Row k="Последний ответ Telegram"><span className="text-muted-foreground">{h.telegram.lastError} · {ago(h.telegram.lastErrorAt)}</span></Row>}
            </div>
          )}
        </Card>
      </div>

      <Card icon={<AlertTriangle className="h-4 w-4 text-primary" />} title="Сделки, которым нужно внимание">
        {h.stuck.length === 0 && h.unannounced.length === 0 ? <p className="text-sm text-success">Таких нет.</p> : <>
          {h.stuck.length > 0 && <div><p className="text-sm font-bold text-destructive">Застряли при открытии или закрытии</p><TradeList rows={h.stuck} /></div>}
          {h.unannounced.length > 0 && <div><p className="text-sm font-bold text-amber-200">Открыты, но сообщение «Открыт…» ещё не ушло</p><TradeList rows={h.unannounced} /></div>}
        </>}
      </Card>

      <Card icon={<XCircle className="h-4 w-4 text-primary" />} title="Ошибки за 24 часа">
        {h.errors.length === 0 && h.failed.length === 0 ? <p className="text-sm text-success">Ошибок нет.</p> : <>
          {h.errors.map((e) => (
            <div key={e.kind} className="border-t border-border pt-2 text-sm first:border-t-0 first:pt-0">
              <p><b>{e.text}</b> · {e.n} раз · последний {ago(e.lastAt)}{e.lastSymbol ? ` · ${e.lastSymbol.replace(/-?USDT$/, "")}` : ""}</p>
              {e.lastMessage && <p className="break-words text-xs text-muted-foreground">{e.lastMessage}</p>}
            </div>
          ))}
          {h.failed.length > 0 && (
            <div className="border-t border-border pt-2 text-sm">
              <p className="font-bold">Сделки не открылись из-за ошибки</p>
              {h.failed.map((f) => <p key={f.reason}>{f.text} · {f.n}</p>)}
            </div>
          )}
        </>}
      </Card>
    </div>
  );
}
