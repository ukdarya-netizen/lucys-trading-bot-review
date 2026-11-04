import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { StrategyPicker, type StrategyChoices } from "@/components/strategy-picker";
import { StrategySection } from "@/components/StrategyCard";

type OwnerStrategy = {
  strategy: string; patternExit: string | null; patterns: string[]; strategyText: string;
  updatedAt: string | null; choices: StrategyChoices;
};

/** The owner's own bot strategy (applies to new entries within ~15 s). */
export function OwnerStrategyCard({ toolbar, extra, readOnly, footer }: {
  toolbar?: ReactNode; extra?: (id: string, choices: StrategyChoices) => ReactNode; readOnly?: boolean; footer?: ReactNode;
} = {}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const query = useQuery({
    queryKey: ["owner-trading-strategy"],
    queryFn: () => api<OwnerStrategy>("/journal/trading-strategy"),
  });
  const save = useMutation({
    mutationFn: (choice: { strategy: string; patternExit?: string; patterns?: string[] }) =>
      api<{ strategyText: string }>("/journal/trading-strategy", { method: "POST", body: choice }),
    onSuccess: (data) => {
      setMessage({ text: `Сохранено: ${data.strategyText}. Действует для новых сделок; открытые закрываются по своей стратегии.`, bad: false });
      void queryClient.invalidateQueries({ queryKey: ["owner-trading-strategy"] });
    },
    onError: (e) => setMessage({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  if (!query.data) {
    return <div className="border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="owner-strategy">
      {query.error ? "Стратегию загрузить не удалось" : "Загрузка стратегии…"}
    </div>;
  }
  const d = query.data;
  return (
    <StrategySection title="Как вести сделки CAB" current={d.strategyText} message={message}>
      {toolbar}
      <StrategyPicker extra={extra ? (id) => extra(id, d.choices) : undefined} value={{ strategy: d.strategy, patternExit: d.patternExit, patterns: d.patterns }}
        choices={d.choices} pending={save.isPending} onSave={(choice) => save.mutate(choice)} readOnly={readOnly} />
      {footer}
    </StrategySection>
  );
}
