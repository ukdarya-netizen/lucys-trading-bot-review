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
import { BOTS, isBot, ownerBotModes, ownerKeyFor, saveOwnerBotMode, type Bot, type OwnerAccountRow, type OwnerMode } from "./accounts";
import { getOwnerBotControl, productionTrading, saveOwnerBotControl } from "./trading-controls";

/** Owner 2026-11-06: each bot has its own account and its own on/off. */
export type OwnerBotInfo = {
  mode: OwnerMode; enabled: boolean;
  /** Why new trades of this bot cannot run on its account now (null — they can). */
  blockedReason: string | null;
  /** Open trades of this bot on each owner account ({ vst: 2 }): after a switch they are led to the end where they are. */
  openByMode: Partial<Record<OwnerMode, number>>;
};
export type OwnerAccountInfo = {
  /** The old single mode (kept for pages that still read it): CAB's account. */
  mode: OwnerMode; keyLast4: string | null; verifiedAt: string | null; error: string | null;
  /** A VST key is set in Secrets (used for VST when none is saved here). */
  secretsKey: boolean; secretsOff: boolean; keysStorable: boolean;
  /** All open trades of the owner's accounts. */
  openTrades: number;
  bots: Record<Bot, OwnerBotInfo>;
};

const OPEN = "('opening','open','closing','unknown')";
const MODE_NAME: Record<OwnerMode, string> = { paper: "PAPER", vst: "VST", real: "REAL" };

