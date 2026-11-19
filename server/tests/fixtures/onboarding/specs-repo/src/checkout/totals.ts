// TODO(TL-5): totals are summed as floats; switch to integer cents (constitution I).
export function total(lines: { price: number; qty: number }[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}
