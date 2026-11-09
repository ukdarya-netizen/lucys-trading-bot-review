/**
 * Telegram of the trading bot for subscribers (owner 2026-11-03, as CAB):
 *  - a new request → the owner's chat (TELEGRAM_CHAT_ID) gets it with
 *    buttons «✅ Одобрить» / «❌ Отклонить»; a press decides it right there;
 *  - the subscriber (who pressed /start in this bot and saved the Chat ID in
 *    the cabinet) is told: subscription started / renewed / rejected /
 *    blocked / unblocked / ends in 3 days / ends tomorrow / ended;
 *  - a subscription is one month from the approval (renewal adds a month to
 *    what is left); when it ends trading stops and the owner gets
 *    «Продлить на месяц» / «Заблокировать».
 * Same bot as the trade messages (TELEGRAM_BOT_TOKEN). Plain text only.
 * Updates are read by long polling only in the published deployment.
 */
import { pool } from "@workspace/db";

type Btn = { text: string; callback_data: string };
type Keyboard = Btn[][];
export type SubRow = Record<string, any> & { id: number; status: string };

const API = "https://api.telegram.org";
const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const ownerChat = () => process.env.TELEGRAM_CHAT_ID?.trim() || "";
/** The owner's own row (her cabinet): her access never ends (owner 2026-11-09). */
export const isOwnerRow = (r: Record<string, any> | null | undefined) =>
  Boolean(r?.clerk_user_id) && r!.clerk_user_id === process.env.JOURNAL_OWNER_USER_ID;
const TZ = "Europe/Samara";

export const dateText = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: TZ }) : "без даты окончания";
const who = (r: SubRow) => String(r.name || r.email || `#${r.id}`).slice(0, 60);

// ---------------- texts ----------------
export const TEXT = {
  ownerRequest: (r: SubRow) => [
    "🔐 Новый запрос доступа к торговому боту",
    "",
    `👤 ${who(r)}`,
    r.email ? `📧 ${r.email}` : null,
    r.telegram_chat_id ? `💬 Telegram ID: ${r.telegram_chat_id}${r.telegram_username ? ` (@${r.telegram_username})` : ""}` : "💬 Telegram ещё не привязан",
  ].filter((x) => x !== null).join("\n"),
  ownerDecided: (r: SubRow, what: string) => `${what}\n👤 ${who(r)}${r.email ? `\n📧 ${r.email}` : ""}${r.subscribed_until ? `\n📅 Подписка до ${dateText(r.subscribed_until)}` : ""}`,
  ownerExpired: (r: SubRow) => `⌛ Подписка закончилась, торговля остановлена\n👤 ${who(r)}${r.email ? `\n📧 ${r.email}` : ""}`,
  ownerRenewRequest: (r: SubRow) => `🔔 Подписчик просит продлить доступ\n👤 ${who(r)}${r.email ? `\n📧 ${r.email}` : ""}${r.telegram_username ? `\n💬 @${r.telegram_username}` : ""}\n📅 ${r.subscribed_until && new Date(r.subscribed_until) > new Date() ? `Подписка до ${dateText(r.subscribed_until)}` : "Подписка закончилась"}`,
  renewRequested: "✅ Запрос отправлен Люси. Как только она продлит доступ, бот пришлёт сообщение с новой датой.",

  started: (until: Date | null) => [
    "🎉 Ваша подписка на торгового бота активирована!",
    "",
    "Доступ к кабинету открыт: подключите ключ BingX, выберите стратегию и запустите торговлю на сайте.",
    "",
    `📅 Подписка активна до: ${dateText(until)}`,
  ].join("\n"),
  renewed: (until: Date | null) => `🔄 Ваша подписка продлена!\n\n📅 Действует до: ${dateText(until)}\n\nУдачной торговли! 🚀`,
  rejected: "❌ Заявка на доступ к торговому боту отклонена.\n\nЕсли это ошибка — напишите владельцу.",
  blocked: "🚫 Доступ к торговому боту приостановлен администратором. Торговля остановлена: новые сделки не открываются, открытые позиции остаются на бирже со своими стопами.\n\nПо вопросам обращайтесь напрямую.",
  unblocked: (until: Date | null) => `✅ Доступ к торговому боту снова открыт.\n\n📅 Подписка до: ${dateText(until)}\n\nЧтобы торговля шла, запустите её в кабинете на сайте.`,
  ending: (days: number, until: Date) => days <= 1
    ? `⏳ Подписка на торгового бота заканчивается через сутки — ${dateText(until)}.\n\nВ этот момент бот отключится от вашего API: новые сделки не откроются, сопровождение открытых позиций прекратится (они останутся на бирже со своими стопами).\n\nЧтобы продлить доступ — напишите Люси: кнопка ниже.`
    : `⏳ Подписка на торгового бота заканчивается через ${days} дня — ${dateText(until)}.\n\nЧтобы продлить доступ — напишите Люси: кнопка ниже.`,
  ended: "⌛ Подписка на торгового бота закончилась — бот отключён от вашего API: новые сделки не открываются, сопровождение открытых позиций остановлено (они остаются на бирже со своими стопами).\n\nЧтобы продолжить — напишите Люси: кнопка ниже.",
  linked: (r: SubRow) => `✅ Telegram привязан к кабинету торгового бота.\n\n👤 ${who(r)}\n📅 Подписка: ${r.status === "approved" ? `до ${dateText(r.subscribed_until)}` : r.status === "pending" ? "заявка ждёт одобрения" : "нет доступа"}`,
  start: (chatId: string) => [
    "👋 Это Lucy's Trading Bot.",
    "",
    `Ваш Chat ID: ${chatId}`,
    "",
    "Впишите его в кабинете на сайте (шаг «Telegram») — сюда будут приходить сообщения о подписке.",
  ].join("\n"),
  status: (r: SubRow | null) => r
    ? `📅 Статус подписки\n\n👤 ${who(r)}\n${r.status === "approved" ? `Активна до: ${dateText(r.subscribed_until)}` : r.status === "pending" ? "Заявка ждёт одобрения" : r.status === "rejected" ? "Заявка отклонена" : "Доступ приостановлен"}`
    : "Этот Telegram не привязан к кабинету. Нажмите /start и впишите Chat ID в кабинете на сайте.",
};

