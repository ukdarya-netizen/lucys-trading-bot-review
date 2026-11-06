import { clerkClient, getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { SetSubscriberSourcesBody, SetSubscriberSourcesParams, SetSubscriberSourcesResponse } from "@workspace/api-zod";
import { announceRequest, botUsername, decide, send as sendTelegram, TEXT as SUB_TEXT, type Decision } from "../lib/subscriber-bot";
import { BTC_MAX_LEVERAGE, getBtcSettings, getSourceSettings, saveBtcSettings } from "../executor/store";
import { closeReasonText } from "../executor/texts";
import { subscriberTrades } from "../lib/subscriber-trades";
import { nihilistStrategy } from "../executor/plan";

type SrcStat = { closed: number; pnl: number };
async function executorStatsByAccount(): Promise<Map<string, { cab: SrcStat; nihilist: SrcStat; open: number }>> {
  const out = new Map<string, { cab: SrcStat; nihilist: SrcStat; open: number }>();
  try {
    const { rows } = await pool.query(
      `SELECT account_id, source, count(*) FILTER (WHERE status = 'closed')::int AS closed,
              coalesce(sum(pnl) FILTER (WHERE status = 'closed'), 0)::float8 AS pnl,
              count(*) FILTER (WHERE status IN ('open','closing','opening','unknown'))::int AS open
       FROM ex_trades WHERE account_id LIKE 'sub-%' GROUP BY 1, 2`);
    for (const r of rows as any[]) {
      const cur = out.get(r.account_id) ?? { cab: { closed: 0, pnl: 0 }, nihilist: { closed: 0, pnl: 0 }, open: 0 };
      if (r.source === "cab" || r.source === "nihilist") cur[r.source as "cab" | "nihilist"] = { closed: r.closed, pnl: Number(r.pnl) };
      cur.open += r.open;
      out.set(r.account_id, cur);
    }
  } catch { /* no executor tables yet */ }
  return out;
}
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { vstPerformanceRow } from "../lib/vst-performance";
// @ts-expect-error JavaScript module of the bot.
import { decryptSecret, encryptSecret, forbiddenPermissions, plausibleBingXKey, readBingXKeyPermissions, subscriberKeysConfigured } from "../bullet-bot/subscriber-keys.mjs";
// @ts-expect-error JavaScript module of the bot.
import { REAL_ACCOUNT_CAPABILITY, createBingXLiveApi } from "../bullet-bot/bingx-live-api.mjs";
// @ts-expect-error JavaScript module of the bot.
import { SUBSCRIBER_STRATEGIES, ensureSubscribersTable, subscriberAccount, subscriberSchema, subscriberTelegramLabel, subscriberTradingStrategy } from "../bullet-bot/subscriber-trading.mjs";
// @ts-expect-error JavaScript module of the bot.
import { postTelegramMessage, redactTelegramError, validateTelegramCredentials } from "../bullet-bot/telegram-client.mjs";
// @ts-expect-error JavaScript module of the bot.
import { EXIT_CHOICES, TRADE_PATTERNS, TRADE_PATTERN_LABELS, describeTradingStrategy, resolveTradingStrategy } from "../bullet-bot/trading-strategy.mjs";
// @ts-expect-error JavaScript module of the bot.
import { loadOwnerStrategy, saveOwnerStrategy } from "../bullet-bot/owner-trading-strategy.mjs";
// @ts-expect-error JavaScript module of the bot.
import { loadStrategyPaper } from "../bullet-bot/strategy-paper.mjs";
// @ts-expect-error JavaScript module of the bot.
import { ALLOCATION_LIMITS, SUBSCRIBER_LEVERAGE_CHOICES, normalizePositionProfile } from "../bullet-bot/vst-position-profile.mjs";

/**
 * Subscribers (owner's family first):
 *  - any signed-in person gets a pending request on first visit;
 *  - the owner approves / rejects / blocks in the journal;
 *  - an approved subscriber saves a BingX key (verified with a read-only
 *    VST balance request, then stored encrypted), picks a strategy and
 *    starts/stops trading. Phase 1: BingX VST demo only.
 * Keys are never returned by any endpoint.
 */
const router: IRouter = Router();

type Row = Record<string, unknown> & { id: number; status: string };
const strategies = SUBSCRIBER_STRATEGIES as Record<string, { label: string; available: boolean }>;

function publicView(row: Row) {
  return {
    id: row.id,
    status: row.status,
    email: row.email ?? null,
    name: row.name ?? null,
    requestedAt: row.requested_at,
    strategy: row.strategy ?? null,
    patternExit: (row.pattern_exit as string | null | undefined) ?? null,
    patterns: typeof row.patterns === "string" && row.patterns ? row.patterns.split(",") : [],
    strategyText: (() => {
      const resolved = subscriberTradingStrategy(row);
      return resolved ? describeTradingStrategy(resolved) : null;
    })(),
    apiKeyLast4: row.api_key_last4 ?? null,
    apiKeyVerifiedAt: row.api_key_verified_at ?? null,
    apiKeyError: row.api_key_error ?? null,
    positionSettings: {
      allocationMode: (row.allocation_mode as string | undefined) ?? "percent",
      allocationValue: Number(row.allocation_value ?? 1),
      leverage: Number(row.leverage ?? 10),
      marginMode: (row.margin_mode as string | undefined) ?? "ISOLATED",
    },
    tradingAccount: subscriberAccount(row) as "vst" | "real",
    realAllowed: Boolean(row.real_allowed),
    realKeyVerifiedAt: row.real_key_verified_at ?? null,
    keyIsOwnerMain: Boolean(row.key_is_owner_main),
    tradingEnabled: Boolean(row.trading_enabled),
    tradingStartedAt: row.trading_started_at ?? null,
    runtimeStatus: row.runtime_status ?? null,
    runtimeReason: row.runtime_reason ?? null,
    runtimeAt: row.runtime_at ?? null,
    telegramChatId: (row.telegram_chat_id as string | null | undefined) ?? null,
    telegramUsername: (row.telegram_username as string | null | undefined) ?? null,
    subscribedUntil: row.subscribed_until ?? null,
    subscriptionEnded: subscriptionEnded(row),
    tradeSources: String(row.trade_sources ?? "cab").split(",").filter(Boolean),
  };
}

/** Approved with an end date in the past (owner 2026-11-03, as CAB). */
const subscriptionEnded = (row: Row) =>
  row.status === "approved" && Boolean(row.subscribed_until) && new Date(row.subscribed_until as string).getTime() <= Date.now();

/** The owner uses the same cabinet as a subscriber ("Мой кабинет"), approved at once. */
const isOwner = (userId: string | null | undefined) =>
  Boolean(userId) && userId === process.env.JOURNAL_OWNER_USER_ID;

async function subscriberFor(req: Request): Promise<Row> {
  const row = await findOrCreateSubscriber(req);
  const userId = getAuth(req).userId;
  if (isOwner(userId) && row.status !== "approved") {
    const approved = await pool.query(
      `UPDATE subscribers SET status = 'approved', real_allowed = true, decided_at = now(), decided_by = $2,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, userId]);
    return approved.rows[0] as Row;
  }
  if (isOwner(userId) && !row.real_allowed) {
    const allowed = await pool.query(
      "UPDATE subscribers SET real_allowed = true, updated_at = now() WHERE id = $1 RETURNING *", [row.id]);
    return allowed.rows[0] as Row;
  }
  return row;
}

async function findOrCreateSubscriber(req: Request): Promise<Row> {
  const userId = getAuth(req).userId!;
  const existing = await pool.query("SELECT * FROM subscribers WHERE clerk_user_id = $1", [userId]);
  if (existing.rows[0]) return existing.rows[0] as Row;
  let email: string | null = null;
  let name: string | null = null;
  try {
    const user = await clerkClient.users.getUser(userId);
    email = user.primaryEmailAddress?.emailAddress ?? null;
    name = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
  } catch {}
  const inserted = await pool.query(
    `INSERT INTO subscribers (clerk_user_id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
     RETURNING *, (xmax = 0) AS created`,
    [userId, email, name],
  );
  if (inserted.rows[0]?.created && userId !== process.env.JOURNAL_OWNER_USER_ID) {
    // To the owner's Telegram with «Одобрить» / «Отклонить» buttons (as CAB).
    void announceRequest(inserted.rows[0] as Row).catch(() => undefined);
  }
  return inserted.rows[0] as Row;
}

// Owner 2026-10-29: every change in a cabinet is reported to the owner's
// Telegram chat (plain text). Never blocks or fails the request itself.
const ACCOUNT_NAME = (account: string) => (account === "real" ? "РЕАЛЬНЫЙ счёт" : "демо-счёт VST");
function notifyOwner(row: Row, lines: (string | null | undefined | false)[]) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = [subscriberTelegramLabel(row), ...lines.filter(Boolean)].join("\n");
  void (async () => {
    try {
      validateTelegramCredentials(token, chatId);
      await postTelegramMessage({ token, chatId, text, fetcher: fetch });
    } catch (error) {
      process.stderr.write(`Cabinet notice failed: ${redactTelegramError(error)}\n`);
    }
  })();
}
function sizeText(row: Row) {
  const unit = subscriberAccount(row) === "real" ? "USDT" : "VST";
  const size = row.allocation_mode === "amount" ? `${Number(row.allocation_value)} ${unit}` : `${Number(row.allocation_value)}% от баланса`;
  return `${size} · ${row.margin_mode === "CROSSED" ? "кросс" : "изолированная"} · ${Number(row.leverage)}x`;
}

function refuse(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

async function schemaExists(id: number, account: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'vst_positions'",
    [subscriberSchema(id, account)],
  );
  return Boolean(result.rowCount);
}

/** Read-only balance check of a key on the REAL BingX account (USDT). */
async function realAccountBalance(key: string, secret: string): Promise<string | null> {
  const api = createBingXLiveApi({
    environment: "vst", account: REAL_ACCOUNT_CAPABILITY,
    credentials: () => ({ key, secret }), writePermission: () => false,
  });
  const balance = await api.getBalance();
  const row = (balance as { balance?: { balance?: string; equity?: string } } | null)?.balance;
  return row?.balance ?? row?.equity ?? null;
}

/** Open positions on BOTH accounts (a switched-away account may still be closing trades). */
async function openPositionsAnywhere(id: number): Promise<number> {
  const [vst, real] = await Promise.all([performance(id, "vst"), performance(id, "real")]);
  return vst.openPositions + real.openPositions;
}

async function performance(id: number, account = "vst") {
  if (!(await schemaExists(id, account))) return { trades: [], openPositions: 0 };
  const schema = subscriberSchema(id, account) as string;
  const [closed, open] = await Promise.all([
    pool.query(
      `SELECT p.source_signal_id, p.symbol, p.snapshot, p.updated_at, s.body->>'patternId' AS pattern_id
       FROM ${schema}.vst_positions p LEFT JOIN ${schema}.vst_signals s ON s.source_signal_id = p.source_signal_id
       WHERE p.status = 'closed' ORDER BY p.updated_at DESC LIMIT 2000`,
    ),
    pool.query(`SELECT count(*)::int AS n FROM ${schema}.vst_positions WHERE status IN ('open','closing','unknown')`),
  ]);
  return { trades: closed.rows.map(vstPerformanceRow), openPositions: open.rows[0]?.n ?? 0 };
}

// The table creates itself on first use (no drizzle push needed).
router.use(["/me", "/journal/subscribers"], async (_req, _res, next) => {
  try {
    await ensureSubscribersTable(pool);
    next();
  } catch (error) {
    next(error);
  }
});

// ---------------- subscriber (any signed-in person) ----------------

router.use("/me", requireJournalSession);

router.get("/me/subscription", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  res.json({
    subscription: publicView(row),
    strategies: Object.entries(strategies).map(([id, s]) => ({ id, label: s.label, available: s.available })),
    strategyChoices: strategyChoices(),
    keysConfigured: subscriberKeysConfigured(),
    telegramBot: await botUsername().catch(() => null),
    positionChoices: { leverage: SUBSCRIBER_LEVERAGE_CHOICES, allocation: ALLOCATION_LIMITS },
  });
});

router.get("/me/strategy-paper", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  res.json(await loadStrategyPaper(pool, { patterns: patternsQuery(req), days: daysQuery(req) }));
});

// The person's trades in the new trading bot, by signal source (owner 2026-11-03).
router.get("/me/results", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  try {
    const { rows } = await pool.query(
      `SELECT source, symbol, side, status, close_reason, pnl, pnl_pct, opened_at, closed_at FROM ex_trades
       WHERE account_id = $1 AND status IN ('open','closing','closed') ORDER BY coalesce(closed_at, opened_at) DESC NULLS LAST LIMIT 300`, [`sub-${row.id}-vst`]);
    res.json({ trades: rows.map((t: any) => ({
      source: t.source, symbol: t.symbol, side: t.side, status: t.status, closeReason: t.close_reason,
      closeText: t.close_reason ? closeReasonText(t.close_reason, t.source) : null,
      pnl: t.pnl === null ? null : Number(t.pnl), pnlPct: t.pnl_pct === null ? null : Number(t.pnl_pct), openedAt: t.opened_at, closedAt: t.closed_at,
    })) });
  } catch {
    res.json({ trades: [] });
  }
});

// Owner 2026-11-06: the subscriber's own positions and history for the subscriber pages (own accounts only).
router.get("/me/trades", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const scope = req.query.scope === "open" || req.query.scope === "closed" ? req.query.scope : "all";
  const days = Number(req.query.days ?? 90);
  try {
    res.json(await subscriberTrades(row.id, { scope, days: Number.isFinite(days) ? days : 90 }));
  } catch {
    res.status(503).json({ error: { code: "trades_unavailable", message: "Не удалось загрузить сделки" } });
  }
});

router.get("/me/performance", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const perf = await performance(row.id, subscriberAccount(row));
  res.json({ ...perf, openPositions: await openPositionsAnywhere(row.id) });
});

router.post("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (!subscriberKeysConfigured()) {
    return refuse(res, 503, "keys_secret_missing", "Хранилище ключей не настроено владельцем");
  }
  if ((await openPositionsAnywhere(row.id)) > 0) {
    return refuse(res, 409, "positions_open", "Есть открытые сделки: ключ можно заменить после их закрытия");
  }
  const apiKey = String(req.body?.apiKey ?? "").trim();
  const apiSecret = String(req.body?.apiSecret ?? "").trim();
  if (!plausibleBingXKey(apiKey) || !plausibleBingXKey(apiSecret)) {
    return refuse(res, 422, "key_format", "Ключ и секрет — это латинские буквы и цифры из BingX");
  }
  // The owner's main bot trades the DEMO (VST) account of BINGX_API_KEY. The
  // same key is fine for REAL, but never for a second bot on that demo account.
  const keyIsOwnerMain = Boolean(process.env.BINGX_API_KEY) && apiKey === process.env.BINGX_API_KEY!.trim();
  // 1) The key must not be able to move money (withdraw / transfers).
  let permissions: number[];
  try {
    permissions = (await readBingXKeyPermissions({ key: apiKey, secret: apiSecret })).permissions;
  } catch (error) {
    const message = error instanceof Error ? error.message : "BingX error";
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, message.slice(0, 300)]);
    return refuse(res, 422, "key_permissions_unverified", `Не удалось проверить права ключа: ${message.slice(0, 200)}`);
  }
  const forbidden = forbiddenPermissions(permissions) as number[];
  if (forbidden.length) {
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, `key_has_money_moving_permissions:${forbidden.join(",")}`]);
    return refuse(res, 422, "key_can_withdraw",
      "У ключа включён вывод или перевод средств. Создайте ключ только с правами «чтение» и «торговля фьючерсами».");
  }
  // 2) Read-only check on the VST demo account with this exact key.
  const api = createBingXLiveApi({
    environment: "vst",
    credentials: () => ({ key: apiKey, secret: apiSecret }),
    writePermission: () => false,
  });
  let balance: unknown = null;
  try {
    balance = await api.getBalance();
  } catch (error) {
    const message = error instanceof Error ? error.message : "BingX error";
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, message.slice(0, 300)]);
    return refuse(res, 422, "key_rejected", `BingX не принял ключ: ${message.slice(0, 200)}`);
  }
  // 3) Read-only check on the REAL account; failure only means REAL is unavailable.
  let balanceReal: string | null = null;
  let realOk = false;
  try { balanceReal = await realAccountBalance(apiKey, apiSecret); realOk = true; } catch {}
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = $2, api_secret_encrypted = $3, api_key_last4 = $4,
       api_key_verified_at = now(), api_key_error = NULL, key_is_owner_main = $5,
       real_key_verified_at = CASE WHEN $6 THEN now() ELSE NULL END,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id, encryptSecret(apiKey), encryptSecret(apiSecret), apiKey.slice(-4), keyIsOwnerMain, realOk],
  );
  const vst = (balance as { balance?: { balance?: string; equity?: string } } | null)?.balance;
  notifyOwner(row, [`Ключ BingX сохранён (••••${apiKey.slice(-4)}).`,
    `Демо-счёт: ключ подходит. Реальный счёт: ${realOk ? "ключ подходит" : "ключ НЕ принят"}.`]);
  res.json({ verified: true, balanceVst: vst?.balance ?? vst?.equity ?? null, balanceReal, realVerified: realOk });
});

router.delete("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  // Without the key the bot cannot manage open positions (stop, take, close).
  if ((await openPositionsAnywhere(row.id)) > 0) {
    return refuse(res, 409, "positions_open", "Есть открытые сделки: ключ можно удалить после их закрытия");
  }
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = NULL, api_secret_encrypted = NULL, api_key_last4 = NULL,
       api_key_verified_at = NULL, real_key_verified_at = NULL, key_is_owner_main = false, trading_enabled = false, trading_stopped_at = now(),
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id],
  );
  notifyOwner(row, ["Ключ BingX удалён. Торговля остановлена."]);
  res.json({ removed: true });
});

/** Choices for the strategy pickers (subscriber cabinet and owner journal). */
function strategyChoices() {
  return {
    strategies: Object.entries(strategies).map(([id, s]) => ({ id, label: s.label })),
    exits: Object.entries(EXIT_CHOICES as Record<string, { label: string }>)
      .map(([id, e]) => ({ id, label: e.label })),
    patterns: (TRADE_PATTERNS as string[]).map((id) => ({
      id, label: (TRADE_PATTERN_LABELS as Record<string, string>)[id] })),
  };
}

type StrategyChoice = { strategy: string; patternExit: string | null; patterns: string[] | null };
function strategyChoiceFrom(body: unknown): StrategyChoice | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const choice = {
    strategy: String(b.strategy ?? ""),
    patternExit: b.strategy === "patterns" ? String(b.patternExit ?? "") : null,
    patterns: b.strategy === "patterns" && Array.isArray(b.patterns) ? b.patterns.map(String) : null,
  };
  try {
    const resolved = resolveTradingStrategy(choice);
    return { strategy: resolved.strategy, patternExit: resolved.patternExit ?? null,
      patterns: resolved.patterns ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid_strategy" };
  }
}
const STRATEGY_ERRORS: Record<string, string> = {
  unknown_strategy: "Такой стратегии нет",
  pattern_exit_required: "Выберите выход для стратегии «По паттернам»",
  patterns_must_be_1_to_3_of_4: "Выберите от 1 до 3 паттернов",
};

router.post("/me/strategy", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const choice = strategyChoiceFrom(req.body);
  if ("error" in choice) return refuse(res, 422, choice.error, STRATEGY_ERRORS[choice.error] ?? "Неверная стратегия");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  await pool.query(
    `UPDATE subscribers SET strategy = $2, pattern_exit = $3, patterns = $4,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, choice.strategy, choice.patternExit, choice.patterns?.join(",") ?? null]);
  {
    const resolved = subscriberTradingStrategy({ strategy: choice.strategy, pattern_exit: choice.patternExit,
      patterns: choice.patterns?.join(",") ?? null });
    notifyOwner(row, [`Стратегия изменена: ${resolved ? describeTradingStrategy(resolved) : choice.strategy}.`]);
  }
  res.json(choice);
});

// Telegram of the subscriber (owner 2026-11-03, as CAB): Chat ID from /start in the trading bot's Telegram.
router.post("/me/telegram", async (req, res) => {
  const row = await subscriberFor(req);
  const raw = String(req.body?.chatId ?? "").trim();
  if (raw === "") {
    await pool.query("UPDATE subscribers SET telegram_chat_id = NULL, telegram_username = NULL, updated_at = now() WHERE id = $1", [row.id]);
    return res.json({ telegramChatId: null });
  }
  if (!/^-?\d{5,20}$/.test(raw)) return refuse(res, 422, "chat_id", "Chat ID — это число, его присылает бот в ответ на /start");
  const taken = await pool.query("SELECT 1 FROM subscribers WHERE telegram_chat_id = $1 AND id <> $2", [raw, row.id]);
  if (taken.rowCount) return refuse(res, 409, "chat_id_taken", "Этот Telegram уже привязан к другому кабинету");
  const updated = (await pool.query("UPDATE subscribers SET telegram_chat_id = $2, updated_at = now() WHERE id = $1 RETURNING *", [row.id, raw])).rows[0] as Row;
  // A test message proves the bot can write there (the person pressed /start).
  if (!(await sendTelegram(raw, SUB_TEXT.linked(updated)))) {
    await pool.query("UPDATE subscribers SET telegram_chat_id = NULL WHERE id = $1", [row.id]);
    const name = await botUsername();
    return refuse(res, 422, "chat_unreachable", `Бот не может вам написать. Откройте ${name ? `@${name}` : "бота"} в Telegram, нажмите /start и сохраните Chat ID снова`);
  }
  res.json({ telegramChatId: raw });
});

// Which signals the person trades (owner 2026-11-03): CAB, Nihilist or both; Nihilist only when the owner opened it.
router.get("/me/sources", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  const [cab, nh] = await Promise.all([getSourceSettings("cab"), getSourceSettings("nihilist")]);
  const m = nihilistStrategy(nh.strategy);
  res.json({ chosen: String(row.trade_sources ?? "cab").split(",").filter(Boolean), available: { cab: cab.subscribers, nihilist: nh.subscribers }, nihilistStrategy: { id: m.id, label: m.label } });
});
router.post("/me/sources", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const list = Array.isArray(req.body?.sources) ? [...new Set(req.body.sources.map(String))] as string[] : null;
  if (!list || !list.length || list.some((s) => s !== "cab" && s !== "nihilist")) return refuse(res, 422, "sources", "Выберите хотя бы один бот: CAB или Нигилист");
  const [cab, nh] = await Promise.all([getSourceSettings("cab"), getSourceSettings("nihilist")]);
  if ((list.includes("cab") && !cab.subscribers) || (list.includes("nihilist") && !nh.subscribers)) {
    return refuse(res, 403, "source_closed", "Этот бот пока закрыт для подписчиков");
  }
  const value = ["cab", "nihilist"].filter((s) => list.includes(s)).join(",");
  await pool.query("UPDATE subscribers SET trade_sources = $2, version = version + 1, updated_at = now() WHERE id = $1", [row.id, value]);
  notifyOwner(row, [`Сигналы для торговли: ${value.split(",").map((s) => (s === "cab" ? "CAB" : "Нигилист")).join(" + ")}.`]);
  res.json({ chosen: value.split(",") });
});

