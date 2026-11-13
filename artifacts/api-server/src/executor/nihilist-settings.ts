import { pool } from "@workspace/db";
import { nihilistStrategies, nihilistStrategy } from "./plan";
import { getSourceSettings } from "./store";
import { logger } from "../lib/logger";

export type NihilistSettings = {
  sides: "both" | "long" | "short";
  longStrategy: string;
  shortStrategy: string;
};

/** Reserved rows: JSON in the existing text column `strategy`; no schema changes. */
export function nihilistSettingsKey(accountKey: string): string {
  if (accountKey !== "owner" && !/^sub-[1-9]\d*$/.test(accountKey)) throw new Error("invalid_account_key");
  return `nihilist_sides:${accountKey}`;
}

export function validNihilistSettings(value: unknown): value is NihilistSettings {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const ids = nihilistStrategies().map((m) => m.id);
  return typeof s.sides === "string" && ["both", "long", "short"].includes(s.sides)
    && typeof s.longStrategy === "string" && ids.includes(s.longStrategy)
    && typeof s.shortStrategy === "string" && ids.includes(s.shortStrategy);
}

export async function getNihilistSettings(accountKey: string, legacyStrategy?: string): Promise<NihilistSettings> {
  const fallback = nihilistStrategy(legacyStrategy ?? (await getSourceSettings("nihilist")).strategy).id;
  const result = await pool.query<{ strategy: string }>(
    "SELECT strategy FROM ex_source_settings WHERE source = $1", [nihilistSettingsKey(accountKey)],
  );
  const defaults: NihilistSettings = { sides: "both", longStrategy: fallback, shortStrategy: fallback };
  if (!result.rows.length) return defaults;
  try {
    const settings: unknown = JSON.parse(result.rows[0]!.strategy);
    if (validNihilistSettings(settings)) return settings;
  } catch {
    // Malformed JSON uses the same legacy defaults as an unknown strategy.
  }
  logger.warn({ accountKey }, "Invalid saved Nihilist settings; using legacy strategy and both sides");
  return defaults;
}

export async function saveNihilistSideSettings(accountKey: string, value: NihilistSettings): Promise<NihilistSettings> {
  if (!validNihilistSettings(value)) throw new Error("invalid_nihilist_settings");
  const settings: NihilistSettings = { sides: value.sides, longStrategy: value.longStrategy, shortStrategy: value.shortStrategy };
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, subscribers, strategy, updated_at)
     VALUES ($1, false, false, $2, now())
     ON CONFLICT (source) DO UPDATE SET strategy = EXCLUDED.strategy, updated_at = now()`,
    [nihilistSettingsKey(accountKey), JSON.stringify(settings)],
  );
  return settings;
}

export function describeNihilistSettings(s: NihilistSettings): string {
  const sides = { both: "лонги и шорты", long: "только лонги", short: "только шорты" }[s.sides];
  return `Торговать: ${sides}. Лонги: ${nihilistStrategy(s.longStrategy).label}. Шорты: ${nihilistStrategy(s.shortStrategy).label}.`;
}
