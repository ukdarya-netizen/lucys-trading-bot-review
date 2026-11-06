/**
 * The owner's main account in «Мой кабинет» (owner 2026-11-04): PAPER, VST demo or REAL money, and the
 * BingX key for it — entered on the site, checked (no withdraw / transfer rights, the balance reads),
 * stored encrypted with SUBSCRIBER_KEYS_SECRET. Without a saved key VST uses the key from Secrets.
 * Also the list of received signals with what each account did with them.
 */
import { pool } from "@workspace/db";
// @ts-expect-error JavaScript module of the bot.
import { encryptSecret, forbiddenPermissions, plausibleBingXKey, readBingXKeyPermissions, subscriberKeysConfigured } from "../bullet-bot/subscriber-keys.mjs";
import { createBingX, type Env } from "./bingx";
import { REASON_TEXT } from "./engine";
import { ensureExecutorTables } from "./store";
import type { OwnerMode } from "./accounts";

export type OwnerAccountInfo = {
  mode: OwnerMode; keyLast4: string | null; verifiedAt: string | null; error: string | null;
  /** A VST key is set in Secrets (used for VST when none is saved here). */
  secretsKey: boolean; secretsOff: boolean; keysStorable: boolean;
  /** Trades of the main account still open (switching the mode is refused while they are). */
  openTrades: number;
};

const OPEN = "('opening','open','closing','unknown')";

export async function ownerAccountInfo(): Promise<OwnerAccountInfo> {
  await ensureExecutorTables();
  const r = await pool.query("SELECT mode, key_last4, verified_at, error FROM ex_owner_account WHERE id = 1");
  const row = r.rows[0];
  const open = await pool.query(`SELECT count(*)::int AS n FROM ex_trades WHERE account_id LIKE 'owner-%' AND status IN ${OPEN}`);
  return {
    mode: (row?.mode as OwnerMode) ?? "vst", keyLast4: row?.key_last4 ?? null,
    verifiedAt: row?.verified_at ? new Date(row.verified_at).toISOString() : null, error: row?.error ?? null,
    secretsKey: Boolean(process.env.BINGX_API_KEY?.trim() && process.env.BINGX_API_SECRET?.trim()),
    secretsOff: process.env.EXECUTOR_OWNER_VST === "0",
    keysStorable: Boolean(subscriberKeysConfigured()),
    openTrades: open.rows[0]?.n ?? 0,
  };
}

export type KeyCheck = (env: Env, key: string, secret: string) => Promise<{ ok: true; equity: number } | { ok: false; message: string }>;

