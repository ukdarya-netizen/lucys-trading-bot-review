import { BOT_BRAND_NAMES } from "@/components/BotBrand";

// One look for the strategies of both signal bots (owner 2026-11-03): the same section and numbered cards
// in «Мой кабинет» (choosing) and on «CAB и Нигилист» (results only, owner 2026-11-04).
import type { ReactNode } from "react";
import { Target } from "lucide-react";

export const NIHILIST_DESCRIPTIONS: Record<string, string> = {
  source: `Стоп — исходный стоп ${BOT_BRAND_NAMES.nihilist}. На +5% от входа стоп переносится на вход, с +15% стоп идёт за ценой на 10% ниже пика.`,
  take5: `Вся позиция закрывается, когда цена прошла +5% от входа. До этого стоп — исходный стоп ${BOT_BRAND_NAMES.nihilist}.`,
  take10: `Вся позиция закрывается, когда цена прошла +10% от входа. До этого стоп — исходный стоп ${BOT_BRAND_NAMES.nihilist}.`,
  take15: `Вся позиция закрывается, когда цена прошла +15% от входа. До этого стоп — исходный стоп ${BOT_BRAND_NAMES.nihilist}.`,
};

export function StrategySection({ title, current, children, message }: { title: string; current: string | null; children: ReactNode; message?: { text: string; bad: boolean } | null }) {
  return (
    <section className="space-y-3 border border-border bg-card p-4" data-testid="strategy-section">
      <h2 className="flex items-center gap-2 font-bold"><Target className="h-4 w-4 text-primary" />{title}</h2>
      <p className="text-sm">Сейчас: <span className="font-semibold">{current ?? "—"}</span></p>
      {children}
      {message && <p className={`text-sm ${message.bad ? "text-destructive" : "text-success"}`}>{message.text}</p>}
    </section>
  );
}

export function StrategyCard({ index, label, description, saved, active, disabled, onClick, readOnly, children }: {
  index: number; label: string; description?: string; saved: boolean; active: boolean; disabled?: boolean; onClick?: () => void;
  /** Results page: the card only shows, choosing is in «Мой кабинет». */
  readOnly?: boolean; children?: ReactNode;
}) {
  const cls = `border p-4 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-border"}`;
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="font-bold">{index}. {label}</span>
        {saved && <span className="text-xs font-bold text-primary">выбрана</span>}
      </span>
      {description && <span className="mt-2 block text-sm text-muted-foreground">{description}</span>}
      {children}
    </>
  );
  if (readOnly) return <div className={cls}>{body}</div>;
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`${cls} disabled:cursor-not-allowed ${active ? "" : "hover:border-primary/40"}`}>
      {body}
    </button>
  );
}