export async function ownerAccountInfo(): Promise<OwnerAccountInfo> {
  await ensureExecutorTables();
  const r = await pool.query("SELECT mode, key_last4, verified_at, error, api_key_encrypted, api_secret_encrypted FROM ex_owner_account WHERE id = 1");
  const row = r.rows[0] ?? null;
  const open = await pool.query<{ account_id: string; source: string; n: number }>(
    `SELECT account_id, source, count(*)::int AS n FROM ex_trades WHERE account_id LIKE 'owner-%' AND status IN ${OPEN} GROUP BY 1, 2`);
  const modes = await ownerBotModes(row);
  const bots = {} as Record<Bot, OwnerBotInfo>;
  for (const bot of BOTS) {
    const mode = modes[bot];
    const control = await getOwnerBotControl(bot);
    const openByMode: Partial<Record<OwnerMode, number>> = {};
    for (const o of open.rows.filter((x) => x.source === bot)) openByMode[o.account_id.slice("owner-".length) as OwnerMode] = o.n;
    const blockedReason = !productionTrading() ? "В dev торговля заблокирована — управление на опубликованном сайте."
      : process.env.EXECUTOR_V2 !== "1" ? "Торговый бот выключен: в Secrets нет EXECUTOR_V2=1."
      : mode !== "paper" && !ownerKeyFor(mode, row) ? `Для ${MODE_NAME[mode]} нужен ключ BingX — вставьте его выше.`
      : null;
    bots[bot] = { mode, enabled: control.enabled, blockedReason, openByMode };
  }
  return {
    mode: modes.cab, keyLast4: row?.key_last4 ?? null,
    verifiedAt: row?.verified_at ? new Date(row.verified_at).toISOString() : null, error: row?.error ?? null,
    secretsKey: Boolean(process.env.BINGX_API_KEY?.trim() && process.env.BINGX_API_SECRET?.trim()),
    secretsOff: process.env.EXECUTOR_OWNER_VST === "0",
    keysStorable: Boolean(subscriberKeysConfigured()),
    openTrades: open.rows.reduce((a, x) => a + x.n, 0),
    bots,
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

/**
 * Owner 2026-11-06: one BingX key for the owner (it serves VST and REAL), and an account per bot.
 * body: { apiKey?, apiSecret?, source?: "cab"|"nihilist", mode?: "paper"|"vst"|"real", confirmReal? }.
 * A bot may change account while it has open trades: they stay on the old account and are led to the end there.
 */
export async function saveOwnerAccount(body: any, check: KeyCheck = checkKey): Promise<SaveResult> {
  await ensureExecutorTables();
  const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const secret = typeof body?.apiSecret === "string" ? body.apiSecret.trim() : "";
  const source = body?.source;
  const mode = body?.mode;
  if (source !== undefined && !isBot(source)) return { ok: false, status: 400, message: "Неизвестный бот" };
  if (mode !== undefined && mode !== "paper" && mode !== "vst" && mode !== "real") return { ok: false, status: 400, message: "Выберите PAPER, VST или REAL" };
  if ((mode === undefined) !== (source === undefined)) return { ok: false, status: 400, message: "Укажите бота и счёт" };
  if (!key && !secret && mode === undefined) return { ok: false, status: 400, message: "Нечего сохранять" };
  if (mode === "real" && body?.confirmReal !== true) return { ok: false, status: 400, message: "Подтвердите, что торговля идёт на реальные деньги" };

  let row = (await pool.query("SELECT mode, api_key_encrypted, api_secret_encrypted FROM ex_owner_account WHERE id = 1")).rows[0] ?? null;
  const curModes = await ownerBotModes(row);
  let equity: number | null = null;

  // 1) A new key: checked on the account it is saved for (REAL if a bot goes to REAL, else VST).
  if (key || secret) {
    if (!plausibleBingXKey(key) || !plausibleBingXKey(secret)) return { ok: false, status: 400, message: "Вставьте API Key и Secret Key из BingX целиком" };
    if (!subscriberKeysConfigured()) return { ok: false, status: 503, message: "В Secrets нет SUBSCRIBER_KEYS_SECRET — ключ негде хранить зашифрованным" };
    const env: Env = mode === "real" || (mode === undefined && Object.values(curModes).includes("real")) ? "real" : "vst";
    const c = await check(env, key, secret);
    if (!c.ok) {
      await pool.query(
        `INSERT INTO ex_owner_account (id, mode, error, updated_at) VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, updated_at = now()`, [curModes.cab, c.message.slice(0, 300)]);
      return { ok: false, status: 422, message: c.message };
    }
    equity = c.equity;
    await pool.query(
      `INSERT INTO ex_owner_account (id, mode, api_key_encrypted, api_secret_encrypted, key_last4, verified_at, error, updated_at)
       VALUES (1, $1, $2, $3, $4, now(), NULL, now())
       ON CONFLICT (id) DO UPDATE SET api_key_encrypted = EXCLUDED.api_key_encrypted,
         api_secret_encrypted = EXCLUDED.api_secret_encrypted, key_last4 = EXCLUDED.key_last4, verified_at = now(), error = NULL, updated_at = now()`,
      [curModes.cab, encryptSecret(key), encryptSecret(secret), key.slice(-4)]);
    row = (await pool.query("SELECT mode, api_key_encrypted, api_secret_encrypted FROM ex_owner_account WHERE id = 1")).rows[0] ?? null;
  }

  // 2) The bot's account. VST / REAL: the key must open that account's balance right now.
  if (source && mode && mode !== curModes[source as Bot]) {
    if (mode !== "paper") {
      const k = ownerKeyFor(mode, row as OwnerAccountRow | null);
      if (!k) return { ok: false, status: 400, message: `Для ${MODE_NAME[mode as OwnerMode]} вставьте API Key и Secret Key BingX` };
      if (!(key || secret) || mode === "real") {
        try {
          equity = (await createBingX({ env: mode, key: k.key, secret: k.secret }).balance()).equity;
        } catch (e) {
          return { ok: false, status: 422, message: `BingX не открыл ${mode === "real" ? "реальный счёт" : "демо VST"} этим ключом: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
        }
      }
    }
    await saveOwnerBotMode(source as Bot, mode as OwnerMode);
  }
  return { ok: true, info: await ownerAccountInfo(), equity };
}

/** Owner 2026-11-06: new trades of one bot on/off (its account only; the other bot is not touched). */
export async function setOwnerBotTrading(source: unknown, enabled: unknown): Promise<SaveResult> {
  if (!isBot(source)) return { ok: false, status: 400, message: "Неизвестный бот" };
  if (typeof enabled !== "boolean") return { ok: false, status: 400, message: "Неверное значение" };
  if (!productionTrading()) return { ok: false, status: 409, message: "Торговлю нельзя переключать из dev. Откройте опубликованный сайт." };
  if (enabled) {
    const info = await ownerAccountInfo();
    const reason = info.bots[source].blockedReason;
    if (reason) return { ok: false, status: 409, message: reason };
  }
  await saveOwnerBotControl(source, enabled);
  return { ok: true, info: await ownerAccountInfo(), equity: null };
}

export type SignalRow = {
  sourceSignalId: string; source: "cab" | "nihilist" | "btc"; symbol: string; side: "long" | "short"; pattern: string | null;
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
      source: String(row.source_signal_id).startsWith("nh-") ? "nihilist" : String(row.source_signal_id).startsWith("btc-") ? "btc" : "cab",
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
