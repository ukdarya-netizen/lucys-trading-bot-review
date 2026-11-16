// Owner 2026-11-16 («никто не будет читать тучу мелкого текста»): the one warning that matters, at the top of the
// cabinet, large and short. Facts from the executor: size % of the whole balance (marginFor), no_funds when the free
// margin is short, IOC entry (0.5 %), SIGNAL_TTL_MS (10 min), price beyond the stop, BingX minimum lot / no contract.
import { AlertTriangle } from "lucide-react";

export function TradeWarnings() {
  return (
    <section role="note" className="border-2 border-amber-400 bg-amber-400/15 p-4" data-testid="trade-warnings">
      <p className="flex items-center gap-2 text-base font-bold text-amber-300"><AlertTriangle className="h-5 w-5" />Бот открывает не каждый сигнал</p>
      <ul className="mt-2 space-y-1 text-sm">
        <li><b>Нет свободной маржи — нет сделки.</b> Процент сделки считается от всего баланса, а маржа берётся из свободной.</li>
        <li><b>Цена ушла больше чем на 0,5%</b>, сигнал опоздал больше чем на 10 минут или цена уже за стопом — сделка не открывается.</li>
        <li><b>Сумма меньше минимальной на BingX</b> или монеты нет на BingX — сделка не открывается.</li>
      </ul>
      <p className="mt-2 text-sm">Поэтому результат счёта может отличаться от результатов стратегий.</p>
    </section>
  );
}