// Owner 2026-11-09: approval for a chosen term (1 / 3 months here; any date on the site's calendar).
export const OWNER_REQUEST_KEYBOARD = (id: number): Keyboard => [
  [{ text: "✅ 1 месяц", callback_data: `sub_approve:${id}:1` }, { text: "✅ 3 месяца", callback_data: `sub_approve:${id}:3` }],
  [{ text: "❌ Отклонить", callback_data: `sub_reject:${id}` }],
];
const OWNER_EXPIRED_KEYBOARD = (id: number): Keyboard => [
  [{ text: "🔄 +1 месяц", callback_data: `sub_approve:${id}:1` }, { text: "🔄 +3 месяца", callback_data: `sub_approve:${id}:3` }],
  [{ text: "🚫 Заблокировать", callback_data: `sub_block:${id}` }],
];
const RENEW_KEYBOARD = (id: number): Keyboard => [[{ text: "✍️ Продлить доступ — написать Люси", callback_data: `sub_renew_req:${id}` }]];

// ---------------- transport ----------------
async function tg(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
  if (!token()) return { ok: false, description: "TELEGRAM_BOT_TOKEN not set" };
  try {
    const res = await fetch(`${API}/bot${token()}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => ({ ok: false, error_code: res.status }));
  } catch (e) {
    return { ok: false, description: e instanceof Error ? e.name : "network" };
  }
}
export async function send(chatId: string | number | null | undefined, text: string, keyboard?: Keyboard): Promise<boolean> {
  if (!chatId) return false;
  const r = await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  return Boolean(r?.ok);
}
export const toOwner = (text: string, keyboard?: Keyboard) => send(ownerChat(), text, keyboard);
export const toSubscriber = (r: SubRow, text: string, keyboard?: Keyboard) => send(r.telegram_chat_id, text, keyboard);

let botName: string | null = null;
export async function botUsername(): Promise<string | null> {
  if (botName) return botName;
  const r = await tg("getMe", {});
  botName = r?.ok ? String(r.result.username) : null;
  return botName;
}

// ---------------- decisions (site and Telegram buttons share them) ----------------
export type Decision = "approve" | "reject" | "block" | "unblock";

/**
 * approve: a month from now, or a month added to what is left of an active
 * subscription (renewal); reject / block stop trading; unblock gives the
 * subscription back (a month from now if it had ended). The subscriber is told.
 */
export type Term = { months?: number; until?: Date };
export async function decide(id: number, decision: Decision, by: string, term: Term = {}): Promise<{ row: SubRow; text: string } | null> {
  const cur = (await pool.query("SELECT * FROM subscribers WHERE id = $1", [id])).rows[0] as SubRow | undefined;
  if (!cur) return null;
  const now = new Date();
  const active = cur.status === "approved" && (!cur.subscribed_until || new Date(cur.subscribed_until) > now);
  const base = cur.status === "approved" && cur.subscribed_until && new Date(cur.subscribed_until) > now ? new Date(cur.subscribed_until) : now;
  // Owner 2026-11-09: a chosen date is the end itself; N months are added to what is left (renewal).
  const months = term.months && Number.isInteger(term.months) && term.months > 0 && term.months <= 24 ? term.months : 1;
  const plusMonth = new Date(base); plusMonth.setMonth(plusMonth.getMonth() + months);
  const chosen = term.until && term.until.getTime() > now.getTime() ? term.until : null;
  let row: SubRow;
  if (decision === "approve" || decision === "unblock") {
    // The owner's own access never ends: no date (owner 2026-11-09).
    const until = isOwnerRow(cur) ? null
      : chosen ?? (decision === "unblock" && !term.months && cur.subscribed_until && new Date(cur.subscribed_until) > now ? new Date(cur.subscribed_until) : plusMonth);
    row = (await pool.query(
      `UPDATE subscribers SET status = 'approved', decided_at = now(), decided_by = $2, subscribed_until = $3, expiry_notice = NULL,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [id, by, until])).rows[0];
    const renewal = decision === "approve" && active && cur.subscribed_until;
    if (!isOwnerRow(row)) void toSubscriber(row, decision === "unblock" ? TEXT.unblocked(until) : renewal ? TEXT.renewed(until) : TEXT.started(until));
    return { row, text: decision === "unblock" ? "✅ Доступ снова открыт" : renewal ? "🔄 Подписка продлена" : "✅ Одобрено" };
  }
  const status = decision === "reject" ? "rejected" : "blocked";
  row = (await pool.query(
    `UPDATE subscribers SET status = $3, decided_at = now(), decided_by = $2, trading_enabled = false,
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [id, by, status])).rows[0];
  void toSubscriber(row, decision === "reject" ? TEXT.rejected : TEXT.blocked);
  return { row, text: decision === "reject" ? "❌ Отклонено" : "🚫 Заблокирован" };
}

/** New request: the owner's chat gets it with the buttons. */
export async function announceRequest(r: SubRow): Promise<void> {
  await toOwner(TEXT.ownerRequest(r), OWNER_REQUEST_KEYBOARD(r.id));
}

// ---------------- subscription end ----------------
/** Reminders 3 days and 1 day before; at the end trading stops, subscriber and owner are told. */
export async function expiryPass(now = new Date()): Promise<void> {
  const { rows } = await pool.query(
    `SELECT * FROM subscribers WHERE status = 'approved' AND subscribed_until IS NOT NULL AND subscribed_until < $1::timestamptz + interval '3 days'
       AND clerk_user_id IS DISTINCT FROM $2`, [now, process.env.JOURNAL_OWNER_USER_ID ?? null]);
  for (const r of rows as SubRow[]) {
    const until = new Date(r.subscribed_until);
    const leftH = (until.getTime() - now.getTime()) / 3_600_000;
    const stage = leftH <= 0 ? "ended" : leftH <= 24 ? "1d" : "3d";
    if (r.expiry_notice === stage || (stage === "3d" && r.expiry_notice === "1d")) continue;
    if (stage === "ended") {
      const upd = await pool.query(
        `UPDATE subscribers SET expiry_notice = 'ended', trading_enabled = false, version = version + 1, updated_at = now()
         WHERE id = $1 AND (expiry_notice IS DISTINCT FROM 'ended') RETURNING *`, [r.id]);
      if (!upd.rowCount) continue;
      await toSubscriber(r, TEXT.ended, RENEW_KEYBOARD(r.id));
      await toOwner(TEXT.ownerExpired(r), OWNER_EXPIRED_KEYBOARD(r.id));
    } else {
      const upd = await pool.query("UPDATE subscribers SET expiry_notice = $2 WHERE id = $1 AND (expiry_notice IS DISTINCT FROM $2) RETURNING id", [r.id, stage]);
      if (!upd.rowCount) continue;
      await toSubscriber(r, TEXT.ending(stage === "1d" ? 1 : 3, until), RENEW_KEYBOARD(r.id));
    }
  }
}

// ---------------- updates from Telegram ----------------
async function stateGet(key: string): Promise<string | null> {
  const r = await pool.query("SELECT value FROM bot_telegram_state WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}
async function stateSet(key: string, value: string): Promise<void> {
  await pool.query(`INSERT INTO bot_telegram_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

export async function handleUpdate(u: any): Promise<void> {
  if (u.callback_query) {
    const cq = u.callback_query;
    const data = String(cq.data ?? "");
    const chatId = String(cq.message?.chat?.id ?? "");
    // A subscriber asks to renew (button under the «ends tomorrow» / «ended» message): the owner gets it with the term buttons.
    const rq = /^sub_renew_req:(\d+)$/.exec(data);
    if (rq) {
      const r = (await pool.query("SELECT * FROM subscribers WHERE id = $1", [Number(rq[1])])).rows[0] as SubRow | undefined;
      const mine = r && (String(r.telegram_chat_id ?? "") === chatId || String(r.telegram_chat_id ?? "") === String(cq.from?.id ?? ""));
      if (!r || !mine) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не найдено" }); return; }
      await toOwner(TEXT.ownerRenewRequest(r), r.status === "approved" ? OWNER_EXPIRED_KEYBOARD(r.id) : OWNER_REQUEST_KEYBOARD(r.id));
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Запрос отправлен" });
      await send(chatId, TEXT.renewRequested);
      return;
    }
    const m = /^sub_(approve|reject|block):(\d+)(?::(\d+))?$/.exec(data);
    if (!m) { await tg("answerCallbackQuery", { callback_query_id: cq.id }); return; }
    // Only the owner's chat gets these buttons, and only it may press them.
    if (!ownerChat() || (chatId !== ownerChat() && String(cq.from?.id) !== ownerChat())) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ Только владелец может это сделать" });
      return;
    }
    const out = await decide(Number(m[2]), m[1] as Decision, `telegram:${cq.from?.id ?? "owner"}`, m[3] ? { months: Number(m[3]) } : {});
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: out ? out.text : "Не найден" });
    if (out && cq.message) await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: TEXT.ownerDecided(out.row, out.text) });
    return;
  }
  const msg = u.message;
  if (!msg?.chat || msg.chat.type !== "private") return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text ?? "").trim();
  const linked = (await pool.query("SELECT * FROM subscribers WHERE telegram_chat_id = $1 ORDER BY id LIMIT 1", [chatId])).rows[0] as SubRow | undefined;
  if (msg.from?.username && linked && linked.telegram_username !== msg.from.username) {
    await pool.query("UPDATE subscribers SET telegram_username = $2 WHERE id = $1", [linked.id, msg.from.username]);
  }
  if (/^\/status\b/.test(text)) { await send(chatId, TEXT.status(linked ?? null)); return; }
  if (chatId === ownerChat()) return; // the owner's chat: trade messages only
  await send(chatId, linked ? `${TEXT.start(chatId)}\n\n${TEXT.status(linked)}` : TEXT.start(chatId));
}

