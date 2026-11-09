/**
 * Executor ledger (owner 2026-11-02 rewrite). Three tables, declared in
 * lib/db/src/schema/executor.ts with the same names, and created at start:
 *   ex_inbox  — every signal / command received (idempotency by message id);
 *   ex_trades — one row per account and source signal;
 *   ex_events — what happened, in order (the journal and Telegram read it).
 */
import { pool } from "@workspace/db";
import type { Side } from "./plan";

let ready: Promise<void> | null = null;
export function ensureExecutorTables(): Promise<void> {
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_inbox (
        id serial PRIMARY KEY,
        kind text NOT NULL,
        message_id text NOT NULL,
        source_signal_id text NOT NULL,
        body jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ex_inbox_message_id_unique UNIQUE (message_id)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_trades (
        id serial PRIMARY KEY,
        account_id text NOT NULL,
        source text NOT NULL,
        source_signal_id text NOT NULL,
        symbol text NOT NULL,
        side text NOT NULL,
        pattern text,
        env text NOT NULL,
        status text NOT NULL,
        reason text,
        take_pct double precision,
        signal_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        entry_sent_at timestamptz,
        opened_at timestamptz,
        client_order_id text,
        entry_order_id text,
        qty double precision,
        initial_qty double precision,
        entry_price double precision,
        stop_price double precision,
        take_price double precision,
        liquidation_price double precision,
        margin double precision,
        margin_added double precision NOT NULL DEFAULT 0,
        last_command_seq integer NOT NULL DEFAULT 0,
        pending_close_reason text,
        closed_at timestamptz,
        exit_price double precision,
        pnl double precision,
        pnl_pct double precision,
        close_reason text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        mgmt text,
        max_hold_h double precision,
        peak_pct double precision NOT NULL DEFAULT 0,
        be_moved boolean NOT NULL DEFAULT false,
        partial_done boolean NOT NULL DEFAULT false,
        leverage integer,
        stop_kind text NOT NULL DEFAULT 'initial',
        CONSTRAINT ex_trades_account_signal_unique UNIQUE (account_id, source_signal_id)
      )`);
    // Own management of Nihilist trades (owner 2026-11-03).
    for (const col of ["mgmt text", "max_hold_h double precision", "peak_pct double precision NOT NULL DEFAULT 0",
      "be_moved boolean NOT NULL DEFAULT false", "partial_done boolean NOT NULL DEFAULT false", "leverage integer", "stop_kind text NOT NULL DEFAULT 'initial'"]) {
      await pool.query(`ALTER TABLE ex_trades ADD COLUMN IF NOT EXISTS ${col}`);
    }
    // Telegram outbox (owner 2026-11-03): every message is stored, then sent in order — never dropped.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_tg_outbox (
        id serial PRIMARY KEY,
        chat_id text NOT NULL,
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        next_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        sent_at timestamptz,
        failed_at timestamptz
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_btc_settings (
        account_key text NOT NULL,
        source text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        leverage integer NOT NULL DEFAULT 50,
        allocation_mode text,
        allocation_value double precision,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ex_btc_settings_pk PRIMARY KEY (account_key, source)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_source_settings (
        source text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT true,
        allocation_mode text NOT NULL DEFAULT 'percent',
        allocation_value double precision NOT NULL DEFAULT 1,
        strategy text NOT NULL DEFAULT 'source',
        subscribers boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Owner 2026-11-04: the main account set in «Мой кабинет» — PAPER / VST / REAL, its key (encrypted).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_owner_account (
        id integer PRIMARY KEY,
        mode text NOT NULL DEFAULT 'vst',
        api_key_encrypted text,
        api_secret_encrypted text,
        key_last4 text,
        verified_at timestamptz,
        error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Owner 2026-11-04: the PAPER account's simulated exchange (balance, positions, orders).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_paper_state (
        id integer PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Owner 2026-11-03: Nihilist open to subscribers (a setting saved before this decision had it closed by default).
    await pool.query(`UPDATE ex_source_settings SET subscribers = true WHERE source = 'nihilist' AND NOT subscribers AND updated_at < '2026-11-03T08:10:00Z'`);
    await pool.query("CREATE INDEX IF NOT EXISTS ex_trades_status ON ex_trades (account_id, status)");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ex_events (
        id serial PRIMARY KEY,
        account_id text NOT NULL,
        trade_id integer,
        source_signal_id text,
        symbol text,
        kind text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS ex_events_trade ON ex_events (trade_id)");
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

export type TradeStatus = "opening" | "open" | "closing" | "closed" | "skipped" | "failed" | "unknown";
export type Trade = {
  id: number; account_id: string; source: string; source_signal_id: string; symbol: string; side: Side; pattern: string | null;
  env: string; status: TradeStatus; reason: string | null; take_pct: number | null; signal_at: Date; received_at: Date;
  entry_sent_at: Date | null; opened_at: Date | null; client_order_id: string | null; entry_order_id: string | null;
  qty: number | null; initial_qty: number | null; entry_price: number | null; stop_price: number | null; take_price: number | null;
  liquidation_price: number | null; margin: number | null; margin_added: number; last_command_seq: number;
  pending_close_reason: string | null; closed_at: Date | null; exit_price: number | null; pnl: number | null; pnl_pct: number | null;
  close_reason: string | null; updated_at: Date;
  mgmt: string | null; max_hold_h: number | null; peak_pct: number; be_moved: boolean; partial_done: boolean; leverage: number | null; stop_kind: string | null;
};

/** Stores a received message once; false when it was already there. */
export async function inboxPut(kind: "signal" | "command", messageId: string, sourceSignalId: string, body: unknown): Promise<boolean> {
  await ensureExecutorTables();
  const r = await pool.query(
    `INSERT INTO ex_inbox (kind, message_id, source_signal_id, body) VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING`,
    [kind, messageId, sourceSignalId, JSON.stringify(body)],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function inboxGet(messageId: string): Promise<{ body: any } | null> {
  const r = await pool.query<{ body: any }>("SELECT body FROM ex_inbox WHERE message_id = $1", [messageId]);
  return r.rows[0] ?? null;
}

/** Commands received for a signal, oldest first (owner 2026-11-09: replay of commands that were not applied). */
export async function commandsForSignal(sourceSignalId: string): Promise<Array<{ body: any; received_at: Date }>> {
  const r = await pool.query<{ body: any; received_at: Date }>(
    "SELECT body, received_at FROM ex_inbox WHERE kind = 'command' AND source_signal_id = $1 ORDER BY id", [sourceSignalId]);
  return r.rows;
}

/** New trade row; null when this account already has one for the signal. */
export async function createTrade(t: {
  account_id: string; source: string; source_signal_id: string; symbol: string; side: Side; pattern: string | null; env: string;
  take_pct: number | null; signal_at: Date; received_at: Date; stop_price: number; mgmt?: string | null; max_hold_h?: number | null;
}): Promise<Trade | null> {
  await ensureExecutorTables();
  const r = await pool.query<Trade>(
    `INSERT INTO ex_trades (account_id, source, source_signal_id, symbol, side, pattern, env, status, take_pct, signal_at, received_at, stop_price, mgmt, max_hold_h)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'opening',$8,$9,$10,$11,$12,$13) ON CONFLICT (account_id, source_signal_id) DO NOTHING RETURNING *`,
    [t.account_id, t.source, t.source_signal_id, t.symbol, t.side, t.pattern, t.env, t.take_pct, t.signal_at, t.received_at, t.stop_price, t.mgmt ?? null, t.max_hold_h ?? null],
  );
  return r.rows[0] ?? null;
}

const COLS = new Set([
  "status", "reason", "entry_sent_at", "opened_at", "client_order_id", "entry_order_id", "qty", "initial_qty", "entry_price",
  "stop_price", "take_price", "liquidation_price", "margin", "margin_added", "last_command_seq", "pending_close_reason",
  "closed_at", "exit_price", "pnl", "pnl_pct", "close_reason", "peak_pct", "be_moved", "partial_done", "leverage", "stop_kind",
]);
export async function updateTrade(id: number, patch: Partial<Trade>): Promise<Trade> {
  const keys = Object.keys(patch).filter((k) => COLS.has(k));
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const r = await pool.query<Trade>(
    `UPDATE ex_trades SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => (patch as Record<string, unknown>)[k])],
  );
  return r.rows[0]!;
}

