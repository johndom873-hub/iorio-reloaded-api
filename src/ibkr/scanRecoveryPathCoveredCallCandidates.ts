import { OptionType } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";
import type { RecoveryTargetWindow } from "../lib/recoveryTargetWindow.js";
import { fetchCalendarConflictContext, findCalendarConflict } from "./calendarConflict.js";
import { daysBetween, loadStoredOptionChain, parseExpiry, type ExpiryStrikes, type OptionQuote } from "./fetchOptionChain.js";
import { quoteContracts } from "./quoteContracts.js";

export interface CoveredCallCandidate {
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: "call";
  delta: number;
  /** Mid of bid/ask, or the last price when the quote isn't two-sided. */
  premium: number;
  bid: number | null;
  ask: number | null;
  dte: number;
  annualizedYield: number;
  spotPrice: number;
  /**
   * True when the ticker has never resolved to a TradingView symbol, so its
   * earnings/ex-dividend calendar couldn't be checked — the candidate was NOT
   * excluded on that basis (absence of data isn't evidence of absence of an
   * event), but the caller should say so rather than imply a clean check.
   */
  calendarUnverified: boolean;
}

// Bounded to keep IBKR call volume predictable: only the nearest expiries
// inside the DTE window, and a percentage-of-spot strike band rather than a
// fixed nearest-N count — a 0.20-0.30 delta call can sit 10-12% OTM on a
// higher-IV underlying, so 40% covers it with margin. Capped at 50 strikes
// per expiry against pathologically fine strike grids.
const maxExpiriesToScan = 2;
const otmBandFraction = 0.4;
const maxStrikeCandidatesPerExpiry = 50;

// How far outside the delta band an archived delta may sit and the strike
// still be quoted live — covers the intraday drift since the 10:00 ET capture.
export const archivedDeltaMargin = 0.1;

function pickExpiriesInWindow(expirations: string[], dteMin: number, dteMax: number): string[] {
  const today = new Date();
  return expirations
    .filter((expiry) => {
      const dte = daysBetween(today, parseExpiry(expiry));
      return dte >= dteMin && dte <= dteMax;
    })
    .sort()
    .slice(0, maxExpiriesToScan);
}

