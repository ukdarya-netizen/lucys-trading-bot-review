import { Router, type IRouter } from "express";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { cabOrigin, executorHealth, executorStatus, executorTradeEvents, saveNihilistSettings, saveSourceSettingsFrom } from "../executor";
import { btcMmReport, describeBtcMm, getBtcMm, saveBtcMm } from "../executor/btcmm";
import { isBot } from "../executor/accounts";
import { listSignals, ownerAccountInfo, saveOwnerAccount, setOwnerBotTrading } from "../executor/owner-account";
import {
  GetExecutorTradingControlsResponse,
  UpdateExecutorTradingControlBody,
  UpdateExecutorTradingControlResponse,
} from "@workspace/api-zod";
import { CONTROL_TARGETS, getTradingControl, productionTrading, saveTradingControl } from "../executor/trading-controls";
import { describeNihilistSettings, getNihilistSettings, saveNihilistSideSettings, validNihilistSettings } from "../executor/nihilist-settings";
import { telegramSender } from "../executor/telegram";

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
router.get("/journal/executor/nihilist-sides", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ settings: await getNihilistSettings("owner") });
});
router.post("/journal/executor/nihilist-sides", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!validNihilistSettings(req.body)) {
    res.status(422).json({ error: { code: "invalid_nihilist_settings", message: "Выберите стороны и стратегии Нигилиста" } });
    return;
  }
  const previous = await getNihilistSettings("owner");
  const settings = await saveNihilistSideSettings("owner", req.body);
  if (previous.sides !== settings.sides || previous.longStrategy !== settings.longStrategy || previous.shortStrategy !== settings.shortStrategy) {
    await telegramSender(`Кабинет владельца · Nihilyst Crypto Trading\n${describeNihilistSettings(settings)}`)
      .catch(() => req.log.warn("Nihilist cabinet notice failed"));
  }
  res.json({ settings });
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
  if (!isBot(source)) { res.status(404).json({ error: { code: "unknown_source", message: "Нет такого источника" } }); return; }
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
// Owner 2026-11-06: new trades of one bot on/off, on its own account (the other bot is not touched).
router.post("/journal/executor/owner-bot/:source/trading", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await setOwnerBotTrading(req.params.source, req.body?.enabled);
  if (!out.ok) { res.status(out.status).json({ error: { code: "owner_bot_trading", message: out.message } }); return; }
  res.json(out.info);
});
// Every received signal and what each account did with it (owner 2026-11-04).
router.get("/journal/executor/signals", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ signals: await listSignals(Number(req.query.days ?? 3)) });
});
// Bitcoin MM (owner 2026-11-14): the owner's settings — size, leverage, margin reserve, template per pattern family.
router.post("/journal/executor/btcmm-settings", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const previous = await getBtcMm("owner");
  const out = await saveBtcMm("owner", req.body);
  if (!out.ok) { res.status(400).json({ error: { code: out.code, message: "Проверьте значения: плечо 1–125, процент 0,1–100, сумма и запас больше 0" } }); return; }
  if (JSON.stringify(previous) !== JSON.stringify(out.settings)) {
    await telegramSender(`Кабинет владельца · Bitcoin Margin Master\n${describeBtcMm(out.settings)}`).catch(() => req.log.warn("Bitcoin MM cabinet notice failed"));
  }
  res.json({ settings: out.settings });
});
// Bitcoin MM's virtual panel (owner 2026-11-14): the ladders on its signals, read from Bitcoin MM with its token.
router.get("/journal/executor/btcmm-report", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await btcMmReport();
  res.status(out.status).json(out.body);
});
// Nihilist's strategy report, read from Nihilist with the trading token (owner 2026-11-03).
function nihilistBase(): string | null {
  const explicit = process.env.NIHILIST_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const sync = process.env.NIHILIST_POSITION_SYNC_URL?.trim();
  try { return sync ? new URL(sync).origin : null; } catch { return null; }
}
export async function nihilistCall(path: string, method: "GET" | "POST") {
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
// Shared with the subscriber pages (owner 2026-11-06): the report holds CAB's signals only, nothing of any account.
export async function cabReport(daysRaw: unknown): Promise<{ status: number; body: any }> {
  const token = process.env.TRADING_INGEST_TOKEN?.trim();
  if (!token) return { status: 503, body: { error: { code: "cab_not_configured", message: "Не задан TRADING_INGEST_TOKEN" } } };
  const days = Number(daysRaw);
  const url = new URL("/api/trading/strategy-report", cabOrigin());
  if (Number.isInteger(days) && days > 0) url.searchParams.set("days", String(days));
  try {
    const r = await fetch(url, { headers: { "x-trading-token": token, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const body = (await r.json().catch(() => ({}))) as any;
    if (r.ok) return { status: 200, body };
    return { status: r.status, body: { error: { code: String(body?.error ?? r.status), message: r.status === 401 ? "CAB не принял токен" : r.status === 404 ? "В CAB ещё нет расчёта стратегий — опубликуйте CAB" : "CAB не ответил" } } };
  } catch {
    return { status: 502, body: { error: { code: "cab_unreachable", message: "CAB недоступен" } } };
  }
}
router.get("/journal/executor/cab-report", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const out = await cabReport(req.query.days);
  res.status(out.status).json(out.body);
});
export default router;