// Bitcoin apart (owner 2026-11-03): per source on/off, leverage (50x default), own size.
router.get("/me/btc-settings", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  res.json({ settings: await getBtcSettings(`sub-${row.id}`), maxLeverage: BTC_MAX_LEVERAGE });
});
router.post("/me/btc-settings", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const out = await saveBtcSettings(`sub-${row.id}`, req.body);
  if (!out.ok) return refuse(res, 422, out.code, "Проверьте значения: плечо от 1 до 125, процент от 0.1 до 100, сумма больше 0");
  res.json({ settings: out.settings, maxLeverage: BTC_MAX_LEVERAGE });
});

router.post("/me/position-settings", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  // Open positions are managed with the leverage/margin they were opened with.
  if ((await openPositionsAnywhere(row.id)) > 0) {
    return refuse(res, 409, "positions_open", "Дождитесь закрытия открытых сделок, потом меняйте настройки");
  }
  const leverage = Number(req.body?.leverage);
  if (!(SUBSCRIBER_LEVERAGE_CHOICES as number[]).includes(leverage)) {
    return refuse(res, 422, "leverage", "Такого плеча нет в списке");
  }
  let profile: { leverage: number; marginMode: string; allocation: { mode: string; value: number } };
  try {
    profile = normalizePositionProfile({
      leverage,
      marginMode: String(req.body?.marginMode ?? ""),
      allocation: { mode: String(req.body?.allocationMode ?? ""), value: Number(req.body?.allocationValue) },
    });
  } catch {
    return refuse(res, 422, "position_settings", "Проверьте значения: процент от 0.1 до 100, сумма от 1");
  }
  await pool.query(
    `UPDATE subscribers SET allocation_mode = $2, allocation_value = $3, leverage = $4, margin_mode = $5,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, profile.allocation.mode, String(profile.allocation.value), profile.leverage, profile.marginMode],
  );
  notifyOwner(row, [`Размер сделки изменён: ${sizeText({ ...row, allocation_mode: profile.allocation.mode,
    allocation_value: profile.allocation.value, leverage: profile.leverage, margin_mode: profile.marginMode } as Row)}.`]);
  res.json({
    positionSettings: {
      allocationMode: profile.allocation.mode, allocationValue: profile.allocation.value,
      leverage: profile.leverage, marginMode: profile.marginMode,
    },
  });
});

// Account: "vst" (demo) or "real". Switch only when stopped and flat.
router.post("/me/account", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const account = String(req.body?.account ?? "");
  if (account !== "vst" && account !== "real") return refuse(res, 422, "account", "Такого счёта нет");
  if (account === subscriberAccount(row)) return res.json({ account });
  // Open trades on the old account are not a blocker: the bot keeps managing
  // them there (stops, takes, CAB closes) until they are closed.
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала нажмите «Стоп»");
  let realVerified = Boolean(row.real_key_verified_at);
  if (account === "real") {
    if (!row.real_allowed) return refuse(res, 403, "real_not_allowed", "Владелец не разрешил реальный счёт");
    if (req.body?.confirm !== true) return refuse(res, 422, "confirm", "Подтвердите торговлю на реальные деньги");
    // Without a key yet the account is just chosen; the key is checked on the
    // real account when it is saved, and "Старт" requires that check.
    if (row.api_key_encrypted && row.api_secret_encrypted) try {
      await realAccountBalance(decryptSecret(row.api_key_encrypted as string), decryptSecret(row.api_secret_encrypted as string));
      realVerified = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "BingX error";
      return refuse(res, 422, "real_key_rejected", `Реальный счёт BingX не принял ключ: ${message.slice(0, 200)}`);
    }
  }
  await pool.query(
    `UPDATE subscribers SET trading_account = $2,
       real_key_verified_at = CASE WHEN $3 THEN COALESCE(real_key_verified_at, now()) ELSE real_key_verified_at END,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, account, realVerified]);
  notifyOwner(row, [`Счёт переключён: ${ACCOUNT_NAME(subscriberAccount(row))} → ${ACCOUNT_NAME(account)}.`,
    "Торговля начнётся после «Старт»."]);
  res.json({ account });
});

