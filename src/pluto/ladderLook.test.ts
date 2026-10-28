import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import { latestCycleQuotes, runLadderLook, type LadderLookInput } from "./ladderLook.js";
import { ladderBaselineFromPlutoSettings } from "./ladderSettings.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T15:00:00Z");
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(todayIso, expiry);

/** A band quote priced at 50% IV with the stock at $50, 4% wide. */
function bandQuote(strike: number, right: "C" | "P", cycleNumber = 7): OptionQuoteBandQuote {
  const mid = blackScholesPriceOnForward(50 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
  return { expiry, strike, right, bid: Math.round(mid * 0.98 * 100) / 100, ask: Math.round(mid * 1.02 * 100) / 100, stockPrice: 50, errorCode: null, quotedAt: now, cycleNumber };
}
const bandQuotes = [50, 52.5, 55, 57.5, 60, 62.5].flatMap((strike) => [bandQuote(strike, "C"), bandQuote(100 - strike, "P")]);

function input(overrides: Partial<LadderLookInput> = {}): LadderLookInput {
  return {
    symbol: "LADR",
    now,
    clock: { todayIso, closeMinutesEt: 16 * 60, riskFreeRate: 0.04 },
    stockPrice: 50,
    previousClose: 49.5,
    memory: null,
    shockPctIfStartingToday: 70,
    baseline: ladderBaselineFromPlutoSettings(plutoLadderSettingsFixture as unknown as PlutoSettings),
    book: { tickerId: "t1", at: now, stockPrice: 50, positions: [], cycleRows: { optionRows: [], stockTradeRows: [], openStockShares: 0 }, freeCash: 100_000, accountValue: 200_000, tickerWeight: 0.25, commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator }, workingSales: [] },
    bandQuotes,
    forwardAnchors: new Map(),
    previousSessionVolumeByContract: new Map(bandQuotes.map((quote) => [contractKey(quote), 1_000])),
    maxQuoteAgeMinutes: 10,
    ...overrides,
  };
}

describe("runLadderLook", () => {
  it("a flat ticker: the memory records the account value, and its share budget is bought under Calls in the ladder's range", () => {
    const result = runLadderLook(input());
    expect(result.stoppedBecause).toBeNull();
    expect(result.memory).toEqual({ startedOn: null, accountValueAtStart: 200_000, shock: null });
    // The pot: 25% of $200,000 = $50,000; half for shares = $25,000 = 500 shares at $50.
    expect(result.planned.reduce((sum, sale) => sum + sale.sharesBought, 0)).toBe(500);
    expect(result.planned.every((sale) => sale.strategyKey === "covered_call" && Math.abs(sale.candidate.delta) >= 0.05 && Math.abs(sale.candidate.delta) <= 0.3)).toBe(true);
    // Priced at the mid: the ladder orders at the mid.
    expect(result.planned.every((sale) => Math.abs(sale.optionPrice - (sale.candidate.bid + sale.candidate.ask) / 2) < 1e-9)).toBe(true);
    expect(result.planned.every((sale) => sale.step === "entry")).toBe(true);
  });

  it("enters with a Cash-Secured Put when it ranks higher (the lab's higher_yield entry), inside the |delta| range and above the 20% yield", () => {
    const putsOnly = bandQuotes.filter((quote) => quote.right === "P");
    const result = runLadderLook(input({ bandQuotes: putsOnly }));
    expect(result.planned.length).toBeGreaterThan(0);
    for (const sale of result.planned) {
      expect(sale).toMatchObject({ strategyKey: "cash_secured_put", step: "entry", sharesBought: 0 });
      expect(Math.abs(sale.candidate.delta)).toBeGreaterThanOrEqual(0.05);
      expect(Math.abs(sale.candidate.delta)).toBeLessThanOrEqual(0.3);
      expect(sale.candidate.premiumYield).toBeGreaterThan(0.2);
    }
    // A cycle of an entry Put alone does not start the ladder: the memory keeps recording the account value.
    expect(result.memory).toEqual({ startedOn: null, accountValueAtStart: 200_000, shock: null });
  });

  it("stops on a price about a split's factor from the previous close, with nothing planned and the memory untouched", () => {
    const result = runLadderLook(input({ stockPrice: 25.1, previousClose: 50 }));
    expect(result).toMatchObject({ memory: null, planned: [] });
    expect(result.stoppedBecause).toBe("LADR trades at 25.10 against a previous close of 50.00, about a 2-for-1 split with none recorded: the ladder stops on it until a person looks");
  });

  it("sells nothing without the previous session's volumes, and says why", () => {
    const result = runLadderLook(input({ previousSessionVolumeByContract: null }));
    expect(result.planned).toEqual([]);
    expect(result.notes[0]).toBe("LADR: no previous-session option volume was captured, so nothing can be sold (the 20% rule)");
    expect(result.cannotTradeBecause).toBe("no_previous_session_volume");
    expect(runLadderLook(input()).cannotTradeBecause).toBeNull();
  });

  it("plans nothing when the band's latest quotes are older than Pluto's quote-age limit (B2), and says why", () => {
    const elevenMinutesLater = new Date(now.getTime() + 11 * 60_000);
    const result = runLadderLook(input({ now: elevenMinutesLater }));
    expect(result).toMatchObject({ stoppedBecause: null, planned: [], cannotTradeBecause: "stale_band_quotes", notes: ["LADR: the band's latest quotes are older than 10 minutes, so nothing is planned"] });
    expect(result.memory).toEqual({ startedOn: null, accountValueAtStart: 200_000, shock: null });
    // Within the limit the same quotes are sold on.
    expect(runLadderLook(input({ now: new Date(now.getTime() + 10 * 60_000) })).planned.length).toBeGreaterThan(0);
  });
});

describe("latestCycleQuotes", () => {
  it("keeps only the loop's latest cycle on the ticker (an older quote may have left the band) and drops errored quotes", () => {
    const { quotes, stale } = latestCycleQuotes([bandQuote(55, "C", 6), bandQuote(57.5, "C", 7), { ...bandQuote(60, "C", 7), errorCode: 200 }], now, 10);
    expect(quotes.map((quote) => quote.strike)).toEqual([57.5]);
    expect(stale).toBe(false);
  });

  it("leaves out quotes older than the limit; stale only when the latest cycle has none fresher", () => {
    const old = { ...bandQuote(55, "C", 7), quotedAt: new Date(now.getTime() - 15 * 60_000) };
    expect(latestCycleQuotes([old, bandQuote(57.5, "C", 7)], now, 10)).toMatchObject({ quotes: [{ strike: 57.5 }], stale: false });
    expect(latestCycleQuotes([old], now, 10)).toEqual({ quotes: [], stale: true });
    expect(latestCycleQuotes([], now, 10)).toEqual({ quotes: [], stale: false });
  });
});
