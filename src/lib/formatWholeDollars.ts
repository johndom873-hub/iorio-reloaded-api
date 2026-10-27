// Whole dollars for messages, thousands grouped: "$50,036". The minus sign (−) goes before the "$", as in
// formatSignedDollars: "−$1,084", never "$-1,084"; alwaysShowPlus puts a "+" before the rest ("+$50,036"). An amount that
// rounds to zero is never negative.
// One formatter for every call: the backtest writes these texts ~100k times a session-year, and toLocaleString builds a
// number format each time (intlFormatterGuard.test.ts).
const groupedWholeNumber = new Intl.NumberFormat("en-US");

export function formatWholeDollars(amount: number, alwaysShowPlus = false): string {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? "−" : alwaysShowPlus ? "+" : ""}$${groupedWholeNumber.format(Math.abs(rounded))}`;
}