/** Live check: no money-moving rights, and the balance of that account reads with this key. */
export const checkKey: KeyCheck = async (env, key, secret) => {
  try {
    const perms = (await readBingXKeyPermissions({ key, secret })).permissions as number[];
    const bad = forbiddenPermissions(perms) as number[];
    if (bad.length) return { ok: false, message: "У ключа включён вывод или перевод средств. Создайте ключ только с правами «чтение» и «торговля фьючерсами»." };
  } catch (e) {
    return { ok: false, message: `Не удалось проверить права ключа: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
  }
  try {
    const b = await createBingX({ env, key, secret }).balance();
    return { ok: true, equity: b.equity };
  } catch (e) {
    return { ok: false, message: `BingX не принял ключ (${env === "real" ? "реальный счёт" : "демо VST"}): ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
  }
};

export type SaveResult = { ok: true; info: OwnerAccountInfo; equity: number | null } | { ok: false; status: number; message: string };

export async function saveOwnerAccount(body: any, check: KeyCheck = checkKey): Promise<SaveResult> {
  await ensureExecutorTables();
  const mode = body?.mode;
  if (mode !== "paper" && mode !== "vst" && mode !== "real") return { ok: false, status: 400, message: "Выберите PAPER, VST или REAL" };
  const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const secret = typeof body?.apiSecret === "string" ? body.apiSecret.trim() : "";
  if (mode === "real" && body?.confirmReal !== true) return { ok: false, status: 400, message: "Подтвердите, что торговля идёт на реальные деньги" };
  const cur = (await pool.query("SELECT mode, api_key_encrypted FROM ex_owner_account WHERE id = 1")).rows[0] ?? null;
  const curMode: OwnerMode = cur?.mode ?? "vst";
  if (mode !== curMode) {
    const open = await pool.query(`SELECT count(*)::int AS n FROM ex_trades WHERE account_id LIKE 'owner-%' AND status IN ${OPEN}`);
    if ((open.rows[0]?.n ?? 0) > 0) {
      return { ok: false, status: 409, message: `Сначала дождитесь закрытия открытых сделок (${open.rows[0].n}) или закройте их: после смены счёта бот перестанет их вести.` };
    }
  }
  let equity: number | null = null;
  if (key || secret) {
    if (mode === "paper") return { ok: false, status: 400, message: "Для PAPER ключ не нужен" };
    if (!plausibleBingXKey(key) || !plausibleBingXKey(secret)) return { ok: false, status: 400, message: "Вставьте API Key и Secret Key из BingX целиком" };
    if (!subscriberKeysConfigured()) return { ok: false, status: 503, message: "В Secrets нет SUBSCRIBER_KEYS_SECRET — ключ негде хранить зашифрованным" };
    const c = await check(mode, key, secret);
    if (!c.ok) {
      await pool.query(
        `INSERT INTO ex_owner_account (id, mode, error, updated_at) VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, updated_at = now()`, [curMode, c.message.slice(0, 300)]);
      return { ok: false, status: 422, message: c.message };
    }
    equity = c.equity;
    await pool.query(
      `INSERT INTO ex_owner_account (id, mode, api_key_encrypted, api_secret_encrypted, key_last4, verified_at, error, updated_at)
       VALUES (1, $1, $2, $3, $4, now(), NULL, now())
       ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, api_key_encrypted = EXCLUDED.api_key_encrypted,
         api_secret_encrypted = EXCLUDED.api_secret_encrypted, key_last4 = EXCLUDED.key_last4, verified_at = now(), error = NULL, updated_at = now()`,
      [mode, encryptSecret(key), encryptSecret(secret), key.slice(-4)]);
  } else {
    if (mode === "real" && !cur?.api_key_encrypted) return { ok: false, status: 400, message: "Для REAL вставьте API Key и Secret Key" };
    if (mode === "vst" && !cur?.api_key_encrypted && !(process.env.BINGX_API_KEY?.trim() && process.env.BINGX_API_SECRET?.trim())) {
      return { ok: false, status: 400, message: "Для VST вставьте API Key и Secret Key" };
    }
    await pool.query(
      `INSERT INTO ex_owner_account (id, mode, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`, [mode]);
  }
  return { ok: true, info: await ownerAccountInfo(), equity };
}

export type SignalRow = {
  sourceSignalId: string; source: "cab" | "nihilist"; symbol: string; side: "long" | "short"; pattern: string | null;
  signalAt: string | null; receivedAt: string; entry: number | null; stop: number | null;
  trades: Array<{ id: number; accountId: string; status: string; reason: string | null; reasonText: string | null; pnl: number | null }>;
};

/** Signals received in the last `days` days, newest first, with each account's trade (or none). */
export async function listSignals(days: number): Promise<SignalRow[]> {
  await ensureExecutorTables();
  const d = Math.min(30, Math.max(1, Math.round(days) || 3));
  const r = await pool.query(
    `SELECT i.source_signal_id, i.body, i.received_at,
       COALESCE(json_agg(json_build_object('id', t.id, 'accountId', t.account_id, 'status', t.status, 'reason', t.reason, 'pnl', t.pnl)
         ORDER BY t.account_id) FILTER (WHERE t.id IS NOT NULL), '[]') AS trades
     FROM ex_inbox i LEFT JOIN ex_trades t ON t.source_signal_id = i.source_signal_id
     WHERE i.kind = 'signal' AND i.received_at > now() - make_interval(days => $1)
     GROUP BY i.id ORDER BY i.received_at DESC LIMIT 500`, [d]);
  const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return r.rows.map((row) => {
    const b = row.body ?? {};
    const sideRaw = String(b.side ?? "").toLowerCase();
    return {
      sourceSignalId: row.source_signal_id,
      source: String(row.source_signal_id).startsWith("nh-") ? "nihilist" : "cab",
      symbol: String(b.symbol ?? "").toUpperCase(),
      side: sideRaw === "sell" || sideRaw === "short" ? "short" : "long",
      pattern: typeof b.patternId === "string" ? b.patternId : typeof b.setup === "string" ? b.setup : null,
      signalAt: b.signalAt ? String(b.signalAt) : null,
      receivedAt: new Date(row.received_at).toISOString(),
      entry: n(b.referencePrice ?? b.entryPrice), stop: n(b.stopLoss),
      trades: (row.trades as SignalRow["trades"]).map((t) => ({ ...t, reasonText: t.reason ? REASON_TEXT[t.reason] ?? t.reason : null })),
    };
  });
}