router.post("/me/trading", async (req, res) => {
  const row = await subscriberFor(req);
  const enable = req.body?.enabled === true;
  if (enable) {
    if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
    if (subscriptionEnded(row)) return refuse(res, 403, "subscription_ended", "Подписка закончилась — продлите её у владельца");
    if (!row.api_key_verified_at) return refuse(res, 422, "no_key", "Сначала добавьте и проверьте ключ BingX");
    // A CAB strategy is needed only when the person trades CAB signals (Nihilist is led by the owner's rules).
    if (String(row.trade_sources ?? "cab").split(",").includes("cab") && !subscriberTradingStrategy(row)) {
      return refuse(res, 422, "no_strategy", "Выберите стратегию CAB");
    }
    if (subscriberAccount(row) === "vst" && row.key_is_owner_main) {
      return refuse(res, 409, "same_as_owner_bot",
        "На демо-счёте этого ключа уже торгует основной бот. Выберите реальный счёт или ключ другого аккаунта BingX.");
    }
    if (subscriberAccount(row) === "real" && (!row.real_allowed || !row.real_key_verified_at)) {
      return refuse(res, 403, "real_not_ready", "Реальный счёт не разрешён владельцем или ключ не проверен на реальном счёте");
    }
    await pool.query(
      "UPDATE subscribers SET trading_enabled = true, trading_started_at = now(), updated_at = now() WHERE id = $1",
      [row.id],
    );
  } else {
    const account = subscriberAccount(row);
    // Announced here (always, at once); the worker sees this state and does not repeat it.
    await pool.query(
      `UPDATE subscribers SET trading_enabled = false, trading_stopped_at = now(), updated_at = now(),
         trading_notice = $2 WHERE id = $1`,
      [row.id, `${account}:off`],
    );
    if (row.trading_enabled) {
      const open = await openPositionsAnywhere(row.id);
      notifyOwner(row, [`BingX ${account === "real" ? "REAL" : "VST"} · Нажат «Стоп»: торговля на ${account === "real" ? "РЕАЛЬНОМ счёте" : "демо-счёте"} остановлена.`,
        open ? `Новые сделки не открываются; открытые (${open}) бот доведёт до закрытия.` : "Открытых сделок нет."]);
    }
  }
  res.json({ tradingEnabled: enable });
});

