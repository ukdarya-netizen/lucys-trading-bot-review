/**
 * Telegram texts of the executor (owner 2026-11-03: messages must say what
 * really happened). Plain text, no HTML. Pure functions, covered by tests.
 *
 * The close of a position is named from two facts, never from the order type
 * alone: why the stop stood where it stood (stop_kind, set every time the
 * stop moves) and the real result of the fills. A stop that was trailed into
 * profit is never called a stop-loss.
 */
import type { Side } from "./plan";

/** Why the exchange stop stands where it stands. */
export type StopKind = "initial" | "breakeven" | "trailing" | "source";

/** Within ±this % of the entry a result or a stop counts as break-even (fees, ticks). */
export const FLAT_PCT = 0.3;

const dirOf = (s: Side) => (s === "long" ? 1 : -1);
const movePct = (side: Side, entry: number, price: number) => ((price - entry) / entry) * 100 * dirOf(side);

/**
 * The stop's kind after a move: from who moved it and why (source reasons of
 * CAB and Nihilist, the bot's own "breakeven" / "trailing", the sync) and
 * where it now is relative to the entry.
 */
export function stopKindFor(why: string, side: Side, entry: number | null, stop: number): StopKind {
  const w = why.toLowerCase();
  const at = entry ? movePct(side, entry, stop) : null;
  if (w.includes("trail")) return at !== null && Math.abs(at) < FLAT_PCT ? "breakeven" : "trailing";
  if (w.includes("breakeven") || w.includes("b.u") || w === "bu") return "breakeven";
  if (w === "initial_stop_update") return "initial";
  if (at === null) return "source";
  if (Math.abs(at) < FLAT_PCT) return "breakeven";
  return at > 0 ? "source" : "initial";
}

/** Close key from a stop fill (or a market close because the stop was already passed). */
export function stopCloseKey(kind: StopKind, resultPct: number | null): string {
  const r = resultPct ?? 0;
  if (r <= -FLAT_PCT) {
    if (kind === "initial") return "stop_loss";
    if (kind === "trailing") return "stop_trailing_loss";
    return "stop_breakeven_slip";
  }
  if (r < FLAT_PCT) return "stop_breakeven";
  if (kind === "trailing") return "stop_trailing_profit";
  if (kind === "breakeven") return "stop_breakeven_plus";
  if (kind === "source") return "stop_source_profit";
  return "stop_profit";
}

const SOURCE_NAME: Record<string, string> = { cab: "CAB", nihilist: "Нигилист" };

/** What the source said when it closed (CAB / Nihilist close reasons). */
const SOURCE_CLOSE_REASON: Record<string, string> = {
  stop_loss: "по своему стоп-лоссу",
  expired: "по сроку сделки",
  breakeven_stop: "по стопу в безубытке",
  breakeven_close: "в безубыток",
  trailing_stop: "по трейлинг-стопу",
  profit: "с фиксацией прибыли",
  core_exit: "основную часть (выход ядра)",
  cancelled: "— сигнал отменён",
  reclassified: "— сигнал переклассифицирован",
  cancel: "— сигнал отменён",
  close: "",
};

/** Close reasons of a real source exit (everything else a source sent was a cancellation). */
const SOURCE_EXIT_KEYS = new Set(["stop_loss", "expired", "breakeven_stop", "breakeven_close", "trailing_stop", "profit", "core_exit", "close", ""]);

/**
 * Owner 2026-11-09: a cancellation of the signal by its source is a reason of its own — cancel:<reason>
 * (cancel_sync:<status> when it was found by the position sync). Trades closed before this by a cancel
 * command carry source:<reason> with a reason that is not an exit: they are recognised too.
 */
export const cancelKey = (reason: string | null | undefined, sync = false) =>
  `${sync ? "cancel_sync" : "cancel"}:${String(reason || "cancelled").slice(0, 80)}`;
export function isCancelReason(key: string | null | undefined): boolean {
  if (!key) return false;
  if (key.startsWith("cancel:") || key.startsWith("cancel_sync:")) return true;
  if (!key.startsWith("source:")) return false;
  const r = key.slice("source:".length);
  return !SOURCE_EXIT_KEYS.has(r) && !r.startsWith("stop_loss:");
}

/**
 * Owner 2026-11-10 (HANA): CAB books a cancellation (smart cancel / max-age / stale) at ≥5% loss as a stop
 * loss. It is still a real loss, but the text must say what happened: source:stop_loss:<rule>.
 */
export const sourceCloseKey = (cmd: { reason: string; closedBy?: string | null }) =>
  cmd.reason === "stop_loss" && cmd.closedBy ? `source:stop_loss:${cmd.closedBy}` : `source:${cmd.reason || "close"}`;

/** CAB rules that cancel a signal; at ≥5% loss CAB books the cancellation as a stop loss. */
const EARLY_CLOSE: Record<string, string> = {
  smart_cancel: "smart cancel — разворот по спот CVD",
  max_age: "max-age — цена не выросла за отведённое время",
  stale_cancel: "stale cancel — сигнал не отработал",
};
const cancelWhy = (r: string) => (/reclass|neutral/i.test(r) ? "переклассифицировал сигнал" : r === "removed" ? "удалил сигнал" : "отменил сигнал");

