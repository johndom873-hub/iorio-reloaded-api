// Dollar amounts for messages: the minus sign (−, as in the rest of the Signals messages) goes before the "$", never inside
// it ("−$0.05", not "$-0.05"). An amount that rounds to zero is never negative.
export function formatSignedDollars(amount: number, fractionDigits: number, alwaysShowPlus = false): string {
  const magnitude = Math.abs(amount).toFixed(fractionDigits);
  const roundsToZero = Number(magnitude) === 0;
  const sign = amount < 0 && !roundsToZero ? "−" : alwaysShowPlus ? "+" : "";
  return `${sign}$${magnitude}`;
}
