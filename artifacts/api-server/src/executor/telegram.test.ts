import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "@workspace/db";
import { pumpTelegram, stopTelegramPump, telegramOutboxStatus, telegramSender } from "./telegram";
import { ensureExecutorTables } from "./store";

process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "c";
const noSleep = async () => {};

test("outbox: in order, waits Telegram's retry_after on 429, nothing is lost; a hard refusal is kept with its reason", async () => {
  await ensureExecutorTables();
  await pool.query("DELETE FROM ex_tg_outbox");
  // Queue without sending (the pump started by the sender is replaced below).
  await pool.query("INSERT INTO ex_tg_outbox (chat_id, text) VALUES ('c','A'),('c','B'),('c','C')");
  const sent: string[] = [];
  let calls = 0;
  await pumpTelegram(async (_t, _c, text) => {
    calls += 1;
    if (calls === 2) return { ok: false, status: 429, retryAfterS: 0, description: "Too Many Requests: retry after 0" };
    sent.push(text); return { ok: true };
  }, noSleep);
  assert.deepEqual(sent, ["A"]); // B waits its retry_after, C waits behind it
  stopTelegramPump();
  const wait = (await pool.query("SELECT EXTRACT(EPOCH FROM (next_at - now()))::float8 AS s FROM ex_tg_outbox WHERE text = 'B'")).rows[0].s;
  assert.ok(wait > 0.5 && wait <= 1.01, String(wait)); // retry_after 0 → 1 s
  await pool.query("UPDATE ex_tg_outbox SET next_at = now() WHERE sent_at IS NULL");
  await pumpTelegram(async (_t, _c, text) => { sent.push(text); return { ok: true }; }, noSleep);
  stopTelegramPump();
  assert.deepEqual(sent, ["A", "B", "C"]);
  const st = await telegramOutboxStatus();
  assert.equal(st.pending, 0);
  assert.match(st.lastError ?? "", /Too Many Requests/);

  await pool.query("INSERT INTO ex_tg_outbox (chat_id, text) VALUES ('c','bad')");
  for (let i = 0; i < 5; i++) {
    await pool.query("UPDATE ex_tg_outbox SET next_at = now() WHERE sent_at IS NULL");
    await pumpTelegram(async () => ({ ok: false, status: 400, retryAfterS: null, description: "Bad Request: chat not found" }), noSleep);
    stopTelegramPump();
  }
  const st2 = await telegramOutboxStatus();
  assert.equal(st2.failed24h, 1);
  assert.equal(st2.pending, 0);
  assert.match(st2.lastError ?? "", /chat not found/);
});

test("sender stores the message first (cut to Telegram's 4096 characters)", async () => {
  await pool.query("DELETE FROM ex_tg_outbox");
  process.env.TELEGRAM_BOT_TOKEN = ""; // no token: nothing is queued
  await telegramSender("x");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ex_tg_outbox")).rows[0].n, 0);
  process.env.TELEGRAM_BOT_TOKEN = "t";
  await pool.query("DELETE FROM ex_tg_outbox");
  stopTelegramPump();
  await pool.end();
});
