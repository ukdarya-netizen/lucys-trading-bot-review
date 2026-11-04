// Uses a LOCAL test database only (creates and empties the subscribers table).
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.log("subscriber-bot.test: skipped (needs a local test database)");
  process.exit(0);
}
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "@workspace/db";
// @ts-expect-error JavaScript module of the bot.
import { ensureSubscribersTable } from "../bullet-bot/subscriber-trading.mjs";
import { decide, expiryPass, handleUpdate } from "./subscriber-bot";

const calls: Array<{ method: string; body: any }> = [];
const realFetch = globalThis.fetch;
before(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_CHAT_ID = "999";
  globalThis.fetch = (async (url: string, init: any) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const blocked = method === "sendMessage" && body.chat_id === "555";
    return new Response(JSON.stringify(blocked ? { ok: false, error_code: 403 } : { ok: true, result: method === "getMe" ? { username: "test_bot" } : {} }), { status: 200 });
  }) as any;
  await ensureSubscribersTable(pool);
  await pool.query("CREATE TABLE IF NOT EXISTS bot_telegram_state (key text PRIMARY KEY, value text NOT NULL)");
});
after(async () => { globalThis.fetch = realFetch; await pool.end(); });
beforeEach(async () => { await pool.query("TRUNCATE subscribers RESTART IDENTITY"); calls.length = 0; });

const add = async (chat: string | null = "111", status = "pending") =>
  (await pool.query("INSERT INTO subscribers (clerk_user_id, email, name, status, telegram_chat_id) VALUES ($1,'a@b.c','Брат',$2,$3) RETURNING *", [`u${Math.random()}`, status, chat])).rows[0];
const sentTo = (chat: string) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === chat).map((c) => c.body.text as string);
const tick = () => new Promise((r) => setTimeout(r, 30));

test("approve: a month, «активирована» to the subscriber; approve again: +1 month from the end, «продлена»; reject/block told", async () => {
  const s = await add();
  const a = await decide(s.id, "approve", "owner");
  await tick();
  const until = new Date(a!.row.subscribed_until);
  assert.ok(Math.abs(until.getTime() - Date.now() - 30 * 86_400_000) < 2.1 * 86_400_000);
  assert.match(sentTo("111")[0]!, /подписка на торгового бота активирована/);
  const b = await decide(s.id, "approve", "owner");
  await tick();
  assert.ok(new Date(b!.row.subscribed_until).getTime() - until.getTime() > 27 * 86_400_000, "added to the end");
  assert.match(sentTo("111")[1]!, /продлена/);
  assert.equal(b!.text, "🔄 Подписка продлена");
  await decide(s.id, "block", "owner");
  await tick();
  assert.match(sentTo("111")[2]!, /приостановлен/);
  const s2 = await add("222");
  await decide(s2.id, "reject", "owner");
  await tick();
  assert.match(sentTo("222")[0]!, /отклонена/);
  for (const t of calls.map((c) => String(c.body.text ?? ""))) assert.doesNotMatch(t, /<[a-z]+>/, "no HTML");
});

test("owner presses the button in Telegram → decided, message edited; a stranger cannot", async () => {
  const s = await add();
  await handleUpdate({ update_id: 1, callback_query: { id: "q1", data: `sub_approve:${s.id}`, from: { id: 777 }, message: { message_id: 5, chat: { id: 777 } } } });
  assert.equal((await pool.query("SELECT status FROM subscribers WHERE id = $1", [s.id])).rows[0].status, "pending");
  assert.match(calls.find((c) => c.method === "answerCallbackQuery")!.body.text, /Только владелец/);
  await handleUpdate({ update_id: 2, callback_query: { id: "q2", data: `sub_approve:${s.id}`, from: { id: 999 }, message: { message_id: 6, chat: { id: 999 } } } });
  await tick();
  assert.equal((await pool.query("SELECT status FROM subscribers WHERE id = $1", [s.id])).rows[0].status, "approved");
  const edit = calls.find((c) => c.method === "editMessageText")!;
  assert.match(edit.body.text, /Одобрено[\s\S]*Подписка до/);
  assert.match(sentTo("111")[0]!, /активирована/);
});

test("/start answers with the Chat ID; /status with the subscription", async () => {
  await handleUpdate({ update_id: 3, message: { chat: { id: 444, type: "private" }, from: { id: 444 }, text: "/start" } });
  assert.match(sentTo("444")[0]!, /Ваш Chat ID: 444/);
  const s = await add("444", "approved");
  await pool.query("UPDATE subscribers SET subscribed_until = now() + interval '10 days' WHERE id = $1", [s.id]);
  await handleUpdate({ update_id: 4, message: { chat: { id: 444, type: "private" }, from: { id: 444, username: "brat" }, text: "/status" } });
  assert.match(sentTo("444")[1]!, /Активна до/);
  assert.equal((await pool.query("SELECT telegram_username FROM subscribers WHERE id = $1", [s.id])).rows[0].telegram_username, "brat");
});

test("end of subscription: 3 days, 1 day, ended → trading stops, owner gets «Продлить на месяц»; each once", async () => {
  const s = await add("111", "approved");
  await pool.query("UPDATE subscribers SET trading_enabled = true, subscribed_until = now() + interval '60 hours' WHERE id = $1", [s.id]);
  await expiryPass(); await expiryPass();
  assert.equal(sentTo("111").length, 1); assert.match(sentTo("111")[0]!, /через 3 дня/);
  await pool.query("UPDATE subscribers SET subscribed_until = now() + interval '20 hours' WHERE id = $1", [s.id]);
  await expiryPass(); await expiryPass();
  assert.equal(sentTo("111").length, 2); assert.match(sentTo("111")[1]!, /завтра/);
  await pool.query("UPDATE subscribers SET subscribed_until = now() - interval '1 minute' WHERE id = $1", [s.id]);
  await expiryPass(); await expiryPass();
  assert.equal(sentTo("111").length, 3); assert.match(sentTo("111")[2]!, /закончилась — торговля остановлена/);
  assert.equal((await pool.query("SELECT trading_enabled FROM subscribers WHERE id = $1", [s.id])).rows[0].trading_enabled, false);
  const owner = calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === "999");
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.body.reply_markup.inline_keyboard[0][0].text, "🔄 Продлить на месяц");
  // Renewal after the end: a month from now, reminders start over.
  const r = await decide(s.id, "approve", "owner");
  assert.ok(new Date(r!.row.subscribed_until).getTime() > Date.now() + 27 * 86_400_000);
  assert.equal(r!.row.expiry_notice, null);
});
