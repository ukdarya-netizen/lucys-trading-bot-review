/**
 * Who trades (owner 2026-11-02 rewrite). Always isolated margin, 10x.
 *   the owner's main account — chosen in «Мой кабинет» (owner 2026-11-04, ex_owner_account):
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
  /** Signal sources this account trades (a subscriber picks CAB, Nihilist or both; the owner: both). */
  sources: Set<string>;
};

function decryptSecret(stored: string, secret = process.env.SUBSCRIBER_KEYS_SECRET): string {
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

/** The owner's main account as set in «Мой кабинет»; without a choice there — the VST key from Secrets. */
export async function ownerAccount(row: OwnerAccountRow | null, strategy: Strategy): Promise<Account | null> {
  const base = { allocation: { mode: "percent" as const, value: 1 }, strategy, startedAt: 0, subscriberId: null, sources: new Set(["cab", "nihilist"]) };
  if (row?.mode === "paper") return { ...base, id: "owner-paper", label: "PAPER", env: "vst", key: "paper", secret: "paper", paper: true };
  if (row && row.api_key_encrypted && row.api_secret_encrypted && (row.mode === "vst" || row.mode === "real")) {
    try {
      return {
        ...base, id: `owner-${row.mode}`, label: row.mode === "real" ? "BingX REAL" : "BingX VST", env: row.mode,
        key: decryptSecret(row.api_key_encrypted), secret: decryptSecret(row.api_secret_encrypted),
      };
    } catch {
      return null; // SUBSCRIBER_KEYS_SECRET changed: the key must be entered again
    }
  }
  if (row?.mode === "real") return null; // REAL needs its key saved in the cabinet
  const key = process.env.BINGX_API_KEY?.trim();
  const secret = process.env.BINGX_API_SECRET?.trim();
  if (key && secret && process.env.EXECUTOR_OWNER_VST !== "0") return { ...base, id: "owner-vst", label: "BingX VST", env: "vst", key, secret };
  return null;
}

export async function loadAccounts(): Promise<Account[]> {
  const out: Account[] = [];
  const owner = await ownerAccount(await ownerAccountRow(), resolveStrategy(await ownerStrategyRow()));
  if (owner) out.push(owner);
  // Subscribers join only when the owner turns them on (EXECUTOR_SUBSCRIBERS=1).
  if (process.env.EXECUTOR_SUBSCRIBERS !== "1") return out;
  try {
    const r = await pool.query(
      `SELECT id, name, email, strategy, pattern_exit, patterns, api_key_encrypted, api_secret_encrypted,
              allocation_mode, allocation_value, trading_started_at, trade_sources
       FROM subscribers
       WHERE status = 'approved' AND trading_enabled AND trading_account = 'vst'
         AND (subscribed_until IS NULL OR subscribed_until > now())
         AND api_key_encrypted IS NOT NULL AND api_secret_encrypted IS NOT NULL`,
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
