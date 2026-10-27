// One option contract as the live quote paths and the backtests key it: "2026-11-20|105|C".

export interface ContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

/** A live two-sided (or one-sided) quote on one contract. */
export interface LiveOptionQuote extends ContractRef {
  bid: number | null;
  ask: number | null;
  /** ISO time the quote was received; the pooled live path leaves it unset (the frame's `at` is the time). */
  quotedAt?: string;
  /** IBKR's own delta, only where the source carries it (the pooled option line does). */
  delta?: number | null;
}

export function contractKey(ref: ContractRef): string {
  return `${ref.expiry}|${ref.strike}|${ref.right}`;
}
