/**
 * Who trades (owner 2026-11-02 rewrite). Always isolated margin, 10x.
 *   the owner's accounts — chosen in «Мой кабинет» PER BOT (owner 2026-11-06; one BingX key, ex_owner_account):
 *     owner-paper  — PAPER: simulated exchange with BingX prices (paper.ts), no key;
 *     owner-vst    — VST demo with the key saved in the cabinet, else BINGX_API_KEY /
 *                    BINGX_API_SECRET from Secrets (unless EXECUTOR_OWNER_VST=0);
 *     owner-real   — REAL money, only with the key saved in the cabinet;
 *   strategy from owner_trading_strategy, size per source from «Мой кабинет»;
 *   sub-<id>-vst   — approved subscribers with trading started on VST and a
 *                    saved key; their size and strategy from the cabinet
 *                    (only with EXECUTOR_SUBSCRIBERS=1).
 * Real accounts are not enabled here yet.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { resolveStrategy, type Strategy } from "./plan";
import type { Env } from "./bingx";

export const LEVERAGE = 10;

export type Account = {
  id: string; label: string; env: Env; key: string; secret: string;
  allocation: { mode: "percent" | "amount"; value: number };
  strategy: Strategy;
  /** Signals before this moment are not traded by this account. */
  startedAt: number;
  subscriberId: number | null;
  /** PAPER: orders go to the simulated exchange (paper.ts). */
  paper?: boolean;
  /** Signal sources this account opens trades for (a subscriber picks CAB, Nihilist or both; the owner sets an account per bot). */
  sources: Set<string>;
};

export function decryptSecret(stored: string, secret = process.env.SUBSCRIBER_KEYS_SECRET): string {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SUBSCRIBER_KEYS_SECRET missing");
  const key = createHash("sha256").update(`cab-subscriber-keys:${secret}`).digest();
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported encrypted secret");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"));
  d.setAuthTag(Buffer.from(parts[2]!, "base64url"));
  return Buffer.concat([d.update(Buffer.from(parts[3]!, "base64url")), d.final()]).toString("utf8");
}

async function ownerStrategyRow(): Promise<{ strategy: string; pattern_exit: string | null; patterns: string | null } | null> {
  try {
    const r = await pool.query("SELECT strategy, pattern_exit, patterns FROM owner_trading_strategy WHERE id = 1");
    return r.rows[0] ?? null;
  } catch {
    return null; // table not created yet: default strategy
  }
}

export type OwnerMode = "paper" | "vst" | "real";
export type OwnerAccountRow = { mode: OwnerMode; api_key_encrypted: string | null; api_secret_encrypted: string | null };
export async function ownerAccountRow(): Promise<OwnerAccountRow | null> {
  try {
    const r = await pool.query("SELECT mode, api_key_encrypted, api_secret_encrypted FROM ex_owner_account WHERE id = 1");
    return r.rows[0] ?? null;
  } catch {
    return null; // table not created yet: Secrets
  }
}

/**
 * Owner 2026-11-06: each bot has its own account — CAB on REAL and Nihilist on VST, or both on one.
 * Stored as reserved rows of ex_source_settings (no DDL): source = __owner_account_<bot>__, mode in `strategy`.
 * A bot without a row keeps the mode the main account had before (ex_owner_account.mode, default VST).
 */
export const BOTS = ["cab", "nihilist"] as const;
export type Bot = typeof BOTS[number];
const botAccountKey = (bot: Bot) => `__owner_account_${bot}__`;
const isMode = (v: unknown): v is OwnerMode => v === "paper" || v === "vst" || v === "real";

export async function ownerBotModes(row: OwnerAccountRow | null): Promise<Record<Bot, OwnerMode>> {
  const fallback: OwnerMode = isMode(row?.mode) ? row!.mode : "vst";
  const out: Record<Bot, OwnerMode> = { cab: fallback, nihilist: fallback };
  try {
    const r = await pool.query<{ source: string; strategy: string }>(
      "SELECT source, strategy FROM ex_source_settings WHERE source = ANY($1::text[]) AND source NOT LIKE 'nihilist_sides:%'", [BOTS.map(botAccountKey)]);
    for (const bot of BOTS) {
      const v = r.rows.find((x) => x.source === botAccountKey(bot))?.strategy;
      if (isMode(v)) out[bot] = v;
    }
  } catch { /* table not created yet: the old single mode */ }
  return out;
}