/** One line: how the position was closed. Keys: close_reason of ex_trades. */
export function closeLine(key: string, ctx: { source: string; takePct?: number | null } = { source: "" }): string {
  const src = SOURCE_NAME[ctx.source] ?? "Источник";
  if (isCancelReason(key)) {
    const sync = key.startsWith("cancel_sync:");
    const r = key.slice(key.indexOf(":") + 1);
    return `Отмена: ${src} ${sync ? "уже " : ""}${cancelWhy(r)}${sync ? " (найдено при сверке)" : ""} — позиция закрыта по рынку`;
  }
  if (key.startsWith("source:stop_loss:")) {
    const rule = key.slice("source:stop_loss:".length);
    return `Отмена: ${src} отменил сигнал (${EARLY_CLOSE[rule] ?? rule}) — позиция закрыта по рынку. Убыток 5% и больше, поэтому ${src} засчитал сделку как стоп-лосс`;
  }
  if (key.startsWith("source:")) {
    const r = key.slice("source:".length);
    const why = SOURCE_CLOSE_REASON[r];
    return `${src} закрыл сделку${why ? ` ${why}` : r ? ` (${r})` : ""} — закрыта по рынку`;
  }
  switch (key) {
    case "stop_loss": return "Сработал стоп-лосс";
    case "stop_trailing_loss": return "Сработал подтянутый стоп (трейлинг) — итог ещё в минусе";
    case "stop_breakeven_slip": return "Сработал стоп в безубытке, исполнение с проскальзыванием в минус";
    case "stop_breakeven": return "Закрыта в безубыток: сработал стоп на уровне входа";
    case "stop_trailing_profit": return "Сработал трейлинг-стоп — прибыль зафиксирована";
    case "stop_breakeven_plus": return "Сработал стоп в безубытке — закрыта в небольшом плюсе";
    case "stop_source_profit": return `Сработал стоп в прибыли (передвинут ${src === "Источник" ? "источником" : src}) — прибыль зафиксирована`;
    case "stop_profit": return "Сработал стоп — закрыта в плюсе";
    case "take": return `Тейк${ctx.takePct ? ` +${ctx.takePct}%` : ""} исполнен — прибыль зафиксирована`;
    case "take_partial": return "Частичная фиксация прибыли";
    case "liquidation": return "ЛИКВИДАЦИЯ позиции";
    case "manual": return "Закрыта вручную на бирже";
    case "source": return `${src} закрыл сделку — закрыта по рынку`;
    case "source_sync": return `${src} уже закрыл сделку (найдено при сверке) — закрыта по рынку`;
    case "timeout": return "Истёк срок удержания — закрыта по рынку";
    case "no_margin_for_stop": return "Не хватило свободной маржи, чтобы увести ликвидацию за стоп — закрыта по рынку";
    case "liquidation_before_stop": return "Ликвидация осталась раньше стопа — закрыта по рынку, чтобы не потерять больше стопа";
    case "stop_passed": return "Цена уже прошла новый стоп — закрыта по рынку";
    default: return key;
  }
}

/** Result line from the real fills: price move and money, with the sign spelled out. */
export function resultLine(resultPct: number | null, pnl: number | null, asset: string): string {
  if (resultPct === null && pnl === null) return "Результат: биржа не вернула цену выхода";
  const p = resultPct === null ? "" : `${resultPct > 0 ? "+" : resultPct < 0 ? "−" : ""}${Math.abs(resultPct).toFixed(2)}% цены`;
  const m = pnl === null ? "" : `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${Math.abs(pnl).toFixed(2)} ${asset}`;
  const verdict = resultPct === null ? "" : resultPct >= FLAT_PCT ? "в плюсе" : resultPct <= -FLAT_PCT ? "в минусе" : "около нуля";
  return `Итог ${verdict}: ${[p, m].filter(Boolean).join(" · ")}`.replace("Итог : ", "Итог: ");
}

/** "Стоп перенесён" line: what kind of move it was. */
export function stopMoveLine(kind: StopKind, movedPct: number, source: string): string {
  const where = `${movedPct > 0 ? "+" : movedPct < 0 ? "−" : ""}${Math.abs(movedPct).toFixed(2)}% от входа`;
  const src = SOURCE_NAME[source] ?? "источник";
  switch (kind) {
    case "breakeven": return `Стоп перенесён в безубыток (на вход, ${where})`;
    case "trailing": return movedPct > 0 ? `Трейлинг-стоп подтянут: ${where} — эта прибыль уже защищена` : `Стоп подтянут (трейлинг): ${where}`;
    case "source": return movedPct > 0 ? `${src} передвинул стоп в прибыль: ${where}` : `${src} передвинул стоп: ${where}`;
    default: return `Стоп передвинут: ${where}`;
  }
}

/** Close reason → text for the journal page (any stored key, incl. legacy ones). */
export function closeReasonText(key: string | null, source: string): string | null {
  if (!key) return null;
  if (key === "stop") return closeLine("stop_loss", { source });
  if (key === "stop_profit") return closeLine("stop_profit", { source });
  if (key === "source_stop_already_hit") return closeLine("stop_passed", { source });
  return closeLine(key, { source });
}
