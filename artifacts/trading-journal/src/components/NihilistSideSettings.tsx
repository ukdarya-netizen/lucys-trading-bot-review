import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { BOT_BRAND_NAMES } from "@/components/BotBrand";
import { StrategyCard, StrategySection, NIHILIST_DESCRIPTIONS } from "@/components/StrategyCard";

export type NihilistSettings = {
  sides: "both" | "long" | "short";
  longStrategy: string;
  shortStrategy: string;
};
export type NihilistStrategyChoice = { id: string; label: string };

const SIDES = [
  { id: "long", label: "Лонги" },
  { id: "short", label: "Шорты" },
  { id: "both", label: "Оба" },
] as const;

export function NihilistSideSettings({ saved, strategies, savePath, onSaved, extra }: {
  saved: NihilistSettings;
  strategies: NihilistStrategyChoice[];
  savePath: string;
  onSaved: (settings: NihilistSettings) => void;
  extra?: (strategy: string, side: "long" | "short") => ReactNode;
}) {
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (settings: NihilistSettings) => api<{ settings: NihilistSettings }>(savePath, { method: "POST", body: settings }),
    onSuccess: ({ settings }) => {
      onSaved(settings);
      setMessage({ text: "Сохранено. Действует для новых сигналов; открытые позиции сохраняют свою стратегию.", bad: false });
    },
    onError: (e) => setMessage({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить настройки", bad: true }),
  });
  const label = (id: string) => strategies.find((s) => s.id === id)?.label ?? id;
  const sides = { both: "лонги и шорты", long: "только лонги", short: "только шорты" }[saved.sides];
  return (
    <StrategySection title={`Как вести сделки ${BOT_BRAND_NAMES.nihilist}`}
      current={`Торговать: ${sides}. Лонги: ${label(saved.longStrategy)}. Шорты: ${label(saved.shortStrategy)}.`} message={message}>
      <fieldset disabled={save.isPending} className="space-y-2">
        <legend className="mb-2 text-sm font-bold">Торговать</legend>
        <div className="grid grid-cols-3 border border-border">
          {SIDES.map((side) => (
            <button key={side.id} type="button" data-testid={`nihilist-sides-${side.id}`} aria-pressed={saved.sides === side.id}
              onClick={() => { if (saved.sides !== side.id) save.mutate({ ...saved, sides: side.id }); }}
              className={`min-h-11 px-2 text-sm font-bold disabled:opacity-40 ${saved.sides === side.id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {side.label}
            </button>
          ))}
        </div>
      </fieldset>
      {(["long", "short"] as const).map((side) => {
        const field = side === "long" ? "longStrategy" : "shortStrategy";
        const title = side === "long" ? "Лонги" : "Шорты";
        return (
          <section key={side} className="space-y-3 border-t border-border pt-3" data-testid={`nihilist-strategy-${side}`}>
            <h3 className="text-sm font-bold">{title} · {label(saved[field])}{saved.sides !== "both" && saved.sides !== side ? " · сторона отключена" : ""}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {strategies.map((strategy, i) => (
                <StrategyCard key={strategy.id} index={i + 1} label={strategy.label}
                  description={NIHILIST_DESCRIPTIONS[strategy.id]}
                  saved={saved[field] === strategy.id} active={saved[field] === strategy.id} disabled={save.isPending}
                  onClick={() => { if (saved[field] !== strategy.id) save.mutate({ ...saved, [field]: strategy.id }); }}>
                  {extra?.(strategy.id, side)}
                </StrategyCard>
              ))}
            </div>
          </section>
        );
      })}
      <p className="text-xs text-muted-foreground">Отключённая сторона не открывает новые сделки. Закрытия источника по сроку применяются при любой стратегии.</p>
    </StrategySection>
  );
}