// ---------------- owner ----------------

// The owner's own strategy (owner 2026-10-28). Applies to the owner's bot's
// NEW entries within ~15 s; open positions keep the strategy they opened with.
router.get("/journal/trading-strategy", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const current = await loadOwnerStrategy(pool);
  res.json({
    strategy: current.strategy, patternExit: current.patternExit ?? null,
    patterns: current.patterns ?? [], strategyText: describeTradingStrategy(current),
    updatedAt: current.updatedAt, choices: strategyChoices(),
  });
});

// Background PAPER per strategy (% to the deposit), same for owner and subscribers.
function daysQuery(req: Request): number | null {
  const days = Number(req.query.days);
  return [7, 30, 90].includes(days) ? days : null;
}
function patternsQuery(req: Request): string[] {
  const raw = typeof req.query.patterns === "string" ? req.query.patterns : "";
  return raw.split(",").map((p) => p.trim()).filter((p) => (TRADE_PATTERNS as string[]).includes(p)).slice(0, 3);
}
router.get("/journal/strategy-paper", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await loadStrategyPaper(pool, { patterns: patternsQuery(req), days: daysQuery(req) }));
});

router.post("/journal/trading-strategy", requireJournalSession, requireJournalOwner, async (req, res) => {
  const choice = strategyChoiceFrom(req.body);
  if ("error" in choice) return refuse(res, 422, choice.error, STRATEGY_ERRORS[choice.error] ?? "Неверная стратегия");
  const saved = await saveOwnerStrategy(pool, choice);
  res.json({ strategy: saved.strategy, patternExit: saved.patternExit ?? null,
    patterns: saved.patterns ?? [], strategyText: describeTradingStrategy(saved) });
});

