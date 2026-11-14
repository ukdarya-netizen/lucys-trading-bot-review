import { pool } from "@workspace/db";
import { isBot, type Account, type Bot } from "./accounts";

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

/**
 * Owner 2026-11-06: new entries of the owner are switched PER BOT (CAB and Nihilist apart).
 * Reserved rows __control_owner_cab__ / __control_owner_nihilist__. Until the owner flips one, it keeps what
 * applied before: the old common switch of the main account AND that bot's old "open trades" switch.
 */
const botControlKey = (bot: Bot) => `__control_owner_${bot}__`;
export async function getOwnerBotControl(bot: Bot): Promise<{ enabled: boolean; startedAt: number; saved: boolean }> {
  const r = await pool.query<{ source: string; enabled: boolean; updated_at: Date }>(
    "SELECT source, enabled, updated_at FROM ex_source_settings WHERE source = ANY($1::text[]) AND source NOT LIKE 'nihilist_sides:%'", [[botControlKey(bot), bot]]);
  const own = r.rows.find((x) => x.source === botControlKey(bot));
  if (own) return { enabled: own.enabled, startedAt: own.enabled ? new Date(own.updated_at).getTime() : 0, saved: true };
  const global = await getTradingControl("owner");
  const legacyBot = r.rows.find((x) => x.source === bot)?.enabled ?? true;
  return { enabled: global.enabled && legacyBot, startedAt: global.startedAt, saved: false };
}
export async function saveOwnerBotControl(bot: Bot, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, subscribers)
     VALUES ($1, $2, false)
     ON CONFLICT (source) DO UPDATE SET enabled = EXCLUDED.enabled,
       updated_at = CASE WHEN ex_source_settings.enabled IS DISTINCT FROM EXCLUDED.enabled
                         THEN now() ELSE ex_source_settings.updated_at END`,
    [botControlKey(bot), enabled],
  );
}

/** Fresh DB checks fail closed, including when refreshAccounts fell back to cached runtimes. */
export async function accountEntryAllowed(account: Account, releasedAt: number, source: string): Promise<boolean> {
  if (!productionTrading()) return false;
  if (!account.sources.has(source)) return false;
  if (account.subscriberId === null) {
    if (!isBot(source)) return false;
    const control = await getOwnerBotControl(source);
    return control.enabled && releasedAt >= control.startedAt;
  }
  const control = await getTradingControl("subscribers");
  if (!control.enabled || releasedAt < control.startedAt) return false;
  const result = await pool.query(
    `SELECT 1 FROM subscribers WHERE id = $1 AND status = 'approved' AND trading_enabled
     AND trading_account = 'vst' AND (subscribed_until IS NULL OR subscribed_until > now())
     AND (trading_started_at IS NULL OR trading_started_at <= to_timestamp($2 / 1000.0))`,
    [account.subscriberId, releasedAt],
  );
  return Boolean(result.rowCount);
}
