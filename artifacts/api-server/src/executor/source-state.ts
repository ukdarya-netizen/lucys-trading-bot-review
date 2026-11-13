export type SourceSyncStatus = {
  at: number | null;
  ok: boolean | null;
  error: string | null;
};

const SOURCE_CANCEL_ACTIONS = new Set([
  "close",
  "reclassified",
  "cancel",
  "cancelled",
  "canceled",
  "cancel_entry",
  "smart_cancel",
]);

const SOURCE_REVIEW_ACTIONS = new Set([
  "position_review",
  "review",
]);

const SOURCE_HOLD_ACTIONS = new Set([
  "active",
  "hold",
  "move_stop",
  "none",
  "open",
  "trail",
  "update_stop",
  "update_stop_loss",
]);

export function sourceActionKind(action: string, sourceStatus?: string | null): "close" | "review" | "hold" | "unknown" {
  const normalized = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const normalizedStatus = sourceStatus?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  // Owner 2026-11-09: a reclassified (neutrally closed) signal closes the position like a cancelled one.
  if (normalizedStatus === "cancelled" || normalizedStatus === "canceled" || normalizedStatus === "reclassified") return "close";
  if (SOURCE_CANCEL_ACTIONS.has(normalized)) return "close";
  if (SOURCE_REVIEW_ACTIONS.has(normalized)) return "review";
  if (SOURCE_HOLD_ACTIONS.has(normalized)) return "hold";
  return "unknown";
}

export function missingSourceSignals(activeIds: string[], receivedIds: string[]): string[] {
  const received = new Set(receivedIds);
  return activeIds.filter((id) => !received.has(id));
}

export function sourceSyncConfirmed(
  status: SourceSyncStatus | null | undefined,
  now: number,
  maxAgeMs = 90_000,
): boolean {
  return status?.ok === true &&
    status.at !== null &&
    status.at !== undefined &&
    status.at <= now &&
    now - status.at <= maxAgeMs;
}