// Owner: allow / forbid the REAL account for a person. Forbidding stops new
// entries at once; open REAL positions keep being managed until closed.
router.post("/journal/subscribers/:id/real", requireJournalSession, requireJournalOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return refuse(res, 422, "invalid_id", "Неверный подписчик");
  const allowed = req.body?.allowed === true;
  const result = await pool.query(
    `UPDATE subscribers SET real_allowed = $2,
       trading_enabled = CASE WHEN $2 = false AND trading_account = 'real' THEN false ELSE trading_enabled END,
       updated_at = now() WHERE id = $1 RETURNING *`,
    [id, allowed]);
  if (!result.rowCount) return refuse(res, 404, "not_found", "Подписчик не найден");
  notifyOwner(result.rows[0] as Row, [allowed ? "Владелец разрешил реальный счёт."
    : "Владелец закрыл реальный счёт: новые реальные сделки не открываются, открытые доводятся до закрытия."]);
  res.json({ subscriber: publicView(result.rows[0] as Row) });
});

router.get("/journal/subscribers", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { rows } = await pool.query("SELECT * FROM subscribers ORDER BY status = 'pending' DESC, requested_at DESC");
  // Results of the new trading bot per person and signal source (owner 2026-11-03).
  const ex = await executorStatsByAccount();
  const list = (rows as Row[]).map((row) => {
    const s = ex.get(`sub-${row.id}-vst`);
    const stats = {
      closed: s ? s.cab.closed + s.nihilist.closed : 0,
      netUsdt: s ? Number((s.cab.pnl + s.nihilist.pnl).toFixed(4)) : 0,
      openPositions: s ? s.open : 0,
      bySource: s ? { cab: s.cab, nihilist: s.nihilist } : { cab: { closed: 0, pnl: 0 }, nihilist: { closed: 0, pnl: 0 } },
    };
    return { ...publicView(row), stats };
  });
  res.json({ subscribers: list, keysConfigured: subscriberKeysConfigured() });
});

