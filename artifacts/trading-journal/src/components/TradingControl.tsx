import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutorTradingControlInput, ExecutorTradingControlState } from "@workspace/api-client-react";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/subscriber-api";
import type { Status } from "@/components/executor-ui";

const key = ["executor-trading-controls"];

/** Saved state is server-owned; never report success optimistically. */
export function TradingControl({ target }: { target: ExecutorTradingControlInput["target"] }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<ExecutorTradingControlState[]>("/journal/executor/trading-controls"),
    refetchInterval: 10_000,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api<ExecutorTradingControlState[]>("/journal/executor/trading-controls", {
      method: "POST", body: { target, enabled } satisfies ExecutorTradingControlInput,
    }),
    onSuccess: (controls) => {
      client.setQueryData(key, controls);
      client.setQueryData<Status>(["executor-status"], (old) => old ? {
        ...old, tradingControls: controls,
        ownerAccount: old.ownerAccount ? {
          ...old.ownerAccount, tradingEnabled: controls.find((control) => control.target === "owner")?.effective ?? false,
        } : old.ownerAccount,
      } : old);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ["executor-status"] });
      void client.invalidateQueries({ queryKey: ["executor-health"] });
    },
  });
  const title = target === "owner" ? "Торговля основного счёта · VST" : "Торговля счетов подписчиков · VST";
  const state = query.data?.find((control) => control.target === target);
  if (!state) {
    return <section role="status" className="border border-border bg-card p-4 text-sm">
      <p className="font-bold">{title}</p>
      <p className={query.isError ? "text-destructive" : "text-muted-foreground"}>
        {query.isError ? "Не удалось получить состояние торговли." : "Проверяем состояние торговли…"}
      </p>
      {query.isError && <button type="button" className="mt-2 text-primary underline" onClick={() => void query.refetch()}>Повторить</button>}
    </section>;
  }
  const status = mutation.isPending ? "Сохраняем…"
    : query.isError ? "Текущее состояние не подтверждено"
    : !state.enabled ? "Новые входы выключены"
    : state.blockedReason ? "Запуск заблокирован"
    : state.effective ? "Приём новых сигналов включён"
    : target === "subscribers" ? "Разрешено: ожидаем готовые счета подписчиков" : "Разрешено, но счёт пока не загружен";
  return (
    <section data-testid={`trading-control-${target}`} className="space-y-3 border border-border bg-card p-4">
      <label htmlFor={`trading-${target}`} className="flex items-center justify-between gap-4">
        <span>
          <span className="block font-bold">{title}</span>
          <span role="status" aria-live="polite" className={`block text-sm ${state.effective && !query.isError && !mutation.isPending ? "text-success" : "text-amber-300"}`}>{status}</span>
        </span>
        <Switch id={`trading-${target}`} aria-label={title} checked={state.enabled}
          disabled={mutation.isPending || !state.canManage || (!state.enabled && (!state.canEnable || query.isError))}
          onCheckedChange={(enabled) => mutation.mutate(enabled)} />
      </label>
      <p className="text-xs text-muted-foreground">
        Включение разрешает новые сделки по разрешённым источникам на демо-счёте VST.
        Выключение не закрывает позиции: их сопровождение продолжается.
        Уже обрабатываемая заявка ещё может исполниться. Входы зависят также от настроек источников и доступа к BingX.
      </p>
      {state.blockedReason && <p className="text-sm text-amber-300">{state.blockedReason}</p>}
      {query.isError && <p role="alert" className="text-sm text-destructive">Не удалось обновить статус. Показано последнее сохранённое положение переключателя.</p>}
      {mutation.isError && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
    </section>
  );
}