export async function saveOwnerBotMode(bot: Bot, mode: OwnerMode): Promise<void> {
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, subscribers, strategy, updated_at) VALUES ($1, false, false, $2, now())
     ON CONFLICT (source) DO UPDATE SET strategy = EXCLUDED.strategy, updated_at = now()`, [botAccountKey(bot), mode]);
}

/** The key the owner's account uses on this mode: the key saved in the cabinet (one BingX key serves VST and REAL), else for VST the key from Secrets. */
export function ownerKeyFor(mode: OwnerMode, row: OwnerAccountRow | null): { key: string; secret: string; from: "cabinet" | "secrets" } | null {
  if (mode === "paper") return null;
  if (row?.api_key_encrypted && row.api_secret_encrypted) {
    try {
      return { key: decryptSecret(row.api_key_encrypted), secret: decryptSecret(row.api_secret_encrypted), from: "cabinet" };
    } catch {
      return null; // SUBSCRIBER_KEYS_SECRET changed: the key must be entered again
    }
  }
  if (mode === "real") return null; // REAL needs its key saved in the cabinet
  const key = process.env.BINGX_API_KEY?.trim();
  const secret = process.env.BINGX_API_SECRET?.trim();
  return key && secret && process.env.EXECUTOR_OWNER_VST !== "0" ? { key, secret, from: "secrets" } : null;
}

/** One owner account (PAPER / VST / REAL) trading the given bots; null when it has no key. */
export function ownerAccountFor(mode: OwnerMode, row: OwnerAccountRow | null, strategy: Strategy, sources: Set<string>): Account | null {
  const base = { allocation: { mode: "percent" as const, value: 1 }, strategy, startedAt: 0, subscriberId: null, sources };
  if (mode === "paper") return { ...base, id: "owner-paper", label: "PAPER", env: "vst", key: "paper", secret: "paper", paper: true };
  const k = ownerKeyFor(mode, row);
  if (!k) return null;
  return { ...base, id: `owner-${mode}`, label: mode === "real" ? "BingX REAL" : "BingX VST", env: mode, key: k.key, secret: k.secret };
}

/** Owner accounts that still hold open trades (a bot moved to another account: these are led to the end where they are). */
export async function ownerModesWithOpenTrades(): Promise<Set<OwnerMode>> {
  try {
    const r = await pool.query<{ account_id: string }>(
      "SELECT DISTINCT account_id FROM ex_trades WHERE account_id LIKE 'owner-%' AND status IN ('opening','open','closing','unknown')");
    return new Set(r.rows.map((x) => x.account_id.slice("owner-".length)).filter(isMode));
  } catch {
    return new Set();
  }
}

/** The owner's accounts: one per mode a bot is set to, plus any mode that still has open trades. */
export async function ownerAccounts(): Promise<Account[]> {
  const row = await ownerAccountRow();
  const modes = await ownerBotModes(row);
  const open = await ownerModesWithOpenTrades();
  const strategy = resolveStrategy(await ownerStrategyRow());
  const out: Account[] = [];
  for (const mode of ["paper", "vst", "real"] as const) {
    const sources = new Set<string>(BOTS.filter((b) => modes[b] === mode));
    if (!sources.size && !open.has(mode)) continue;
    const a = ownerAccountFor(mode, row, strategy, sources);
    if (a) out.push(a);
  }
  return out;
}

export async function loadAccounts(): Promise<Account[]> {
  const out: Account[] = await ownerAccounts();
  // Subscribers join only when the owner turns them on (EXECUTOR_SUBSCRIBERS=1).
  if (process.env.EXECUTOR_SUBSCRIBERS !== "1") return out;
  try {
    const r = await pool.query(
      `SELECT id, name, email, strategy, pattern_exit, patterns, api_key_encrypted, api_secret_encrypted,
              allocation_mode, allocation_value, trading_started_at, trade_sources
       FROM subscribers
       WHERE status = 'approved' AND trading_account = 'vst'
         AND (subscribed_until IS NULL OR subscribed_until > now())
         AND api_key_encrypted IS NOT NULL AND api_secret_encrypted IS NOT NULL
         -- «Стоп» stops new entries only (accountEntryAllowed): open trades are led to the end (owner 2026-11-09).
         -- When the subscription ends or access is blocked the account is disconnected at once, open trades included.
         AND (trading_enabled OR EXISTS (
           SELECT 1 FROM ex_trades t WHERE t.account_id = 'sub-' || subscribers.id || '-vst'
             AND t.status IN ('opening','open','closing','unknown')))`,
    );
    for (const s of r.rows) {
      try {
        out.push({
          id: `sub-${s.id}-vst`, label: `BingX VST · ${s.name || s.email || `подписчик ${s.id}`}`, env: "vst",
          key: decryptSecret(s.api_key_encrypted), secret: decryptSecret(s.api_secret_encrypted),
          allocation: { mode: s.allocation_mode === "amount" ? "amount" : "percent", value: Number(s.allocation_value) || 1 },
          strategy: resolveStrategy(s), startedAt: s.trading_started_at ? new Date(s.trading_started_at).getTime() : Date.now(),
          subscriberId: Number(s.id),
          sources: new Set(String(s.trade_sources ?? "cab").split(",").map((x: string) => x.trim()).filter(Boolean)),
        });
      } catch { /* unreadable key: this subscriber is skipped until the key is saved again */ }
    }
  } catch { /* no subscribers table yet */ }
  return out;
}

/** Initial margin of one trade. */
export function marginFor(a: Account, equity: number): number {
  return a.allocation.mode === "amount" ? a.allocation.value : (equity * a.allocation.value) / 100;
}
