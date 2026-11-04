import { describe, expect, it } from "vitest";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import { latestCycleQuotes } from "./latestBandQuotes.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T15:00:00Z");
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(todayIso, expiry);

/** A band quote priced at 50% IV with the stock at $50, 4% wide. */
function bandQuote(strike: number, right: "C" | "P", cycleNumber = 7): OptionQuoteBandQuote {
  const mid = blackScholesPriceOnForward(50 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
  return { expiry, strike, right, bid: Math.round(mid * 0.98 * 100) / 100, ask: Math.round(mid * 1.02 * 100) / 100, bidSize: 100, askSize: 100, stockPrice: 50, errorCode: null, quotedAt: now, cycleNumber };
}
const bandQuotes = [50, 52.5, 55, 57.5, 60, 62.5].flatMap((strike) => [bandQuote(strike, "C"), bandQuote(100 - strike, "P")]);
/** The cycle the quotes above belong to: it began quoting 30 seconds before they were stamped. */
const bandCycle = { cycleNumber: 7, startedAt: new Date(now.getTime() - 30_000), finishedAt: now };

describe("latestCycleQuotes", () => {
  it("reads the ticker's quotes from its newest finished cycle on (one from before may have left the band) and drops errored quotes", () => {
    const beforeTheCycle = { ...bandQuote(55, "C", 6), quotedAt: new Date(bandCycle.startedAt.getTime() - 1) };
    const { quotes, stale } = latestCycleQuotes([beforeTheCycle, bandQuote(57.5, "C"), { ...bandQuote(60, "C"), errorCode: 200 }], bandCycle, now, 10);
    expect(quotes.map((quote) => quote.strike)).toEqual([57.5]);
    expect(stale).toBe(false);
  });

  it("keeps the next cycle's quotes stored so far with the finished cycle's (the Puts of a cycle are stored before its Calls)", () => {
    const nextCyclesPut = { ...bandQuote(45, "P", 8), quotedAt: new Date(now.getTime() + 20_000) };
    const { quotes } = latestCycleQuotes([bandQuote(57.5, "C"), nextCyclesPut], bandCycle, new Date(now.getTime() + 25_000), 10);
    expect(quotes.map((quote) => `${quote.strike} ${quote.right}`)).toEqual(["57.5 C", "45 P"]);
  });

  it("goes by the cycle's start, not its number, which restarts at 1 with the process", () => {
    const beforeTheRestart = { ...bandQuote(55, "C", 300), quotedAt: new Date(now.getTime() - 5 * 60_000) };
    const afterTheRestart = { ...bandQuote(57.5, "C", 2), quotedAt: now };
    const { quotes } = latestCycleQuotes([beforeTheRestart, afterTheRestart], { startedAt: new Date(now.getTime() - 30_000) }, now, 10);
    expect(quotes.map((quote) => quote.strike)).toEqual([57.5]);
  });

  it("leaves out quotes older than the limit; stale only when the cycle's quotes are all older", () => {
    const longAgo = new Date(now.getTime() - 15 * 60_000);
    const cycleLongAgo = { startedAt: new Date(longAgo.getTime() - 30_000) };
    const old = { ...bandQuote(55, "C"), quotedAt: longAgo };
    expect(latestCycleQuotes([old, bandQuote(57.5, "C")], cycleLongAgo, now, 10)).toMatchObject({ quotes: [{ strike: 57.5 }], stale: false });
    expect(latestCycleQuotes([old], cycleLongAgo, now, 10)).toEqual({ quotes: [], stale: true });
    expect(latestCycleQuotes([], bandCycle, now, 10)).toEqual({ quotes: [], stale: false });
  });

  it("has no quotes before the ticker's first cycle finishes", () => {
    expect(latestCycleQuotes(bandQuotes, null, now, 10)).toEqual({ quotes: [], stale: false });
  });
});
