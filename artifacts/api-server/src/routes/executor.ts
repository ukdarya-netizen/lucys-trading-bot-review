import { Router, type IRouter } from "express";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { cabOrigin, executorHealth, executorStatus, executorTradeEvents, saveNihilistSettings, saveSourceSettingsFrom } from "../executor";
import { saveBtcSettings } from "../executor/store";
import { listSignals, ownerAccountInfo, saveOwnerAccount } from "../executor/owner-account";
import {
  GetExecutorTradingControlsResponse,
  UpdateExecutorTradingControlBody,
  UpdateExecutorTradingControlResponse,
} from "@workspace/api-zod";
import { CONTROL_TARGETS, getTradingControl, productionTrading, saveTradingControl } from "../executor/trading-controls";

/** Owner: the new executor's accounts, trades and events (owner 2026-11-02). */
const router: IRouter = Router();
async function executorTradingControlStates() {
  const [rawStatus, owner] = await Promise.all([executorStatus(), ownerAccountInfo()]);
  const status = rawStatus as { enabled?: boolean; accounts?: Array<{ id: string; env: string }> };
  return Promise.all(CONTROL_TARGETS.map(async (target) => {
    const setting = await getTradingControl(target);
    const activeAccounts = (status.accounts ?? []).filter((account) =>
      account.env === "vst" && (target === "owner" ? account.id.startsWith("owner-") : account.id.startsWith("sub-"))
    ).length;
    const canManage = productionTrading();
    const ownerConfigured = owner.mode === "vst"
      && (Boolean(owner.keyLast4) || (owner.secretsKey && !owner.secretsOff) || activeAccounts > 0);
    const blockedReason = !canManage
      ? "В dev торговля заблокирована. Управление доступно на опубликованном сайте."
      : status.enabled !== true
        ? "Торговый сервис отключён конфигурацией сервера."
        : target === "owner" && !ownerConfigured
          ? "Для переключателя VST выберите демо-счёт и настройте ключ BingX."
          : target === "subscribers" && (process.env.SUBSCRIBER_KEYS_SECRET?.length ?? 0) < 32
            ? "Не настроен ключ шифрования счетов подписчиков."
            : target === "subscribers" && process.env.EXECUTOR_SUBSCRIBERS !== "1"
              ? "Счета подписчиков отключены конфигурацией сервера."
              : null;
    return {
      target,
      env: "vst" as const,
      enabled: setting.enabled,
      effective: setting.enabled && blockedReason === null && activeAccounts > 0,
      canManage,
      canEnable: blockedReason === null,
      blockedReason,
      activeAccounts,
      startedAt: setting.startedAt ? new Date(setting.startedAt).toISOString() : null,
    };
  }));
}

router.get("/journal/executor/trading-controls", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(GetExecutorTradingControlsResponse.parse(await executorTradingControlStates()));
  } catch {
    res.status(503).json({ error: { code: "control_unavailable", message: "Не удалось получить состояние торговли." } });
  }
});
router.post("/journal/executor/trading-controls", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const input = UpdateExecutorTradingControlBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: { code: "invalid_control", message: "Неверный переключатель торговли." } });
    return;
  }
  try {
    if (!productionTrading()) {
      res.status(409).json({ error: { code: "trading_blocked", message: "Торговлю нельзя переключать из dev. Откройте опубликованный сайт." } });
      return;
    }
    if (input.data.enabled) {
      const state = (await executorTradingControlStates()).find((control) => control.target === input.data.target);
      if (!state?.canEnable) {
        res.status(409).json({ error: { code: "trading_blocked", message: state?.blockedReason ?? "Торговля сейчас недоступна." } });
        return;
      }
    }
    await saveTradingControl(input.data.target, input.data.enabled);
    res.json(UpdateExecutorTradingControlResponse.parse(await executorTradingControlStates()));
  } catch {
    res.status(503).json({ error: { code: "control_unconfirmed", message: "Не удалось подтвердить состояние торговли. Обновите данные перед повторным переключением." } });
  }
});

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
