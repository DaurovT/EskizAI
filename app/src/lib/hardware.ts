/** SCR-26: подпись разницы цены варианта фурнитуры (без React — покрыто тестами). */
import type { HardwareOption } from '../api/types';

/** Сотруднику — только направление (↑/↓): сумм он не видит. */
export function deltaText(o: Pick<HardwareOption, 'delta' | 'current'>, money: (v: number) => string, showMoney: boolean): string {
  if (o.current || o.delta == null) return '';
  if (o.delta === 0) return '±0';
  if (!showMoney) return o.delta > 0 ? '↑' : '↓';
  return `${o.delta > 0 ? '+' : '−'}${money(Math.abs(o.delta))}`;
}