router.post("/journal/subscribers/:id/sources", requireJournalSession, requireJournalOwner, async (req, res) => {
  const params = SetSubscriberSourcesParams.safeParse(req.params);
  if (!params.success) return refuse(res, 400, "invalid_subscriber_id", "Неверный идентификатор подписчика");
  const body = SetSubscriberSourcesBody.safeParse(req.body);
  if (!body.success) return refuse(res, 400, "invalid_sources", "Выберите Crypto Alts Bullet, Nihilyst Crypto Trading или оба бота");
  if (new Set(body.data.sources).size !== body.data.sources.length) {
    return refuse(res, 400, "duplicate_sources", "Каждый бот можно выбрать только один раз");
  }

  const sources = (["cab", "nihilist"] as const).filter((source) => body.data.sources.includes(source));
  const value = sources.join(",");
  const updated = await pool.query(
    `UPDATE subscribers SET trade_sources = $2, version = version + 1, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'approved')
     RETURNING id, trade_sources`,
    [params.data.id, value],
  );
  if (!updated.rowCount) {
    const existing = await pool.query("SELECT id FROM subscribers WHERE id = $1", [params.data.id]);
    if (!existing.rowCount) return refuse(res, 404, "not_found", "Подписчик не найден");
    return refuse(res, 409, "subscription_not_editable", "Доступ можно менять только для новой заявки или одобренной подписки");
  }

  const row = updated.rows[0] as { id: number; trade_sources: string };
  res.json(SetSubscriberSourcesResponse.parse({
    id: Number(row.id),
    tradeSources: String(row.trade_sources).split(",").filter(Boolean),
  }));
});

router.post("/journal/subscribers/:id/decision", requireJournalSession, requireJournalOwner, async (req, res) => {
  const id = Number(req.params.id);
  // "extend" = approve again: one more month (owner 2026-11-03, as CAB). The subscriber is told in Telegram.
  const raw = String(req.body?.decision ?? "");
  const decision = (raw === "extend" ? "approve" : raw) as Decision;
  if (!Number.isSafeInteger(id) || !["approve", "reject", "block", "unblock"].includes(decision)) return refuse(res, 422, "invalid_decision", "Неверное решение");
  const out = await decide(id, decision, String(getAuth(req).userId ?? "owner"));
  if (!out) return refuse(res, 404, "not_found", "Подписчик не найден");
  res.json({ subscriber: publicView(out.row as Row) });
});

export default router;
