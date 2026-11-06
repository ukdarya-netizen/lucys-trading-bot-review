import { pool } from "@workspace/db";
import type { Account } from "./accounts";

export const CONTROL_TARGETS = ["owner", "subscribers"] as const;
export type ControlTarget = typeof CONTROL_TARGETS[number];
const controlKey = (target: ControlTarget) => `__control_${target}_vst__`;
// REPLIT_DEPLOYMENT is supplied only to the published service; a local production build is not permission to trade.
export const productionTrading = () => process.env.REPLIT_DEPLOYMENT === "1" && process.env.NODE_ENV !== "development";

/** Reserved rows in the existing settings table, not signal sources. No DDL. */
export async function getTradingControl(target: ControlTarget) {
  const result = await pool.query<{ enabled: boolean; updated_at: Date }>(
    "SELECT enabled, updated_at FROM ex_source_settings WHERE source = $1", [controlKey(target)],
  );
  const row = result.rows[0];
  // Preserve the pre-cabinet configuration until the owner explicitly saves a choice.
  const legacyEnabled = target === "owner"
    ? process.env.EXECUTOR_OWNER_VST !== "0"
    : process.env.EXECUTOR_SUBSCRIBERS === "1";
  return {
    enabled: row ? row.enabled : legacyEnabled,
    startedAt: row?.enabled ? new Date(row.updated_at).getTime() : 0,
  };
}

export async function saveTradingControl(target: ControlTarget, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, subscribers)
     VALUES ($1, $2, false)
     ON CONFLICT (source) DO UPDATE SET enabled = EXCLUDED.enabled,
       updated_at = CASE WHEN ex_source_settings.enabled IS DISTINCT FROM EXCLUDED.enabled
                         THEN now() ELSE ex_source_settings.updated_at END`,
    [controlKey(target), enabled],
  );
}

/** Fresh DB checks fail closed, including when refreshAccounts fell back to cached runtimes. */
export async function accountEntryAllowed(account: Account, releasedAt: number): Promise<boolean> {
  if (!productionTrading()) return false;
  const control = await getTradingControl(account.subscriberId === null ? "owner" : "subscribers");
  if (!control.enabled || releasedAt < control.startedAt) return false;
  if (account.subscriberId !== null) {
    const result = await pool.query(
      `SELECT 1 FROM subscribers WHERE id = $1 AND status = 'approved' AND trading_enabled
       AND trading_account = 'vst' AND (subscribed_until IS NULL OR subscribed_until > now())
       AND (trading_started_at IS NULL OR trading_started_at <= to_timestamp($2 / 1000.0))`,
      [account.subscriberId, releasedAt],
    );
    return Boolean(result.rowCount);
  }
  return true;
}
