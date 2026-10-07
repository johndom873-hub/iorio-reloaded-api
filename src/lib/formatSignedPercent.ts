// Percentages for messages, same sign convention as formatSignedDollars: "+0.50%", "−1.25%", and never a negative zero.
export function formatSignedPercent(percent: number, fractionDigits: number): string {
  const magnitude = Math.abs(percent).toFixed(fractionDigits);
  const roundsToZero = Number(magnitude) === 0;
  const sign = roundsToZero ? "" : percent < 0 ? "−" : "+";
  return `${sign}${magnitude}%`;
}
