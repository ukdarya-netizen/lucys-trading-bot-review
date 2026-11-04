import { Router, type IRouter } from "express";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { cabOrigin, executorHealth, executorStatus, executorTradeEvents, saveNihilistSettings, saveSourceSettingsFrom } from "../executor";
import { saveBtcSettings } from "../executor/store";
import { listSignals, ownerAccountInfo, saveOwnerAccount } from "../executor/owner-account";

/** Owner: the new executor's accounts, trades and events (owner 2026-11-02). */
const router: IRouter = Router();
router.get("/journal/executor", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executorStatus());
});
router.get("/journal/executor/health", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executorHealth());
});
router.get("/journal/executor/trades/:id", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
  const out = await executorTradeEvents(id);
  if (!out) { res.status(404).json({ error: "not_found" }); return; }
  res.json(out);
});
router.post("/journal/executor/nihilist-settings", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await saveNihilistSettings(req.body);
  if (!out.ok) { res.status(400).json({ error: { code: out.code, message: "Неверные настройки" } }); return; }
  res.json(out.settings);
});
router.post("/journal/executor/source-settings/:source", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const source = req.params.source;
  if (source !== "cab" && source !== "nihilist") { res.status(404).json({ error: { code: "unknown_source", message: "Нет такого источника" } }); return; }
  const out = await saveSourceSettingsFrom(source, req.body);
  if (!out.ok) { res.status(400).json({ error: { code: out.code, message: "Неверные настройки" } }); return; }
  res.json(out.settings);
});
// The owner's main account: PAPER / VST / REAL and its BingX key (owner 2026-11-04).
router.get("/journal/executor/owner-account", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await ownerAccountInfo());
});
router.post("/journal/executor/owner-account", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await saveOwnerAccount(req.body);
  if (!out.ok) { res.status(out.status).json({ error: { code: "owner_account", message: out.message } }); return; }
  res.json({ ...out.info, equity: out.equity });
});
// Every received signal and what each account did with it (owner 2026-11-04).
router.get("/journal/executor/signals", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ signals: await listSignals(Number(req.query.days ?? 3)) });
});
router.post("/journal/executor/btc-settings", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await saveBtcSettings("owner", req.body);
  if (!out.ok) { res.status(400).json({ error: { code: out.code, message: "Неверные настройки биткоина" } }); return; }
  res.json({ settings: out.settings });
});
// Nihilist's strategy report, read from Nihilist with the trading token (owner 2026-11-03).
function nihilistBase(): string | null {
  const explicit = process.env.NIHILIST_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const sync = process.env.NIHILIST_POSITION_SYNC_URL?.trim();
  try { return sync ? new URL(sync).origin : null; } catch { return null; }
}
async function nihilistCall(path: string, method: "GET" | "POST") {
  const base = nihilistBase(), token = process.env.NIHILIST_TRADING_TOKEN?.trim();
  if (!base || !token) return { status: 503, body: { error: { code: "nihilist_not_configured", message: "Не заданы NIHILIST_POSITION_SYNC_URL и NIHILIST_TRADING_TOKEN" } } };
  try {
    const r = await fetch(`${base}${path}`, { method, headers: { "x-trading-token": token, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const body = (await r.json().catch(() => ({}))) as any;
    return { status: r.status, body: r.ok ? body : { error: { code: String(body?.error ?? r.status), message: r.status === 409 ? "Расчёт уже идёт" : r.status === 401 ? "Нигилист не принял токен" : "Нигилист не ответил" } } };
  } catch {
    return { status: 502, body: { error: { code: "nihilist_unreachable", message: "Нигилист недоступен" } } };
  }
}
router.get("/journal/executor/nihilist-report", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await nihilistCall("/api/trading/strategy-report", "GET");
  res.status(out.status).json(out.body);
});
router.post("/journal/executor/nihilist-report/run", requireJournalSession, requireJournalOwner, async (_req, res) => {
  const out = await nihilistCall("/api/trading/strategy-report/run", "POST");
  res.status(out.status).json(out.body);
});
// CAB's strategy report (owner 2026-11-03): each way to lead a CAB trade on CAB's real closed signals.
router.get("/journal/executor/cab-report", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.TRADING_INGEST_TOKEN?.trim();
  if (!token) { res.status(503).json({ error: { code: "cab_not_configured", message: "Не задан TRADING_INGEST_TOKEN" } }); return; }
  const days = Number(req.query.days);
  const url = new URL("/api/trading/strategy-report", cabOrigin());
  if (Number.isInteger(days) && days > 0) url.searchParams.set("days", String(days));
  try {
    const r = await fetch(url, { headers: { "x-trading-token": token, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const body = (await r.json().catch(() => ({}))) as any;
    if (r.ok) { res.json(body); return; }
    res.status(r.status).json({ error: { code: String(body?.error ?? r.status), message: r.status === 401 ? "CAB не принял токен" : r.status === 404 ? "В CAB ещё нет расчёта стратегий — опубликуйте CAB" : "CAB не ответил" } });
  } catch {
    res.status(502).json({ error: { code: "cab_unreachable", message: "CAB недоступен" } });
  }
});
export default router;
