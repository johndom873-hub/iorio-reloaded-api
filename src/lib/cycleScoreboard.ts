import type { BookKey } from "../books/bookKeys.js";
import { bookOfTickerAt, type TickerBookPeriod } from "../books/tickerBookPeriods.js";
import type { SymbolCycles } from "./cycleQueries.js";

// The Positions page's strategy scoreboard (approved 2026-09-19): every cycle of every symbol attributed to the CSP /
// Unstructured / CC / Hedge / LEAPS buckets. Cycles whose ledger can't be trusted (dataFlags) are left out and counted.
// By book (Marcelo 2026-11-11): a whole cycle counts in the book its ticker was in when it ended (an open one, the book
// now); its Hedge bucket is always Manual's, as a hedge is outside Pluto's book. Example: NVDA held by Manual, Pluto
// switched on for it, the cycle closed later: all of it is Pluto's but its hedge P&L, which stays Manual's.

const bucketKeys = ["csp", "unstructured", "cc", "hedge", "leaps"] as const;
type ScoreboardBucketKey = (typeof bucketKeys)[number];

interface ScoreboardBucket {
  premium: number;
  stock: number;
  total: number;
  capital: number;
}

export interface CycleScoreboard {
  buckets: Record<ScoreboardBucketKey, ScoreboardBucket & { returnOnCapital: number | null }>;
  total: number;
  cyclesIncluded: number;
  cyclesExcluded: { symbol: string; reason: string }[];
}

/** Pure: the scoreboard over every cycle (`book` null), or over one book's under the rule above. */
export function buildCycleScoreboard(symbolCycles: readonly SymbolCycles[], book: BookKey | null, bookPeriods: readonly TickerBookPeriod[], now: Date): CycleScoreboard {
  const zero = (): ScoreboardBucket => ({ premium: 0, stock: 0, total: 0, capital: 0 });
  const buckets: Record<ScoreboardBucketKey, ScoreboardBucket> = { csp: zero(), unstructured: zero(), cc: zero(), hedge: zero(), leaps: zero() };
  let cyclesIncluded = 0;
  const cyclesExcluded: { symbol: string; reason: string }[] = [];
  for (const { symbol, tickerId, cycles } of symbolCycles) {
    for (const cycle of cycles) {
      const cycleBook = bookOfTickerAt(bookPeriods, tickerId, cycle.endAt ?? now);
      const bucketBook = (key: ScoreboardBucketKey): BookKey => (key === "hedge" ? "manual" : cycleBook);
      const countedKeys = bucketKeys.filter((key) => book === null || bucketBook(key) === book);
      if (countedKeys.length === 0) continue;
      const cycleInBook = book === null || cycleBook === book;
      if (cycle.dataFlags.length > 0) {
        if (cycleInBook) cyclesExcluded.push({ symbol, reason: cycle.dataFlags[0]! });
        continue;
      }
      if (cycleInBook) cyclesIncluded += 1;
      for (const key of countedKeys) {
        buckets[key].premium += cycle.buckets[key].premium;
        buckets[key].stock += cycle.buckets[key].stock;
        buckets[key].total += cycle.buckets[key].total;
        buckets[key].capital += cycle.buckets[key].capital;
      }
    }
  }
  const withReturn = (bucket: ScoreboardBucket) => ({ ...bucket, returnOnCapital: bucket.capital > 0 ? bucket.total / bucket.capital : null });
  return {
    buckets: { csp: withReturn(buckets.csp), unstructured: withReturn(buckets.unstructured), cc: withReturn(buckets.cc), hedge: withReturn(buckets.hedge), leaps: withReturn(buckets.leaps) },
    total: bucketKeys.reduce((sum, key) => sum + buckets[key].total, 0),
    cyclesIncluded,
    cyclesExcluded,
  };
}
