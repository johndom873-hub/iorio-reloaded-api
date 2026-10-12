// What the model sees in the backtest's LLM mode (Marcelo 2026-10-12, docs/backtesting/FULL-FIDELITY-DESIGN.md §5):
// the model's training data covers most of the replayed years, so every symbol becomes STOCK_A, STOCK_B, … (in the
// order the session lists them) and every date moves forward a whole number of weeks, so weekdays stay as they were.
// Prices and ratios are unchanged. Works on the JSON text of the payload and of the model's answer, both ways.

/** 1,044 weeks ≈ 20 years: 2024-03-15 (Fri) → 2044-03-18 (Fri). */
export const maskedDateShiftWeeks = 1044;

export interface PlutoPromptMasking {
  aliasBySymbol: Record<string, string>;
  dateShiftWeeks: number;
}

const millisecondsPerDay = 86_400_000;
const isoDatePattern = /(?<![0-9])(\d{4})-(\d{2})-(\d{2})(?![0-9])/g;
const aliasPattern = /(?<![A-Za-z0-9_.])STOCK_[A-Z]+(?![A-Za-z0-9_])/g;

/** STOCK_A … STOCK_Z, then STOCK_AA, STOCK_AB, … */
function aliasForPosition(position: number): string {
  let letters = "";
  let remaining = position;
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `STOCK_${letters}`;
}

export function createPlutoPromptMasking(symbols: string[]): PlutoPromptMasking {
  const distinctSymbols = [...new Set(symbols)];
  return { aliasBySymbol: Object.fromEntries(distinctSymbols.map((symbol, position) => [symbol, aliasForPosition(position)])), dateShiftWeeks: maskedDateShiftWeeks };
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shiftIsoDates(text: string, days: number): string {
  return text.replace(isoDatePattern, (whole, year: string, month: string, day: string) => {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return whole;
    return new Date(date.getTime() + days * millisecondsPerDay).toISOString().slice(0, 10);
  });
}

/** The text the model is given: symbols replaced by their aliases, dates moved forward. */
export function maskPlutoText(text: string, masking: PlutoPromptMasking): string {
  const symbolsLongestFirst = Object.keys(masking.aliasBySymbol).sort((first, second) => second.length - first.length);
  const withAliases =
    symbolsLongestFirst.length === 0
      ? text
      : text.replace(new RegExp(`(?<![A-Za-z0-9_.])(${symbolsLongestFirst.map(escapeForPattern).join("|")})(?![A-Za-z0-9_.])`, "g"), (symbol) => masking.aliasBySymbol[symbol]!);
  return shiftIsoDates(withAliases, masking.dateShiftWeeks * 7);
}

/** The model's answer in real terms: aliases back to symbols, dates moved back. An alias the session does not have is left as it is. */
export function unmaskPlutoText(text: string, masking: PlutoPromptMasking): string {
  const symbolByAlias = new Map(Object.entries(masking.aliasBySymbol).map(([symbol, alias]) => [alias, symbol]));
  const withSymbols = text.replace(aliasPattern, (alias) => symbolByAlias.get(alias) ?? alias);
  return shiftIsoDates(withSymbols, -masking.dateShiftWeeks * 7);
}
