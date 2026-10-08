// The platform's contract wording: "SMCI $47 Call · 9 Oct (2DTE)" for a contract and
// "SMCI Sell $46 Call · 9 Oct (2DTE) · 11× @ 0.39" for an order. Pluto's text uses it; other screens and messages
// still have their own forms (PROGRESS.md lists them). Dates are parsed from the string, so the machine's timezone
// cannot shift a day.

const monthAbbreviations = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-09" (or IBKR's "20261009") → "9 Oct". */
export function formatDayMonth(expiry: string): string {
  const isoDate = /^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}` : expiry.slice(0, 10);
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${monthAbbreviations[month! - 1]}`;
}

/** "$46", "$42.5". */
export function formatStrike(strike: number): string {
  return `$${Number.isInteger(strike) ? strike : strike.toFixed(2).replace(/\.?0+$/, "")}`;
}

/** "C" / "call" → "Call", "P" / "put" → "Put". */
export function optionRightWord(right: string): "Call" | "Put" {
  return right === "C" || right.toLowerCase() === "call" ? "Call" : "Put";
}

/** Calendar days from an Eastern trading date to an expiry, both YYYY-MM-DD. */
export function daysToExpiry(expiryIso: string, todayIso: string): number {
  return Math.round((Date.parse(`${expiryIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
}

export interface OptionContractLabelInput {
  symbol?: string;
  strike: number;
  /** "C" / "P" or "call" / "put". */
  right: string;
  /** YYYY-MM-DD or YYYYMMDD. */
  expiry: string;
  /** Left out of the label when null. */
  dte: number | null;
}

/** "SMCI $47 Call · 9 Oct (2DTE)"; "$47 Call · 9 Oct (2DTE)" without a symbol. */
export function describeOptionContract(input: OptionContractLabelInput): string {
  const symbol = input.symbol ? `${input.symbol} ` : "";
  const dte = input.dte === null ? "" : ` (${input.dte}DTE)`;
  return `${symbol}${formatStrike(input.strike)} ${optionRightWord(input.right)} · ${formatDayMonth(input.expiry)}${dte}`;
}

/** " · 11× @ 0.39", or " · 11×" without a price. */
export function describeOrderSize(quantity: number, price: number | null): string {
  return ` · ${quantity}×${price === null ? "" : ` @ ${price.toFixed(2)}`}`;
}
