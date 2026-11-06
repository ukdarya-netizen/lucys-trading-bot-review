/**
 * Executor ledger (owner 2026-11-02 rewrite; artifacts/api-server/src/executor/store.ts
 * creates the same tables at start). Declared here so a publish never drops them.
 */
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

export const exInboxTable = pgTable("ex_inbox", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  messageId: text("message_id").notNull().unique(),
  sourceSignalId: text("source_signal_id").notNull(),
  body: jsonb("body").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const exTradesTable = pgTable("ex_trades", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull(),
  source: text("source").notNull(),
  sourceSignalId: text("source_signal_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  pattern: text("pattern"),
  env: text("env").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  takePct: doublePrecision("take_pct"),
  signalAt: timestamp("signal_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  entrySentAt: timestamp("entry_sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clientOrderId: text("client_order_id"),
  entryOrderId: text("entry_order_id"),
  qty: doublePrecision("qty"),
  initialQty: doublePrecision("initial_qty"),
  entryPrice: doublePrecision("entry_price"),
  stopPrice: doublePrecision("stop_price"),
  takePrice: doublePrecision("take_price"),
  liquidationPrice: doublePrecision("liquidation_price"),
  margin: doublePrecision("margin"),
  marginAdded: doublePrecision("margin_added").notNull().default(0),
  lastCommandSeq: integer("last_command_seq").notNull().default(0),
  pendingCloseReason: text("pending_close_reason"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  exitPrice: doublePrecision("exit_price"),
  pnl: doublePrecision("pnl"),
  pnlPct: doublePrecision("pnl_pct"),
  closeReason: text("close_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  mgmt: text("mgmt"),
  maxHoldH: doublePrecision("max_hold_h"),
  peakPct: doublePrecision("peak_pct").notNull().default(0),
  beMoved: boolean("be_moved").notNull().default(false),
  partialDone: boolean("partial_done").notNull().default(false),
  leverage: integer("leverage"),
  stopKind: text("stop_kind").notNull().default("initial"),
}, (t) => [
  unique("ex_trades_account_signal_unique").on(t.accountId, t.sourceSignalId),
  index("ex_trades_status").on(t.accountId, t.status),
]);

export const exEventsTable = pgTable("ex_events", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tradeId: integer("trade_id"),
  sourceSignalId: text("source_signal_id"),
  symbol: text("symbol"),
  kind: text("kind").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ex_events_trade").on(t.tradeId)]);

/** Trading settings per signal source (owner 2026-11-03): Nihilist on/off, size, strategy, subscribers. */
export const exSourceSettingsTable = pgTable("ex_source_settings", {
  source: text("source").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  allocationMode: text("allocation_mode").notNull().default("percent"),
  allocationValue: doublePrecision("allocation_value").notNull().default(1),
  strategy: text("strategy").notNull().default("source"),
  subscribers: boolean("subscribers").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Bitcoin per user and source (owner 2026-11-03): on/off, leverage (50x default), own size. */
export const exBtcSettingsTable = pgTable("ex_btc_settings", {
  accountKey: text("account_key").notNull(),
  source: text("source").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  leverage: integer("leverage").notNull().default(50),
  allocationMode: text("allocation_mode"),
  allocationValue: doublePrecision("allocation_value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ name: "ex_btc_settings_pk", columns: [t.accountKey, t.source] })]);

/** Telegram outbox (owner 2026-11-03): stored first, sent in order, never dropped. */
export const exTgOutboxTable = pgTable("ex_tg_outbox", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
});

/** The trading bot's Telegram reader state (update offset), owner 2026-11-03. */
/** Owner 2026-11-04: the main account — PAPER / VST / REAL and its BingX key (encrypted), set in «Мой кабинет». */
export const exOwnerAccountTable = pgTable("ex_owner_account", {
  id: integer("id").primaryKey(),
  mode: text("mode").notNull().default("vst"),
  apiKeyEncrypted: text("api_key_encrypted"),
  apiSecretEncrypted: text("api_secret_encrypted"),
  keyLast4: text("key_last4"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Owner 2026-11-04: the PAPER account's simulated exchange. */
export const exPaperStateTable = pgTable("ex_paper_state", {
  id: integer("id").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const botTelegramStateTable = pgTable("bot_telegram_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
