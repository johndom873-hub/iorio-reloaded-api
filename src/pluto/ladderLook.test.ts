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
/** The cycle the quotes above belong to: it began quoting 30 seconds before they were stamped. */
const bandCycle = { cycleNumber: 7, startedAt: new Date(now.getTime() - 30_000), finishedAt: now };

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
    bandCycle,
    forwardAnchors: new Map(),
    previousSessionVolumeByContract: new Map(bandQuotes.map((quote) => [contractKey(quote), 1_000])),
    maxQuoteAgeMinutes: 10,
    // Tuesday 20 October to Friday 20 November: 24 sessions.
    tradingSessionsThrough: () => 24,
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

  it("without the previous session's volumes, sells with the 20% rule lifted on the expiry for the day, and says so", () => {
    const withVolumes = runLadderLook(input());
    const result = runLadderLook(input({ previousSessionVolumeByContract: null }));
    const sales = (planned: typeof result.planned) => planned.map(({ expiry, strike, right, contracts }) => ({ expiry, strike, right, contracts }));
    expect(sales(result.planned)).toEqual(sales(withVolumes.planned));
    expect(result.planned.length).toBeGreaterThan(0);
    // No volume limit on the lifted expiry (1,000 traded allowed 200 contracts).
    expect(result.planned[0]!.scores.bestCandidateVolumeCap).toBe(Number.POSITIVE_INFINITY);
    expect(withVolumes.planned[0]!.scores.bestCandidateVolumeCap).toBe(200);
    expect(result.notes[0]).toBe("LADR: no previous-session volume for 20 Nov (31DTE): the 20% volume rule is off for it today");
    expect(result.cannotTradeBecause).toBeNull();
    expect(withVolumes.notes.some((note) => note.includes("20% volume rule is off"))).toBe(false);
  });

  it("keeps the 20% rule on an expiry the capture covered: too little volume sells nothing there", () => {
    const tooLittle = new Map(bandQuotes.map((quote) => [contractKey(quote), 4]));
    const result = runLadderLook(input({ previousSessionVolumeByContract: tooLittle }));
    expect(result.planned).toEqual([]);
    expect(result.notes.some((note) => note.includes("20% volume rule is off"))).toBe(false);
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
