import type { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { noteBaselineForwardAnchors, selectBaselineCandidates, volFarmerV4SaleFill, type BaselineCommissions, type BaselineForwardAnchor } from "../engine/baselineSaleSteps.js";
import { captureLookTimeEt, lookInstantMs } from "../engine/backtestTickerInputs.js";
import { expirySettlementInstant } from "../engine/ledger/ledgerEvents.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { sessionsHeldAmong } from "../../lib/tradingSessionsHeld.js";

// The Calls Vol Farmer v4 could sell on each expiry day (F5 for v4, approved by Marcelo 2026-11-01), read from the data
// file's 10:00 quotes with the engine's own candidate rules (selectBaselineCandidates, as v4's look calls it): a Call
// expiring at that day's close, struck above the 10:00 price, |delta| within v4's Call range (0.05–0.5), bid at least
// $0.05, spread at most v4's limit (50% of the mid); the pick is the best by premium yield. Each day also gives F4's lots:
// the most lots any of those Calls has bid size for (its size limit: the bid size of its 10:00 quote, Marcelo 2026-11-05).

/** The flat rates the backtest's ledger charges, as v4's look ranks with them. */
const ledgerCommissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const millisecondsPerYear = 365 * 86_400_000;

export interface SameDayCallScanSettings {
  callMinAbsDelta: number;
  callMaxAbsDelta: number;
  maxSpreadPctOfMid: number;
}

export interface SameDayCallScanDay {
  date: string;
  /** The previous complete file day, whose end-of-day volume sets the volume limit; null on the file's first day. */
  previousDate: string | null;
  /** The 10:00 price as traded; null when there is none (the day is skipped). */
  spot: number | null;
  /** As a fraction. */
  riskFreeRate: number;
}

export interface SameDayCall {
  strike: number;
  bid: number;
  ask: number;
  fillPrice: number;
  delta: number;
  impliedVolatility: number;
  premiumYield: number;
  volumeCap: number;
}

export interface SameDayCallDay {
  date: string;
  spot: number | null;
  /** The day's Calls expiring at its close that pass every filter. */
  qualifying: number;
  /** F5's pick: the best of them by premium yield; null when none passes. */
  best: SameDayCall | null;
  /** F4's L: the most lots any of them has bid size for; 0 when none passes. */
  mostLotsByVolume: number;
}

/** One expiry day. `openDays`: the sessions the premium yields are annualized over (tradingSessionsHeld.ts). */
export function scanSameDayCalls(file: BacktestSymbolFile, day: SameDayCallScanDay, settings: SameDayCallScanSettings, openDays: readonly string[]): SameDayCallDay {
  const empty: SameDayCallDay = { date: day.date, spot: day.spot, qualifying: 0, best: null, mostLotsByVolume: 0 };
  if (day.spot === null) return empty;
  const spot = day.spot;
  // The expiry's Calls and Puts, as the engine's 10:00 look reads the next Call expiry: the forward comes from their parity.
  const quotes = file.loadQuotes(day.date).filter((quote) => quote.expiry === day.date);
  if (!quotes.some((quote) => quote.right === "C")) return empty;
  const yearsToTodaysClose = Math.max(0, expirySettlementInstant(day.date).getTime() - lookInstantMs(day.date, captureLookTimeEt)) / millisecondsPerYear;
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso: day.date, yearsToTodaysClose, stockPrice: spot, riskFreeRate: day.riskFreeRate });
  const { candidates } = selectBaselineCandidates({
    quotes,
    forwardAnchors,
    commissions: ledgerCommissions,
    right: "C",
    todayIso: day.date,
    yearsToTodaysClose,
    stockPrice: spot,
    riskFreeRate: day.riskFreeRate,
    // v4's volume limit is the bid size of the 10:00 quote (Marcelo 2026-11-05), not a share of the previous session's volume.
    previousSessionVolumeByContract: null,
    sizeLimit: "bid_size",
    settings: { minAbsDelta: settings.callMinAbsDelta, maxAbsDelta: settings.callMaxAbsDelta, minDte: 0, maxDte: 0, maxSpreadPctOfMid: settings.maxSpreadPctOfMid },
    // Priced as v4 sells (Marcelo 2026-11-07): one cent past the mid, never below the bid.
    saleFill: volFarmerV4SaleFill,
    isHeld: () => false,
    tradingSessionsThrough: (expiry) => sessionsHeldAmong(openDays, day.date, expiry),
  });
  const aboveThePrice = candidates.filter((candidate) => candidate.strike > spot);
  if (aboveThePrice.length === 0) return empty;
  const best = aboveThePrice.reduce((top, candidate) => (candidate.premiumYield > top.premiumYield ? candidate : top), aboveThePrice[0]!);
  return {
    date: day.date,
    spot,
    qualifying: aboveThePrice.length,
    best: { strike: best.strike, bid: best.bid, ask: best.ask, fillPrice: best.fillPrice, delta: best.delta, impliedVolatility: best.impliedVolatility, premiumYield: best.premiumYield, volumeCap: best.volumeCap },
    mostLotsByVolume: Math.max(...aboveThePrice.map((candidate) => candidate.volumeCap)),
  };
}