let polling = false;
/** Long polling of the trading bot's Telegram (published deployment only), plus the subscription-end pass. */
export function startSubscriberBot(log: (msg: string, extra?: unknown) => void): void {
  if (polling || !token()) return;
  if (process.env.REPLIT_DEPLOYMENT !== "1" && process.env.SUBSCRIBER_BOT_IN_DEV !== "1") return;
  polling = true;
  void (async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS bot_telegram_state (key text PRIMARY KEY, value text NOT NULL)");
    let offset = Number((await stateGet("update_offset")) ?? 0);
    let warned = false;
    for (;;) {
      const r = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 40_000);
      if (!r?.ok) {
        if (r?.error_code === 409 && !warned) {
          warned = true;
          log("subscriber bot: another reader of this bot is active (webhook or second process) — buttons unavailable");
        }
        await new Promise((res) => setTimeout(res, 5_000));
        continue;
      }
      for (const u of r.result ?? []) {
        offset = Number(u.update_id) + 1;
        await stateSet("update_offset", String(offset)); // a press is never applied twice after a restart
        await handleUpdate(u).catch((e) => log("subscriber bot: update failed", e));
      }
    }
  })();
  const tick = () => void expiryPass().catch((e) => log("subscriber bot: expiry pass failed", e));
  tick();
  setInterval(tick, 60_000).unref?.(); // the end is announced within a minute (owner 2026-11-09)
}
