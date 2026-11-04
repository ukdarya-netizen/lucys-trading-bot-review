import assert from "node:assert/strict";
import { test } from "node:test";
import { closeLine, closeReasonText, resultLine, stopCloseKey, stopKindFor, stopMoveLine } from "./texts";

test("stop kind from who moved it and where it is", () => {
  assert.equal(stopKindFor("trailing", "long", 100, 110), "trailing");
  assert.equal(stopKindFor("trailing_stop_update", "long", 100, 95), "trailing");
  assert.equal(stopKindFor("trailing_or_breakeven_protection", "long", 100, 100.1), "breakeven");
  assert.equal(stopKindFor("trailing_or_breakeven_protection", "long", 100, 104), "trailing");
  assert.equal(stopKindFor("runner_trailing_stop_update", "long", 100, 120), "trailing");
  assert.equal(stopKindFor("breakeven", "short", 100, 100), "breakeven");
  assert.equal(stopKindFor("initial_stop_update", "long", 100, 92), "initial");
  assert.equal(stopKindFor("source_sync", "long", 100, 106), "source");
  assert.equal(stopKindFor("source_sync", "short", 100, 94), "source");
  assert.equal(stopKindFor("source_sync", "short", 100, 106), "initial");
  assert.equal(stopKindFor("source_sync", "long", 100, 100.2), "breakeven");
});

test("every stop close is named by the stop's kind AND the real result", () => {
  const cases: Array<[Parameters<typeof stopCloseKey>[0], number, string]> = [
    ["initial", -9, "stop_loss"],
    ["trailing", -3, "stop_trailing_loss"],
    ["breakeven", -0.8, "stop_breakeven_slip"],
    ["source", -0.8, "stop_breakeven_slip"],
    ["initial", 0.1, "stop_breakeven"],
    ["breakeven", 0, "stop_breakeven"],
    ["trailing", 12, "stop_trailing_profit"],
    ["breakeven", 0.6, "stop_breakeven_plus"],
    ["source", 7, "stop_source_profit"],
    ["initial", 2, "stop_profit"],
  ];
  for (const [kind, r, key] of cases) {
    assert.equal(stopCloseKey(kind, r), key, `${kind} ${r}`);
    const line = closeLine(key, { source: "cab" });
    if (r > 0.3) assert.doesNotMatch(line, /стоп-лосс/, line);
    if (r > 0.3) assert.match(line, /плюс|прибыль/, line);
    if (r <= -0.3 && kind === "initial") assert.match(line, /стоп-лосс/);
  }
});

test("source closes say who closed and why; other closes have their own text", () => {
  assert.equal(closeLine("source:trailing_stop", { source: "cab" }), "CAB закрыл сделку по трейлинг-стопу — закрыта по рынку");
  assert.equal(closeLine("source:expired", { source: "nihilist" }), "Нигилист закрыл сделку по сроку сделки — закрыта по рынку");
  assert.equal(closeLine("source:stop_loss", { source: "nihilist" }), "Нигилист закрыл сделку по своему стоп-лоссу — закрыта по рынку");
  assert.equal(closeLine("source:cancelled", { source: "cab" }), "CAB закрыл сделку — сигнал отменён — закрыта по рынку");
  assert.equal(closeLine("take", { source: "cab", takePct: 5 }), "Тейк +5% исполнен — прибыль зафиксирована");
  for (const k of ["liquidation", "manual", "source_sync", "timeout", "no_margin_for_stop", "liquidation_before_stop", "take_partial"]) {
    assert.notEqual(closeLine(k, { source: "cab" }), k, k);
  }
  assert.equal(closeReasonText("stop", "cab"), "Сработал стоп-лосс");
  assert.equal(closeReasonText(null, "cab"), null);
});

test("result line spells out the sign; stop move lines", () => {
  assert.equal(resultLine(12.345, 61.7, "VST"), "Итог в плюсе: +12.35% цены · +61.70 VST");
  assert.equal(resultLine(-9, -45, "USDT"), "Итог в минусе: −9.00% цены · −45.00 USDT");
  assert.equal(resultLine(0.05, 0.2, "VST"), "Итог около нуля: +0.05% цены · +0.20 VST");
  assert.equal(resultLine(null, null, "VST"), "Результат: биржа не вернула цену выхода");
  assert.equal(stopMoveLine("breakeven", 0, "cab"), "Стоп перенесён в безубыток (на вход, 0.00% от входа)");
  assert.equal(stopMoveLine("trailing", 8, "nihilist"), "Трейлинг-стоп подтянут: +8.00% от входа — эта прибыль уже защищена");
  assert.equal(stopMoveLine("source", 3, "cab"), "CAB передвинул стоп в прибыль: +3.00% от входа");
  assert.equal(stopMoveLine("initial", -6, "cab"), "Стоп передвинут: −6.00% от входа");
});