/** Covered calls are sold out of the money: strikes above spot, nearest first. */
function pickOutOfTheMoneyCallStrikes(strikes: number[], spotPrice: number): number[] {
  return [...strikes]
    .sort((a, b) => a - b)
    .filter((strike) => strike > spotPrice && strike <= spotPrice * (1 + otmBandFraction))
    .slice(0, maxStrikeCandidatesPerExpiry);
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

/** `${expiryYyyymmdd}|${strike}` → the call delta the 10:00 ET chain capture archived today. Empty when there is no capture for today. */
export type ArchivedCallDeltas = Map<string, number>;

export function archivedCallDeltaKey(expiryYyyymmdd: string, strike: number): string {
  return `${expiryYyyymmdd}|${strike}`;
}

async function loadArchivedCallDeltasForToday(tickerId: string): Promise<ArchivedCallDeltas> {
  const rows: { expiry: string; strike: string; delta: string }[] = await db("option_quote_snapshots as q")
    .join("option_chain_snapshots as s", "s.id", "q.snapshot_id")
    .where({ "s.ticker_id": tickerId, "s.trading_date": easternDateIso(new Date()), "q.option_right": "C" })
    .whereIn("s.status", ["complete", "partial"])
    .whereNotNull("q.delta")
    .select(db.raw("to_char(q.expiry, 'YYYYMMDD') as expiry"), "q.strike", "q.delta");
  return new Map(rows.map((row) => [archivedCallDeltaKey(row.expiry, Number(row.strike)), Number(row.delta)]));
}

/**
 * Trims the strike band to the strikes whose delta, as archived by today's
 * chain capture, can plausibly land in the target band now (approved
 * 2026-09-24) — the far wings were pure line cost. A strike with no archived
 * delta is kept (absence is not evidence); with no archive for today at all,
 * the band is quoted in full.
 */
export function filterStrikesByArchivedCallDelta(expiryStrikes: ExpiryStrikes[], targetWindow: { deltaTargetMin: number; deltaTargetMax: number }, archived: ArchivedCallDeltas): ExpiryStrikes[] {
  if (archived.size === 0) return expiryStrikes;
  const lower = targetWindow.deltaTargetMin - archivedDeltaMargin;
  const upper = targetWindow.deltaTargetMax + archivedDeltaMargin;
  return expiryStrikes
    .map(({ expiry, strikes }) => ({
      expiry,
      strikes: strikes.filter((strike) => {
        const delta = archived.get(archivedCallDeltaKey(expiry, strike));
        if (delta === undefined) return true;
        const magnitude = Math.abs(delta);
        return magnitude >= lower && magnitude <= upper;
      }),
    }))
    .filter(({ strikes }) => strikes.length > 0);
}

/**
 * Covered-call candidates for one ticker inside the covered_call delta/DTE
 * target window, ranked by annualized premium yield (formula approved
 * 2026-08-20): annualizedYield = (premium / spot) × (365 / dte). Drops any
 * expiry that would leave the call open across a known earnings or
 * ex-dividend date (calendarConflict.ts). Strike grids come from the stored
 * chain (the nightly capture), quotes from quoteContracts (pool first).
 * Used by the recovery-path projection, which only needs the top candidate.
 */
export async function scanRecoveryPathCoveredCallCandidates(ib: IBApi, symbol: string, tickerId: string, spotPrice: number, targetWindow: RecoveryTargetWindow): Promise<CoveredCallCandidate[]> {
  const chain = await loadStoredOptionChain(tickerId);
  if (chain.strikesByExpiry.size === 0) {
    console.warn(`${symbol}: option chain not prepared yet (no stored strike grids) — no covered-call candidates.`);
    return [];
  }
  const inWindow: ExpiryStrikes[] = pickExpiriesInWindow(chain.expirations, targetWindow.dteTargetMin, targetWindow.dteTargetMax)
    .map((expiry) => ({ expiry, strikes: pickOutOfTheMoneyCallStrikes(chain.strikesByExpiry.get(expiry) ?? [], spotPrice) }))
    .filter(({ strikes }) => strikes.length > 0);
  const expiryStrikes = filterStrikesByArchivedCallDelta(inWindow, targetWindow, await loadArchivedCallDeltasForToday(tickerId));
  if (expiryStrikes.length === 0) return [];

  const [quotes, calendarContext] = await Promise.all([
    quoteContracts(ib, symbol, expiryStrikes.flatMap(({ expiry, strikes }) => strikes.map((strike) => ({ expiry, strike, right: OptionType.Call })))),
    fetchCalendarConflictContext(tickerId),
  ]);
  return rankCoveredCallCandidates(quotes, targetWindow, spotPrice, (expiryIso) => findCalendarConflict(calendarContext, "covered_call", expiryIso) !== null, !calendarContext.resolved);
}

function rankCoveredCallCandidates(
  quotes: OptionQuote[],
  targetWindow: RecoveryTargetWindow,
  spotPrice: number,
  expiryHasCalendarConflict: (expiryIso: string) => boolean,
  calendarUnverified: boolean,
): CoveredCallCandidate[] {
  const today = new Date();
  const candidates: CoveredCallCandidate[] = [];
  for (const quote of quotes) {
    if (quote.right !== OptionType.Call || quote.delta === null) continue;
    const deltaMagnitude = Math.abs(quote.delta);
    if (deltaMagnitude < targetWindow.deltaTargetMin || deltaMagnitude > targetWindow.deltaTargetMax) continue;

    const premium = quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : quote.last;
    if (premium === null || premium <= 0) continue;

    const dte = daysBetween(today, parseExpiry(quote.expiry));
    if (dte <= 0) continue;
    const expiryIso = toIsoDate(quote.expiry);
    if (expiryHasCalendarConflict(expiryIso)) continue;

    candidates.push({
      expiry: expiryIso,
      strike: quote.strike,
      right: "call",
      delta: quote.delta,
      premium,
      bid: quote.bid,
      ask: quote.ask,
      dte,
      annualizedYield: (premium / spotPrice) * (365 / dte),
      spotPrice,
      calendarUnverified,
    });
  }
  return candidates.sort((a, b) => b.annualizedYield - a.annualizedYield);
}
