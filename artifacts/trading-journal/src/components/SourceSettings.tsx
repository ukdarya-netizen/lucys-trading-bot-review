// Signal bots' settings shape and the «signals arrive» line (owner 2026-11-03).

export type SourceSettingsValue = {
  source: string; enabled: boolean; allocationMode: "percent" | "amount"; allocationValue: number; strategy: string; subscribers: boolean;
};
export type InboxInfo = { lastAt: string | null; last24h: number };
const when = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Signals of a bot "arrive" when one came in the last 24 hours. */
export const arriving = (i: InboxInfo | undefined) => Boolean(i && i.lastAt && i.last24h > 0);
export function InboxLine({ name, info }: { name: string; info: InboxInfo | undefined }) {
  const ok = arriving(info);
  return (
    <span className={ok ? "text-success" : "text-destructive"}>
      {ok ? `приходят · за сутки ${info!.last24h}, последний ${when(info!.lastAt!)}` : info?.lastAt ? `за сутки не было · последний ${when(info.lastAt)}` : "ещё не приходили"}
      {!ok && <span className="text-muted-foreground"> — отправку включают в самом {name}</span>}
    </span>
  );
}
