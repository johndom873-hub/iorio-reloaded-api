// The account's books (Marcelo 2026-11-05): Pluto (the tickers Pluto is switched on for, hedges excepted) and Manual
// (everything else, whoever trades it). Unallocated is not a book: it holds deposits and withdrawals until an admin
// splits them, and no order can use it.

export type BookKey = "pluto" | "manual";
export type LedgerBookKey = BookKey | "unallocated";

export const bookKeys: readonly BookKey[] = ["pluto", "manual"];

export const bookLabels: Record<LedgerBookKey, string> = { pluto: "Pluto", manual: "Manual", unallocated: "Unallocated" };

/** The other book. */
export function otherBook(book: BookKey): BookKey {
  return book === "pluto" ? "manual" : "pluto";
}

export function isBookKey(value: unknown): value is BookKey {
  return value === "pluto" || value === "manual";
}
