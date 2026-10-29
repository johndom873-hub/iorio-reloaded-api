import { describe, expect, it } from "vitest";
import { scanChainDay, summarizeChainScan, volumeByContract, type ChainScanDayInput, type ChainScanSettings } from "./analysisChainScan.js";
import type { BacktestSymbolFile, SymbolFileEndOfDayRow, SymbolFileQuote } from "../engine/backtestSymbolFile.js";
import { noteBaselineForwardAnchors, selectBaselineCandidates, type BaselineForwardAnchor } from "../engine/baselineSaleSteps.js";
import { defaultBacktestBaselineSettings } from "../backtestTypes.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { sessionsHeldAmong } from "../../lib/tradingSessionsHeld.js";

const day: ChainScanDayInput = { date: "2026-10-01", previousDate: "2026-09-30", spot: 100, riskFreeRate: 0.04, shock: 0.5, earningsDatesIso: null };
const expiries = ["2026-10-09", "2026-10-23"];
const quotes: SymbolFileQuote[] = expiries.flatMap((expiry) =>
  Array.from({ length: 13 }, (_, index) => 70 + index * 5).flatMap((strike) =>
    (["C", "P"] as const).map((right) => {
      const years = yearsBetweenIsoDates(day.date, expiry);
      const price = blackScholesPriceOnForward(100 * Math.exp(0.04 * years), strike, years, 0.04, 0.4, right === "C");
      return { expiry, strike, right, bid: Math.round(price * 0.97 * 100) / 100, ask: Math.round(price * 1.03 * 100) / 100, bidSize: 10, askSize: 10 };
    }),
  ),
);
const endOfDay: SymbolFileEndOfDayRow[] = quotes.map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, close: null, volume: 1000, bid: null, ask: null }) as SymbolFileEndOfDayRow);
const file = { loadQuotes: () => quotes, loadEndOfDay: () => endOfDay } as unknown as BacktestSymbolFile;
const settings: ChainScanSettings = { ...defaultBacktestBaselineSettings, spreadShareCharged: 0.5 };
/** October 2026's weekdays, every one a session: what the yields are annualized over. */
const openDays = Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`).filter((dateIso) => ![0, 6].includes(new Date(`${dateIso}T12:00:00Z`).getUTCDay()));

/** The engine's selector at the shared range, as the scan selected before the toggle. */
const passingInSharedRange = () => {
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso: day.date, yearsToTodaysClose: 6 / 8760, stockPrice: 100, riskFreeRate: day.riskFreeRate });
  return (["C", "P"] as const).flatMap(
    (right) =>
      selectBaselineCandidates({
        quotes,
        forwardAnchors,
        commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator },
        right,
        todayIso: day.date,
        yearsToTodaysClose: 6 / 8760,
        stockPrice: 100,
        riskFreeRate: day.riskFreeRate,
        previousSessionVolumeByContract: volumeByContract(endOfDay),
        settings,
        spreadShareCharged: settings.spreadShareCharged,
        isHeld: () => false,
        tradingSessionsThrough: (expiry) => sessionsHeldAmong(openDays, day.date, expiry),
      }).candidates,
  );
};

describe("chain scan |delta| toggle", () => {
  it("counts inside the shared range exactly what the selector passes at that range", () => {
    const row = scanChainDay(file, day, settings, openDays);
    expect(row.passingByDelta.band.passingTotal).toBe(passingInSharedRange().length);
    expect(row.passingByDelta.band.passingTotal).toBeGreaterThan(0);
    expect(row.passingByDelta.any.passingTotal).toBeGreaterThan(row.passingByDelta.band.passingTotal);
  });

  it("keeps the lab's rules in cells: the shared range, or any |delta| for ladder Puts with none", () => {
    const shared = scanChainDay(file, day, settings, openDays);
    expect(shared.cells).toEqual(shared.cellsByDelta.band);
    expect(shared.passingTotal).toBe(shared.passingByDelta.band.passingTotal);

    const putsAnyDelta = scanChainDay(file, day, { ...settings, ladderPutDeltaRange: "none" }, openDays);
    expect(putsAnyDelta.cells.P).toEqual(putsAnyDelta.cellsByDelta.any.P);
    expect(putsAnyDelta.cells.Pcap).toEqual(putsAnyDelta.cellsByDelta.any.Pcap);
    expect(putsAnyDelta.cells.C).toEqual(putsAnyDelta.cellsByDelta.band.C);
  });

  it("holds Calls to the shared range in the band view even when the lab gives them their own", () => {
    const row = scanChainDay(file, day, { ...settings, callDeltaRange: "own_range", callMinAbsDelta: 0.3, callMaxAbsDelta: 0.4 }, openDays);
    const count = (cells: typeof row.cells) => Object.values(cells.C).reduce((sum, cell) => sum + (cell?.count ?? 0), 0);
    expect(count(row.cellsByDelta.band)).toBe(count(scanChainDay(file, day, settings, openDays).cells));
    expect(count(row.cells)).toBeLessThan(count(row.cellsByDelta.band));
  });

  it("summarises each |delta| view into its own grid and spread share", () => {
    const summary = summarizeChainScan([scanChainDay(file, day, { ...settings, ladderPutDeltaRange: "none" }, openDays)]);
    expect(summary.gridByDelta.any.P).toEqual(summary.grid.P);
    expect(summary.gridByDelta.band.C).toEqual(summary.grid.C);
    expect(summary.gridByDelta.any.P["2026"]!["8-14"].medianPassingPerDay).toBeGreaterThan(summary.gridByDelta.band.P["2026"]!["8-14"].medianPassingPerDay);
    expect(summary.spreadShareUnder25ByDelta.any).toBe(1);
  });
});