export async function tradeById(id: number): Promise<Trade | null> {
  const r = await pool.query<Trade>("SELECT * FROM ex_trades WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}
export async function tradesForSignal(sourceSignalId: string): Promise<Trade[]> {
  await ensureExecutorTables();
  const r = await pool.query<Trade>("SELECT * FROM ex_trades WHERE source_signal_id = $1 ORDER BY id", [sourceSignalId]);
  return r.rows;
}
export async function activeTrades(accountId: string): Promise<Trade[]> {
  await ensureExecutorTables();
  const r = await pool.query<Trade>(
    "SELECT * FROM ex_trades WHERE account_id = $1 AND status IN ('opening','open','closing','unknown') ORDER BY id", [accountId],
  );
  return r.rows;
}
export async function symbolBusy(accountId: string, symbol: string, side: Side, exceptId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM ex_trades WHERE account_id = $1 AND symbol = $2 AND side = $3 AND id <> $4
       AND status IN ('opening','open','closing','unknown') LIMIT 1`,
    [accountId, symbol, side, exceptId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function event(accountId: string, trade: Pick<Trade, "id" | "source_signal_id" | "symbol"> | null, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    "INSERT INTO ex_events (account_id, trade_id, source_signal_id, symbol, kind, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [accountId, trade?.id ?? null, trade?.source_signal_id ?? null, trade?.symbol ?? null, kind, JSON.stringify(detail)],
  ).catch(() => undefined);
}

/** Trading settings of one signal source (owner 2026-11-03; for now: Nihilist). */
export type SourceSettings = {
  source: string; enabled: boolean; allocationMode: "percent" | "amount"; allocationValue: number; strategy: string; subscribers: boolean;
};
// CAB is what subscribers pay for: open to them by default; Nihilist is not (owner 2026-11-03).
// Owner 2026-11-03: both bots are open to subscribers by default; each person chooses in the cabinet.
const DEFAULT_SETTINGS = (source: string): SourceSettings =>
  ({ source, enabled: true, allocationMode: "percent", allocationValue: 1, strategy: "source", subscribers: true });

export async function getSourceSettings(source: string): Promise<SourceSettings> {
  await ensureExecutorTables();
  const r = await pool.query("SELECT * FROM ex_source_settings WHERE source = $1", [source]);
  const row = r.rows[0];
  if (!row) return DEFAULT_SETTINGS(source);
  return {
    source, enabled: row.enabled, allocationMode: row.allocation_mode === "amount" ? "amount" : "percent",
    allocationValue: Number(row.allocation_value), strategy: row.strategy, subscribers: row.subscribers,
  };
}

export async function saveSourceSettings(s: SourceSettings): Promise<SourceSettings> {
  await ensureExecutorTables();
  await pool.query(
    `INSERT INTO ex_source_settings (source, enabled, allocation_mode, allocation_value, strategy, subscribers, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (source) DO UPDATE SET enabled = EXCLUDED.enabled, allocation_mode = EXCLUDED.allocation_mode,
       allocation_value = EXCLUDED.allocation_value, strategy = EXCLUDED.strategy, subscribers = EXCLUDED.subscribers, updated_at = now()`,
    [s.source, s.enabled, s.allocationMode, s.allocationValue, s.strategy, s.subscribers],
  );
  return getSourceSettings(s.source);
}

/**
 * Bitcoin is traded apart (owner 2026-11-03): for every user (owner and each
 * subscriber) and every source (CAB, Nihilist) — on/off, its own leverage
 * (50x unless changed) and its own size (null = the same size as other coins).
 * account_key: "owner" or "sub-<subscriber id>".
 */
export const BTC_DEFAULT_LEVERAGE = 50;
export const BTC_MAX_LEVERAGE = 125;
export const BTC_SOURCES = ["cab", "nihilist"] as const;
export type BtcSettings = {
  source: string; enabled: boolean; leverage: number; allocationMode: "percent" | "amount" | null; allocationValue: number | null;
};
export const btcDefault = (source: string): BtcSettings =>
  ({ source, enabled: true, leverage: BTC_DEFAULT_LEVERAGE, allocationMode: null, allocationValue: null });

export async function getBtcSettings(accountKey: string): Promise<BtcSettings[]> {
  await ensureExecutorTables();
  const r = await pool.query("SELECT * FROM ex_btc_settings WHERE account_key = $1", [accountKey]);
  return BTC_SOURCES.map((source) => {
    const row = r.rows.find((x) => x.source === source);
    if (!row) return btcDefault(source);
    const mode = row.allocation_mode === "percent" || row.allocation_mode === "amount" ? row.allocation_mode : null;
    return { source, enabled: row.enabled, leverage: Number(row.leverage), allocationMode: mode, allocationValue: mode ? Number(row.allocation_value) : null };
  });
}

/** Validates and saves one source's BTC settings; returns an error code when the input is wrong. */
export async function saveBtcSettings(accountKey: string, b: any): Promise<{ ok: true; settings: BtcSettings[] } | { ok: false; code: string }> {
  if (!b || typeof b !== "object" || !BTC_SOURCES.includes(b.source)) return { ok: false, code: "invalid_source" };
  if (typeof b.enabled !== "boolean") return { ok: false, code: "invalid_enabled" };
  const leverage = Number(b.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > BTC_MAX_LEVERAGE) return { ok: false, code: "invalid_leverage" };
  let mode: "percent" | "amount" | null = null;
  let value: number | null = null;
  if (b.allocationMode !== null && b.allocationMode !== undefined && b.allocationMode !== "same") {
    if (b.allocationMode !== "percent" && b.allocationMode !== "amount") return { ok: false, code: "invalid_allocation_mode" };
    value = Number(b.allocationValue);
    if (!Number.isFinite(value) || value <= 0 || (b.allocationMode === "percent" && value > 100)) return { ok: false, code: "invalid_allocation_value" };
    mode = b.allocationMode;
  }
  await ensureExecutorTables();
  await pool.query(
    `INSERT INTO ex_btc_settings (account_key, source, enabled, leverage, allocation_mode, allocation_value, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (account_key, source) DO UPDATE SET enabled = EXCLUDED.enabled, leverage = EXCLUDED.leverage,
       allocation_mode = EXCLUDED.allocation_mode, allocation_value = EXCLUDED.allocation_value, updated_at = now()`,
    [accountKey, b.source, b.enabled, leverage, mode, value],
  );
  return { ok: true, settings: await getBtcSettings(accountKey) };
}
