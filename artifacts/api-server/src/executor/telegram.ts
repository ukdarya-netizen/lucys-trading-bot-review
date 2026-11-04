/**
 * Owner Telegram for every executor event (plain text, no HTML).
 *
 * Outbox (owner 2026-11-03: messages of two signals that came together did not arrive):
 * every message is stored first (ex_tg_outbox), then one pump sends them in order,
 * at most one per TELEGRAM_GAP_MS, waiting Telegram's retry_after on 429 and retrying
 * network errors — a message is never dropped silently. A message Telegram refuses for
 * good (bad chat, too long) is kept with Telegram's answer, visible on «Обзор».
 */
import { pool } from "@workspace/db";
import { ensureExecutorTables } from "./store";

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT = () => process.env.TELEGRAM_CHAT_ID?.trim();

export type Sender = (text: string) => Promise<void>;

/** Telegram: about one message a second to one chat (20 a minute to a group). */
export const TELEGRAM_GAP_MS = 1_100;
/** A refusal that is not a rate limit or a network error is retried this many times. */
const MAX_REFUSALS = 5;
const MAX_LEN = 4096;

type Post = (token: string, chat: string, text: string) => Promise<{ ok: true } | { ok: false; status: number; retryAfterS: number | null; description: string }>;

const telegramPost: Post = async (token, chat, text) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
  return { ok: false, status: res.status, retryAfterS: body.parameters?.retry_after ?? null, description: String(body.description ?? `HTTP ${res.status}`).slice(0, 300) };
};

let pumping = false;
let again = false;
let timer: NodeJS.Timeout | null = null;

/** Sends what is due, oldest first; schedules itself for the next due message. */
export async function pumpTelegram(post: Post = telegramPost, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  if (pumping) { again = true; return; }
  pumping = true;
  try {
    do {
      again = false;
      const token = TOKEN();
      if (!token) return;
      for (;;) {
        const r = await pool.query<{ id: number; chat_id: string; text: string; attempts: number }>(
          `SELECT id, chat_id, text, attempts FROM ex_tg_outbox
           WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= now() ORDER BY id LIMIT 1`);
        const m = r.rows[0];
        if (!m) break;
        let out: Awaited<ReturnType<Post>>;
        try { out = await post(token, m.chat_id, m.text); } catch (e) {
          out = { ok: false, status: 0, retryAfterS: null, description: `сеть: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
        }
        if (out.ok) {
          await pool.query("UPDATE ex_tg_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1", [m.id]);
        } else if (out.status === 429 || out.status === 0 || out.status >= 500) {
          // Rate limit or a passing failure: wait and keep the order (later messages wait too).
          const waitMs = out.retryAfterS !== null ? (out.retryAfterS + 1) * 1000 : Math.min(60_000, 2_000 * 2 ** Math.min(m.attempts, 5));
          await pool.query("UPDATE ex_tg_outbox SET attempts = attempts + 1, last_error = $2, next_at = now() + make_interval(secs => $3) WHERE id = $1",
            [m.id, out.description, waitMs / 1000]);
          break;
        } else {
          const final = m.attempts + 1 >= MAX_REFUSALS;
          await pool.query(
            `UPDATE ex_tg_outbox SET attempts = attempts + 1, last_error = $2,
               next_at = now() + interval '30 seconds', failed_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1`,
            [m.id, out.description, final]);
        }
        await sleep(TELEGRAM_GAP_MS);
      }
    } while (again);
  } finally {
    pumping = false;
    // Wake up for the next message that waits (rate limit, backoff).
    const next = await pool.query<{ ms: number }>(
      "SELECT GREATEST(0, EXTRACT(EPOCH FROM (min(next_at) - now())) * 1000)::float8 AS ms FROM ex_tg_outbox WHERE sent_at IS NULL AND failed_at IS NULL",
    ).catch(() => ({ rows: [] as Array<{ ms: number }> }));
    const ms = next.rows[0]?.ms;
    if (timer) clearTimeout(timer);
    timer = ms === null || ms === undefined ? null : setTimeout(() => void pumpTelegram().catch(() => undefined), Math.max(200, ms));
    timer?.unref?.();
  }
}

/** Tests: no wake-up timer left behind. */
export function stopTelegramPump(): void { if (timer) clearTimeout(timer); timer = null; }

/** Queues the message (never lost) and starts the pump. */
export const telegramSender: Sender = async (text) => {
  const chat = CHAT();
  if (!TOKEN() || !chat) return;
  await ensureExecutorTables();
  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
  await pool.query("INSERT INTO ex_tg_outbox (chat_id, text) VALUES ($1, $2)", [chat, body]);
  void pumpTelegram().catch(() => undefined);
};

/** For «Обзор»: what waits, how long, and Telegram's last refusal. */
export async function telegramOutboxStatus(): Promise<{ pending: number; oldestPendingAt: string | null; failed24h: number; lastError: string | null; lastErrorAt: string | null; lastSentAt: string | null }> {
  await ensureExecutorTables();
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL)::int AS pending,
            min(created_at) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL) AS oldest,
            count(*) FILTER (WHERE failed_at > now() - interval '24 hours')::int AS failed24h,
            max(sent_at) AS last_sent
     FROM ex_tg_outbox WHERE created_at > now() - interval '7 days'`);
  const e = await pool.query("SELECT last_error, created_at FROM ex_tg_outbox WHERE last_error IS NOT NULL AND created_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 1");
  const row = r.rows[0] ?? {};
  return {
    pending: row.pending ?? 0, oldestPendingAt: row.oldest ? new Date(row.oldest).toISOString() : null, failed24h: row.failed24h ?? 0,
    lastSentAt: row.last_sent ? new Date(row.last_sent).toISOString() : null,
    lastError: e.rows[0]?.last_error ?? null, lastErrorAt: e.rows[0]?.created_at ? new Date(e.rows[0].created_at).toISOString() : null,
  };
}

export const fmt = (v: number | null | undefined, d = 6) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(d)));
export const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
