import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesPriceOnForward, impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { openCandidateId } from "./candidateIds.js";
import type { BacktestAction, BacktestVolFarmerSettings } from "../backtestTypes.js";
import type { FileIntradayBarPrices } from "../backtestFileStockBars.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestLookSymbol, BacktestOptionSale } from "./backtestLookTypes.js";
import { captureLookTimeEt, lookInstantMs } from "./backtestTickerInputs.js";
import { baselineQuoteRejection, hedgePutCostYield, noteBaselineForwardAnchors, roundedStrike, selectBaselineCandidates, type BaselineCandidate, type BaselineCommissions, type BaselineForwardAnchor, type BaselineRejections } from "./baselineSaleSteps.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buyHedgePut, buyShares, closeCoveredCall, expirySettlementInstant, openCoveredCall, sellHedgePut, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerOpenHedgeLegs, ledgerRealizedPnl } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, type LedgerLeg, type LedgerPosition, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// The Vol Farmer (decision maker "vol_farmer", Marcelo 2026-10-23): shares, a Covered Call on them and a long Put that
// hedges them. At the 10:00 look, per symbol (prices as traded today, S the look's stock price, r the risk-free rate):
//   1. flat (and no unwind today): the Calls (OTM, |delta| and days to expiry in range, spread and volume as the ladder's)
//      in order of premium yield; one Call is sold on every lot (Marcelo 2026-10-23): the first whose strike K some Put
//      passes the hedge rule for and whose volume limit covers every lot, else the one that covers the most; with the
//      Put that offers the most protection among those that pass (a tie: the cheaper). The shares are bought at S with
//      it: lots = floor(free cash × (1 − putCashReservePct ÷ 100) ÷ (100 × S + stock commission + 100 × the Put's fill +
//      one contract's commission)); the cash kept pays for the later Puts, with the Calls' premiums.
//   2. shares held and no Call open (the last one expired below its strike): the next Call the same way, with the Put
//      still held (the Call then expires on or before it), or with a new Put when the last one has expired, bought with
//      all the free cash. Lots the volume or the cash leave without a Call and a Put: their shares are sold at S where it is
//      above what they cost (commission included), with the Puts no Call covers; the rest are kept and tried again at the
//      next 10:00 look.
//   3. Puts held without shares (shares called away at an expiry no bar showed the stock reach): the Puts are sold.
//
//   hedge rule: (K − share cost) + (Pₓ(K) − Put cost − sale commission) + Put P&L realized in the cycle ≥ 0, per share
//     share cost = S plus the stock commission (step 1), or what the cycle's shares cost, commission included (step 2)
//     Put cost   = the Put's fill plus its commission per share (bought now), or its entry with commission (held)
//     Pₓ(x)      = the Put's Black-Scholes value with the stock at x on the Call's expiry day: its own IV (from its mid
//                  now, on the forward S·e^{rT}), forward x·e^{rT'}, T' = (its expiry − the Call's) ÷ 365; its intrinsic
//                  value when it expires that day. Call premiums are left out (Marcelo 2026-10-23).
//   protection = (Pₓ(S × (1 − f)) − Put cost − sale commission) ÷ (S × f), f = protectionFallPct ÷ 100
//   Puts tried = every listed expiry on or after the Call's, from putMinDte to putMaxDte days, every strike up to S × (1 +
//                putMaxStrikeAbovePricePct ÷ 100), with a bid of at least $0.05, an ask above it and the spread within
//                maxSpreadPctOfMid of the mid
//
// The crossing (step 3 of the strategy): the first 30-minute bar after the Call's sale whose high reaches K. The whole
// position is unwound in that bar, at "perfect limit orders" (Marcelo 2026-10-23): the shares sold at K (at the bar's
// open when it opened at or above K: the stock gapped past it), the Call bought back and the Put sold at their
// Black-Scholes values at that price, each on its IV from its last quote at a look, T to its expiry's 16:00 ET from the
// bar's middle (its start on a gap); commissions as every fill's, no spread. The next cycle starts at the next day's
// 10:00 look. Bars are scanned before each look and, after the day's last look, to the close: an expiry's settlement
// (the next morning) never comes before a crossing on its day.
// Sales and purchases at the 10:00 look fill at the session's fill rule; Puts are held to their expiry (no roll), where
// the session settles them at their intrinsic value. A cycle that spans a split whose contracts do not fit its share scale
// opens no option until it ends.
//
// Research settings (2026-10-24; the defaults keep all of the above):
//   crossing "hold_to_expiry"    no crossing scan: a Call in the money at its expiry is assigned by the session's settlement
//                                (its shares go at K) and step 3 sells the Put left without shares
//   putExpiry "with_the_call"    Puts tried = the listed Puts expiring on the Call's own expiry (the days-to-expiry range
//                                is not read), so each Put settles with its Call
//   hedgeRuleCallPremiums        "included": the cycle's realized Call P&L (option legs of its Covered Call positions) is
//                                added to the Puts' realized P&L in the hedge rule
//   minPutProtectionPct > 0      a Put passes only with protection ≥ minPutProtectionPct ÷ 100
//   hedgeWithoutCall "put"       shares held with no Put and no Call sold at the look: the Put at the highest strike up to
//                                S × (1 + putMaxStrikeAbovePricePct ÷ 100) of the nearest expiry 7 or more days out, on as
//                                many lots as held and the free cash pays for
//   hedgeWithoutCall             the same moment (above all, once the Put has expired): the Put putChoice takes among the
//     "cheapest_per_year"        Puts tried, with no hedge rule and protection measured to the next listed Call expiry
//   putChoice "cheapest_per_year"  of the Puts that pass the hedge rule and minPutProtectionPct, the lowest yearly cost
//                                (time value × 100 + commission) ÷ (S × 100) ÷ (days ÷ 365) (a tie: the more protection),
//                                instead of the most protection; minPutProtectionPct applies to rule 3's rolls too
//   maxPutCostPctOfCallPremium   > 0: a Put passes only when its fill ≤ the Call's fill × this ÷ 100 (100 = a zero-cost collar)
//   putRoll "when_no_call"        step 2 with Puts held and no Call that passes with them: selling them at the fill rule
//                                would realize (fill − entry) × 100 × contracts − commission; with that added to the
//                                cycle's realized P&L and the sale's cash free, step 2's choice of a Call with a new Put
//                                runs; when it finds one, the Puts are sold, the Call sold and the new Put bought (a roll)
//   callExpiry "next"             Calls tried = those of the next listed expiry after today (the days-to-expiry range is
//                                not read); a day none passes sells no Call, and the next 10:00 look tries again
//   crossing                      "unwind_if_net_positive": at the crossing, the cycle's net = its realized P&L (shares,
//     "unwind_if_net_positive"   Calls and Puts of the positions opened since it began, commissions included) + every open
//                                leg closed at the unwind's prices − their closing commissions; above 0 the position is
//                                unwound as above, else it is held and the same net, at each later look's fills (the
//                                session's fill rule; a look without a quote for every leg is skipped), is checked at
//                                every look to the Call's expiry, the position unwound at those fills at the first above 0
//   hedgeAfterExpiry              "sell_if_in_profit": step 2 after a Call expired below its strike, with Puts held whose
//     "sell_if_in_profit"        sale at the fill rule would realize a gain: the roll above (putRoll), tried first; when
//                                no Call passes with a new Put, the Call is chosen with the Puts held as usual
//   afterAssignment               "continue_if_under_water": step 3 after shares were called away: Rs + Rh + the Puts' sale
//     "continue_if_under_water"  at the fill rule ((fill − entry) × 100 × contracts − commission), Rs and Rh the cycle's
//                                realized share and Put P&L (Calls left out); above 0 the Puts are sold (the cycle ends),
//                                else the shares called away are bought back at S (the lots the free cash pays for; none:
//                                the Puts are sold), the Puts kept, and step 2 runs on them in the same look
//   hedgeRuleStockPnl "included"  the cycle's realized share P&L (shares called away or sold) is added to the Puts'
//                                realized P&L in the hedge rule
//   putCashIn "when_no_call"      step 2 with Puts held and no Call sold at the look (the rolls above tried first): each Put
//                                whose sale at the fill rule would realize (fill − entry) × 100 × contracts − commission
//                                > 0 is sold, so the gain is in the cycle's realized Put P&L the hedge rule reads from the
//                                next look; the lots left without a Put get the hedgeWithoutCall Put at the same look, with
//                                "cheapest_per_year" the one offering at least cashInPutMinProtectionPct ÷ 100 (0 = any)
//   hedge "none"                  no Put is ever bought (the Put settings above are not read): steps 1 and 2 take the
//                                Calls by premium yield, the first whose strike passes the hedge rule on the shares alone,
//                                (K − share cost) + the realized P&L it counts ≥ 0, and whose volume covers every lot; a new
//                                cycle's lots = floor(free cash × (1 − putCashReservePct ÷ 100) ÷ (100 × S + stock commission))

/** The flat rates the ledger charges (ledgerFills.ts), for ranking the Calls. */
const volFarmerCommissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const millisecondsPerYear = 365 * 86_400_000;
const barMinutes = 30;

interface VolFarmerSymbolState {
  /** The implied volatility of each open option leg, from its last quote at a look (or its fill). */
  impliedVolatilityByLegId: Map<string, number>;
  /** Bars are scanned for the crossing through this instant. */
  scannedThroughMs: number;
  /** The day of the last unwind: no new cycle opens on it. */
  unwoundOn: string | null;
  /** When the open cycle began: the hedge positions opened since are the cycle's. */
  cycleStartedAt: Date | null;
  /** The open Call held past its crossing (crossing "unwind_if_net_positive"): checked at every look, never at a bar again. */
  heldCallLegId: string | null;
  /** The cash check (describeVolFarmerCash). */
  cash: { laterPutPurchases: number; shortPurchases: number; firstShort: { dateIso: string; lotsPaid: number; lotsHeld: number } | null; lowestFreeCash: number | null; callSales: number; callSalesShortOfVolume: number };
}

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, VolFarmerSymbolState>>();

function stateOf(ledger: SimulatedLedger, symbol: string): VolFarmerSymbolState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  let state = bySymbol.get(symbol);
  if (!state) bySymbol.set(symbol, (state = { impliedVolatilityByLegId: new Map(), scannedThroughMs: 0, unwoundOn: null, cycleStartedAt: null, heldCallLegId: null, cash: { laterPutPurchases: 0, shortPurchases: 0, firstShort: null, lowestFreeCash: null, callSales: 0, callSalesShortOfVolume: 0 } }));
  return state;
}

/** Black-Scholes value of an option with the stock at `stockPrice`, `yearsToExpiry` left, on the forward S·e^{rT}, never below its intrinsic value (the listed options are American); its intrinsic value at or past expiry. */
export function volFarmerOptionValue(input: { isCall: boolean; stockPrice: number; strike: number; yearsToExpiry: number; riskFreeRate: number; impliedVolatility: number }): number {
  const intrinsic = input.isCall ? Math.max(0, input.stockPrice - input.strike) : Math.max(0, input.strike - input.stockPrice);
  if (input.yearsToExpiry <= 0) return intrinsic;
  const forward = input.stockPrice * Math.exp(input.riskFreeRate * input.yearsToExpiry);
  return Math.max(intrinsic, blackScholesPriceOnForward(forward, input.strike, input.yearsToExpiry, input.riskFreeRate, input.impliedVolatility, input.isCall));
}

/** One Put as the hedge rule reads it, per share and as traded today. */
export interface VolFarmerPutTerms {
  strike: number;
  /** Its fill (or entry) plus the opening commission per share. */
  costPerShare: number;
  impliedVolatility: number;
  /** Years from the Call's expiry to the Put's (0 when they expire together). */
  yearsLeftAtCallExpiry: number;
}

/** What the shares and the Put make, per share, if the stock reaches the Call's strike on its expiry day: the hedge rule passes at 0 or above. */
export function volFarmerHedgeSurplus(input: { callStrike: number; shareCostPerShare: number; put: VolFarmerPutTerms; realizedHedgePnlPerShare: number; riskFreeRate: number }): number {
  const { put } = input;
  const putValueAtStrike = volFarmerOptionValue({ isCall: false, stockPrice: input.callStrike, strike: put.strike, yearsToExpiry: put.yearsLeftAtCallExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: put.impliedVolatility });
  return input.callStrike - input.shareCostPerShare + (putValueAtStrike - put.costPerShare - putSaleCommissionPerShare) + input.realizedHedgePnlPerShare;
}

/** The share of the shares' loss on a fall of `fallFraction` by the Call's expiry that the Put's gain after its cost offsets. */
export function volFarmerProtection(input: { stockPrice: number; fallFraction: number; put: VolFarmerPutTerms; riskFreeRate: number }): number {
  const { put } = input;
  const fallenPrice = input.stockPrice * (1 - input.fallFraction);
  const putValueAfterFall = volFarmerOptionValue({ isCall: false, stockPrice: fallenPrice, strike: put.strike, yearsToExpiry: put.yearsLeftAtCallExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: put.impliedVolatility });
  return (putValueAfterFall - put.costPerShare - putSaleCommissionPerShare) / (input.stockPrice * input.fallFraction);
}

const putSaleCommissionPerShare = optionCommissionDollars(1) / sharesPerContract;

/** A Put the look may buy. */
export interface VolFarmerPutCandidate {
  expiry: string;
  /** Calendar days from today to its expiry. */
  dte: number;
  /** The trading sessions from today's to its expiry's: what its yearly cost is annualized over. */
  sessionsHeld: number;
  strike: number;
  bid: number;
  ask: number;
  fillPrice: number;
  impliedVolatility: number;
}

/** A hedge Put's yearly cost (hedgePutCostYield) at its fill: the putChoice "cheapest_per_year" order. */
export const volFarmerPutCostPerYear = (put: VolFarmerPutCandidate, stockPrice: number) => hedgePutCostYield({ fillPrice: put.fillPrice, strike: put.strike, stockPrice, sessionsHeld: put.sessionsHeld, commissionDollarsPerContract: optionCommissionDollars(1) }) ?? 0;

/**
 * Of the Puts expiring on or after the Call, those that pass the hedge rule (with a Call) and offer the least protection
 * asked for; of them, the most protection (a tie: the cheaper), or with putChoice "cheapest_per_year" the lowest yearly
 * cost (a tie: the more protection). Null when none passes.
 */
export function chooseVolFarmerPut(input: {
  puts: readonly VolFarmerPutCandidate[];
  /** Null with no Call (hedgeWithoutCall "cheapest_per_year"): no hedge rule. */
  callStrike: number | null;
  /** The day protection is measured at: the Call's expiry, or with no Call the next listed Call expiry. */
  callExpiry: string;
  shareCostPerShare: number;
  realizedHedgePnlPerShare: number;
  stockPrice: number;
  fallFraction: number;
  riskFreeRate: number;
  /** Only Puts expiring with the Call (putExpiry "with_the_call"). */
  sameExpiry?: boolean;
  /** The least protection a Put may offer (minPutProtectionPct ÷ 100); 0 or missing = any. */
  minProtection?: number;
  /** The most a Put's fill may be, per share (maxPutCostPctOfCallPremium of the Call's fill); missing = no limit. */
  maxFillPrice?: number;
  /** "most_protection" when missing. */
  choice?: BacktestVolFarmerSettings["putChoice"];
}): { put: VolFarmerPutCandidate; surplus: number | null; protection: number } | null {
  let best: { put: VolFarmerPutCandidate; surplus: number | null; protection: number; costPerShare: number; costPerYear: number } | null = null;
  for (const put of input.puts) {
    if (put.expiry < input.callExpiry || (input.sameExpiry && put.expiry !== input.callExpiry) || (input.maxFillPrice !== undefined && put.fillPrice > input.maxFillPrice + 1e-9)) continue;
    const terms: VolFarmerPutTerms = { strike: put.strike, costPerShare: put.fillPrice + putSaleCommissionPerShare, impliedVolatility: put.impliedVolatility, yearsLeftAtCallExpiry: yearsBetweenExpiries(input.callExpiry, put.expiry) };
    const surplus = input.callStrike === null ? null : volFarmerHedgeSurplus({ callStrike: input.callStrike, shareCostPerShare: input.shareCostPerShare, put: terms, realizedHedgePnlPerShare: input.realizedHedgePnlPerShare, riskFreeRate: input.riskFreeRate });
    if (surplus !== null && surplus < 0) continue;
    const protection = volFarmerProtection({ stockPrice: input.stockPrice, fallFraction: input.fallFraction, put: terms, riskFreeRate: input.riskFreeRate });
    if ((input.minProtection ?? 0) > 0 && protection < input.minProtection! - 1e-12) continue;
    const costPerYear = input.choice === "cheapest_per_year" ? volFarmerPutCostPerYear(put, input.stockPrice) : 0;
    const better =
      best === null ||
      (input.choice === "cheapest_per_year"
        ? costPerYear < best.costPerYear - 1e-12 || (Math.abs(costPerYear - best.costPerYear) <= 1e-12 && protection > best.protection + 1e-12)
        : protection > best.protection + 1e-12 || (Math.abs(protection - best.protection) <= 1e-12 && terms.costPerShare < best.costPerShare));
    if (better) best = { put, surplus, protection, costPerShare: terms.costPerShare, costPerYear };
  }
  return best === null ? null : { put: best.put, surplus: best.surplus, protection: best.protection };
}

/** The first 30-minute bar whose high reaches the strike, and the price and instant of the crossing in it; null when none does. */
export function findVolFarmerCrossing(bars: readonly FileIntradayBarPrices[], strike: number): { bar: FileIntradayBarPrices; price: number; minutesEt: number; gapped: boolean } | null {
  for (const bar of bars) {
    if (bar.high < strike - 1e-9) continue;
    const gapped = bar.open >= strike - 1e-9;
    return { bar, price: gapped ? bar.open : strike, minutesEt: gapped ? bar.startMinutesEt : bar.startMinutesEt + barMinutes / 2, gapped };
  }
  return null;
}

const yearsBetweenExpiries = (fromExpiry: string, toExpiry: string) => Math.max(0, expirySettlementInstant(toExpiry).getTime() - expirySettlementInstant(fromExpiry).getTime()) / millisecondsPerYear;
const yearsToExpiryFrom = (atMs: number, expiry: string) => Math.max(0, expirySettlementInstant(expiry).getTime() - atMs) / millisecondsPerYear;
const clockTime = (minutesOfDay: number) => `${String(Math.floor(minutesOfDay / 60)).padStart(2, "0")}:${String(minutesOfDay % 60).padStart(2, "0")}`;
const percent = (fraction: number) => `${(fraction * 100).toFixed(0)}%`;

function openLegsOfSymbol(ledger: SimulatedLedger, symbol: string): LedgerLeg[] {
  return positionsOfSymbol(ledger, symbol)
    .filter((position) => position.status === "open")
    .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null));
}

const isShortCall = (leg: LedgerLeg) => leg.legType === "option" && leg.optionType === "call" && leg.side === "short";
const isStock = (leg: LedgerLeg) => leg.legType === "stock" && leg.side === "long";

/** The positions of the symbol's open cycle: those opened since it began; none before a cycle has begun. */
function cyclePositionsOf(ledger: SimulatedLedger, symbol: string, cycleStartedAt: Date | null): LedgerPosition[] {
  return cycleStartedAt === null ? [] : positionsOfSymbol(ledger, symbol).filter((position) => position.openedAt >= cycleStartedAt);
}

/** P&L by source: the shares, the Calls (Covered Calls' option legs) and the Puts (hedge legs). */
export interface VolFarmerPnlBySource {
  shares: number;
  calls: number;
  puts: number;
}

/** The cycle's realized P&L so far by source, commissions included (the shares sold or called away, the Calls and Puts closed). */
function cycleRealizedBySource(ledger: SimulatedLedger, cyclePositions: readonly LedgerPosition[]): VolFarmerPnlBySource {
  const realized: VolFarmerPnlBySource = { shares: 0, calls: 0, puts: 0 };
  for (const position of cyclePositions) {
    const pnl = ledgerRealizedPnl(ledger, position.id);
    realized.shares += pnl.stock;
    if (position.strategyKey === "hedge") realized.puts += pnl.premium;
    else realized.calls += pnl.premium;
  }
  return realized;
}

/**
 * The crossing rule "unwind_if_net_positive" (above): the cycle's realized P&L plus every open leg of the symbol closed at
 * `closePriceOf` (per share, as traded today), less their closing commissions, by source and in total: what the cycle
 * would have made once unwound there. Null when a leg has no price.
 */
export function volFarmerCycleNet(input: { ledger: SimulatedLedger; symbol: string; cycleStartedAt: Date | null; priceToCycleScale: number; closePriceOf: (leg: LedgerLeg) => number | null }): (VolFarmerPnlBySource & { total: number }) | null {
  const { ledger, symbol, priceToCycleScale } = input;
  const net = cycleRealizedBySource(ledger, cyclePositionsOf(ledger, symbol, input.cycleStartedAt));
  for (const leg of openLegsOfSymbol(ledger, symbol)) {
    const closePrice = input.closePriceOf(leg);
    if (closePrice === null) return null;
    const closingCommission = leg.legType === "stock" ? stockCommissionDollars(leg.quantity * priceToCycleScale) : optionCommissionDollars(leg.quantity);
    const pnl = (closePrice * priceToCycleScale - leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1) - closingCommission;
    if (leg.legType === "stock") net.shares += pnl;
    else if (leg.optionType === "call") net.calls += pnl;
    else net.puts += pnl;
  }
  return { ...net, total: net.shares + net.calls + net.puts };
}

const describeCycleNet = (net: VolFarmerPnlBySource & { total: number }) => `${formatWholeDollars(net.total, true)} (shares ${formatWholeDollars(net.shares, true)}, Calls ${formatWholeDollars(net.calls, true)}, Puts ${formatWholeDollars(net.puts, true)})`;

/** The cycle's Covered Calls that closed last (at one instant: an expiry's settlement or an unwind); empty when none has closed. */
function lastClosedCoveredCalls(cyclePositions: readonly LedgerPosition[]): LedgerPosition[] {
  const closed = cyclePositions.filter((position) => position.strategyKey === "covered_call" && position.closedAt !== null);
  const lastClosedMs = Math.max(...closed.map((position) => position.closedAt!.getTime()));
  return closed.filter((position) => position.closedAt!.getTime() === lastClosedMs);
}

/** The IV of an open option leg from a look's quote of it (its mid, forward S·e^{rT}); null without a two-sided quote or an IV. */
function impliedVolatilityOfQuote(quote: SymbolFileQuote | undefined, stockPrice: number, atMs: number, riskFreeRate: number): number | null {
  if (!quote || quote.bid === null || quote.ask === null || !(quote.ask >= quote.bid) || !(quote.ask > 0)) return null;
  const yearsToExpiry = yearsToExpiryFrom(atMs, quote.expiry);
  if (yearsToExpiry <= 0) return null;
  const mid = (quote.bid + quote.ask) / 2;
  return impliedVolatilityFromPrice(mid, stockPrice * Math.exp(riskFreeRate * yearsToExpiry), quote.strike, yearsToExpiry, riskFreeRate, quote.right === "C");
}

/**
 * Re-reads the IV of the symbol's open Call and Puts from a look's quotes: what a crossing before the next look prices
 * them on. A leg the look does not quote keeps its last IV.
 */
function refreshImpliedVolatilities(ledger: SimulatedLedger, lookSymbol: BacktestLookSymbol, atMs: number, priceToCycleScale: number): void {
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
  const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  for (const leg of openLegsOfSymbol(ledger, symbol)) {
    if (leg.legType !== "option") continue;
    const right = leg.optionType === "call" ? "C" : "P";
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const matches = (quote: SymbolFileQuote) => quote.expiry === leg.expiryDate && quote.right === right && roundedStrike(quote.strike) === strike;
    const quote = quotes.find(matches) ?? (right === "P" ? lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find(matches) : undefined);
    const impliedVolatility = impliedVolatilityOfQuote(quote, stockPrice, atMs, riskFreeRate);
    if (impliedVolatility !== null) state.impliedVolatilityByLegId.set(leg.id, impliedVolatility);
  }
}

export interface VolFarmerCrossingScan {
  ledger: SimulatedLedger;
  symbol: string;
  todayIso: string;
  /** Today's 30-minute bars on IBKR's split-adjusted scale. */
  adjustedBars: readonly FileIntradayBarPrices[];
  splitFactorToday: number;
  /** Bars ending by this time ("HH:MM" ET) are scanned. */
  throughEt: string;
  riskFreeRate: number;
  priceByLegId: Map<string, number>;
  nextActionId(): string;
  /** Crossing "unwind_if_net_positive": unwound only when the cycle's net at the unwind's prices is above 0, else the Call is held. */
  onlyIfCycleNetPositive?: boolean;
}

/** Unwinds the symbol's position at the first crossing of its open Call's strike in today's bars up to `throughEt`; the actions and a summary (null when nothing happened). */
export function scanVolFarmerCrossing(scan: VolFarmerCrossingScan): { actions: BacktestAction[]; summary: string; lookTimeEt: string } | null {
  const { ledger, symbol, todayIso } = scan;
  const state = stateOf(ledger, symbol);
  const throughMs = lookInstantMs(todayIso, scan.throughEt);
  const scannedFromMs = state.scannedThroughMs;
  state.scannedThroughMs = Math.max(state.scannedThroughMs, throughMs);
  const openLegs = openLegsOfSymbol(ledger, symbol);
  const callLeg = openLegs.find(isShortCall);
  if (!callLeg || callLeg.id === state.heldCallLegId) return null;
  const priceToCycleScale = cycleSplitFactorFor(ledger, symbol, scan.splitFactorToday) / scan.splitFactorToday;
  const strikeToday = callLeg.strikePrice! / priceToCycleScale;
  const fromMs = Math.max(scannedFromMs, callLeg.entryAt.getTime());
  const bars = scan.adjustedBars
    .map((bar) => ({ startMinutesEt: bar.startMinutesEt, open: bar.open * scan.splitFactorToday, high: bar.high * scan.splitFactorToday, close: bar.close * scan.splitFactorToday }))
    .filter((bar) => {
      const startMs = lookInstantMs(todayIso, clockTime(bar.startMinutesEt));
      return startMs >= fromMs && startMs + barMinutes * 60_000 <= throughMs;
    });
  const crossing = findVolFarmerCrossing(bars, strikeToday);
  if (crossing === null) return null;

  const crossingEt = clockTime(crossing.minutesEt);
  const at = new Date(lookInstantMs(todayIso, crossingEt));
  const stockPrice = crossing.price;
  const modelValueOf = (leg: LedgerLeg) => {
    const impliedVolatility = state.impliedVolatilityByLegId.get(leg.id);
    if (impliedVolatility === undefined) throw new Error(`${symbol}: the Vol Farmer has no implied volatility for leg ${leg.id} to price it at the crossing.`);
    return volFarmerOptionValue({ isCall: leg.optionType === "call", stockPrice, strike: leg.strikePrice! / priceToCycleScale, yearsToExpiry: yearsToExpiryFrom(at.getTime(), leg.expiryDate!), riskFreeRate: scan.riskFreeRate, impliedVolatility });
  };
  const howReached = crossing.gapped ? `opened at ${stockPrice.toFixed(2)}, past the strike` : `reached ${strikeToday.toFixed(2)}`;
  const barNote = `in the ${clockTime(crossing.bar.startMinutesEt)} bar`;
  if (scan.onlyIfCycleNetPositive) {
    const net = volFarmerCycleNet({ ledger, symbol, cycleStartedAt: state.cycleStartedAt, priceToCycleScale, closePriceOf: (leg) => (leg.legType === "stock" ? stockPrice : modelValueOf(leg)) })!;
    if (!(net.total > 0)) {
      state.heldCallLegId = callLeg.id;
      return { actions: [], summary: `Held at the crossing: ${symbol} ${howReached} ${barNote}; unwinding there would net the cycle ${describeCycleNet(net)}, so the position is held and checked at every look to the Call's expiry`, lookTimeEt: crossingEt };
    }
  }
  const { actions, summaries } = unwindVolFarmerPosition({ ledger, symbol, todayIso, at, lookTimeEt: crossingEt, priceToCycleScale, callLeg, stockPrice, optionPriceOf: modelValueOf, why: `the stock ${howReached} ${barNote}`, callScores: { gapped: crossing.gapped ? 1 : 0 }, nextActionId: scan.nextActionId });
  return { actions, summary: `Unwound at the crossing: ${summaries.join(" · ")}`, lookTimeEt: crossingEt };
}

/**
 * Closes the symbol's whole position at `at`, at the prices given (per share, as traded today): the Covered Call (the
 * Call bought back and its shares sold), the shares no Call covers and the Puts. The cycle ends; the next starts at the
 * next day's 10:00 look.
 */
function unwindVolFarmerPosition(input: {
  ledger: SimulatedLedger;
  symbol: string;
  todayIso: string;
  at: Date;
  lookTimeEt: string;
  priceToCycleScale: number;
  callLeg: LedgerLeg;
  stockPrice: number;
  optionPriceOf: (leg: LedgerLeg) => number;
  /** Why, in the Call's description: "the stock reached 103.00 in the 10:30 bar". */
  why: string;
  chosenBecause?: string;
  /** The Call's action scores beside its prices. */
  callScores: Record<string, number | null>;
  nextActionId(): string;
}): { actions: BacktestAction[]; summaries: string[] } {
  const { ledger, symbol, todayIso, at, lookTimeEt, priceToCycleScale, callLeg, stockPrice, chosenBecause } = input;
  const state = stateOf(ledger, symbol);
  const actionId = input.nextActionId();
  const summaries: string[] = [];
  const actions: BacktestAction[] = [];
  const strikeToday = callLeg.strikePrice! / priceToCycleScale;
  const callContract = describeOptionContract({ strike: strikeToday, right: "C", expiry: callLeg.expiryDate!, dte: daysToExpiry(callLeg.expiryDate!, todayIso) });

  // The Covered Call: the Call bought back and its shares sold.
  const callBuyback = input.optionPriceOf(callLeg);
  const callPositionId = callLeg.positionId;
  const callPremiumToday = callLeg.entryPrice / priceToCycleScale;
  const callContracts = callLeg.quantity;
  closeCoveredCall(ledger, { positionId: callPositionId, callFillPrice: callBuyback * priceToCycleScale, stockFillPrice: stockPrice * priceToCycleScale, at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
  const coveredShares = Math.round(callContracts * callLeg.multiplier * priceToCycleScale);
  const callDescription = `${symbol} Buy back ${callContract}${describeOrderSize(callContracts, callBuyback)} and sell ${coveredShares} shares @ ${stockPrice.toFixed(2)} (${input.why}; sold at ${callPremiumToday.toFixed(2)}, Call ${callBuyback <= callPremiumToday ? "gain" : "loss"} ${formatWholeDollars(Math.abs(callPremiumToday - callBuyback) * callContracts * sharesPerContract)})`;
  actions.push(crossingAction({ actionId, symbol, todayIso, at, lookTimeEt, kind: "close_position", description: callDescription, contract: { strategyKey: "covered_call", expiry: callLeg.expiryDate!, strike: strikeToday, right: "C" }, quantity: callContracts, fillPrice: callBuyback, positionIds: [callPositionId], chosenBecause, scores: { stockPrice, callStrike: strikeToday, callBuyback, callPremium: callPremiumToday, impliedVolatility: state.impliedVolatilityByLegId.get(callLeg.id) ?? null, ...input.callScores } }));
  summaries.push(callDescription);

  // Shares no Call covered.
  for (const leg of openLegsOfSymbol(ledger, symbol).filter(isStock)) {
    const sharesActionId = input.nextActionId();
    sellShares(ledger, { positionId: leg.positionId, shares: leg.quantity, fillPrice: stockPrice * priceToCycleScale, at, actionId: sharesActionId, tradedSharesPerLedgerShare: priceToCycleScale });
    const sharesToday = Math.round(leg.quantity * priceToCycleScale);
    const description = `${symbol} Sell ${sharesToday} uncovered shares @ ${stockPrice.toFixed(2)} (unwound with the Covered Call)`;
    actions.push(crossingAction({ actionId: sharesActionId, symbol, todayIso, at, lookTimeEt, kind: "close_shares", description, contract: null, quantity: sharesToday, fillPrice: stockPrice, positionIds: [leg.positionId], chosenBecause, scores: { stockPrice } }));
    summaries.push(description);
  }

  // The Puts.
  for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
    const putActionId = input.nextActionId();
    const putValue = input.optionPriceOf(leg);
    const positionId = leg.positionId;
    const entryToday = leg.entryPrice / priceToCycleScale;
    const contracts = leg.quantity;
    sellHedgePut(ledger, { legId: leg.id, contracts, fillPrice: putValue * priceToCycleScale, at, actionId: putActionId });
    const realized = (putValue - entryToday) * contracts * sharesPerContract - optionCommissionDollars(contracts);
    const putContract = describeOptionContract({ strike: roundedStrike(leg.strikePrice! / priceToCycleScale), right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) });
    const description = `${symbol} Sell ${putContract}${describeOrderSize(contracts, putValue)} (hedge, unwound with the Covered Call; bought at ${entryToday.toFixed(2)} with its commission, ${realized >= 0 ? "gain" : "loss"} ${formatWholeDollars(Math.abs(realized))})`;
    actions.push(crossingAction({ actionId: putActionId, symbol, todayIso, at, lookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike: roundedStrike(leg.strikePrice! / priceToCycleScale), right: "P" }, quantity: contracts, fillPrice: putValue, positionIds: [positionId], chosenBecause, scores: { stockPrice, entryPrice: entryToday, realizedPnlDollars: realized, impliedVolatility: state.impliedVolatilityByLegId.get(leg.id) ?? null } }));
    summaries.push(description);
  }
  for (const leg of ledger.legs) if (leg.exitAt !== null) state.impliedVolatilityByLegId.delete(leg.id);
  state.unwoundOn = todayIso;
  state.cycleStartedAt = null;
  state.heldCallLegId = null;
  return { actions, summaries };
}

/**
 * Crossing "unwind_if_net_positive", a Call held past its crossing: at each look to its expiry, the cycle's net with every
 * leg closed at the look's fills (the shares at its price, the Call bought back and the Puts sold at the session's fill
 * rule); above 0, the position is unwound at those fills. Returns the unwind's summary; null when nothing was traded
 * (the net at or below 0, or a leg without a quote at this look).
 */
function recheckHeldCall(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; lookTimeEt: string; at: Date; priceToCycleScale: number; actions: BacktestAction[] }): string | null {
  const { context, lookSymbol, lookTimeEt, at, priceToCycleScale } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  if (state.heldCallLegId === null) return null;
  const openLegs = openLegsOfSymbol(ledger, symbol);
  const callLeg = openLegs.find((leg) => leg.id === state.heldCallLegId);
  if (!callLeg) {
    state.heldCallLegId = null;
    return null;
  }
  const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
  const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;
  const fillByLegId = new Map<string, number>();
  for (const leg of openLegs) {
    if (leg.legType !== "option") continue;
    const right = leg.optionType === "call" ? "C" : "P";
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const matches = (quote: SymbolFileQuote) => quote.expiry === leg.expiryDate && quote.right === right && roundedStrike(quote.strike) === strike;
    const quote = quotes.find(matches) ?? (right === "P" ? lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find(matches) : undefined);
    if (!quote || quote.ask === null || !(quote.ask > 0)) return null;
    fillByLegId.set(leg.id, leg.side === "short" ? optionPurchaseFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged) : optionSaleFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged));
  }
  const net = volFarmerCycleNet({ ledger, symbol, cycleStartedAt: state.cycleStartedAt, priceToCycleScale, closePriceOf: (leg) => (leg.legType === "stock" ? stockPrice : (fillByLegId.get(leg.id) ?? null)) });
  if (net === null || !(net.total > 0)) return null;
  const { actions, summaries } = unwindVolFarmerPosition({
    ledger,
    symbol,
    todayIso,
    at,
    lookTimeEt,
    priceToCycleScale,
    callLeg,
    stockPrice,
    optionPriceOf: (leg) => fillByLegId.get(leg.id)!,
    why: `held past its crossing; unwinding at the ${lookTimeEt} look nets the cycle ${describeCycleNet(net)}`,
    chosenBecause: "vol farmer: held past the crossing; unwinding the whole position at this look's fills nets the cycle a gain",
    callScores: { cycleNetDollars: net.total },
    nextActionId: context.nextActionId,
  });
  input.actions.push(...actions);
  return `Unwound at the ${lookTimeEt} look: ${summaries.join(" · ")}`;
}

function crossingAction(input: {
  /** The candidate id's kind: "vol_farmer_unwind" for a crossing's orders (the cycle detail finds crossings by it), "vol_farmer_sale" for the other sales. */
  candidateKind?: "vol_farmer_unwind" | "vol_farmer_sale";
  actionId: string;
  symbol: string;
  todayIso: string;
  at: Date;
  lookTimeEt: string;
  kind: "close_position" | "close_shares" | "sell_hedge" | "buy_shares";
  description: string;
  contract: BacktestAction["contract"];
  quantity: number;
  fillPrice: number;
  positionIds: string[];
  /** Absent: a crossing's unwind. */
  chosenBecause?: string | undefined;
  scores: Record<string, number | null>;
}): BacktestAction {
  return {
    actionId: input.actionId,
    tradingDate: input.todayIso,
    at: input.at.toISOString(),
    lookTimeEt: input.lookTimeEt,
    passNumber: 1,
    symbol: input.symbol,
    kind: input.kind,
    candidateId: `${input.symbol}:${input.candidateKind ?? "vol_farmer_unwind"}:${input.positionIds[0]}`,
    description: input.description,
    automatic: true,
    chosenBecause: input.chosenBecause ?? "vol farmer: the stock reached the Call's strike; the whole position is unwound at Black-Scholes values (perfect limit orders)",
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer", ok: true, detail: "crossing" }],
    contract: input.contract,
    candidateScores: input.scores,
    quantity: input.quantity,
    limitPrice: input.fillPrice,
    fillPrice: input.fillPrice,
    positionIds: input.positionIds,
  };
}

/** The Vol Farmer's look: every look re-reads the open legs' IVs; the 10:00 look opens (steps 1–3 above). */
export async function runVolFarmerLook(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const farmer = settings.volFarmer;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const atMs = lookInstantMs(todayIso, lookTimeEt);
  const at = new Date(atMs);
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];

  for (const lookSymbol of context.symbols) {
    const symbol = lookSymbol.profile.symbol;
    const cycleSplitFactor = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at);
    const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
    refreshImpliedVolatilities(ledger, lookSymbol, atMs, priceToCycleScale);
    if (farmer.crossing === "unwind_if_net_positive") {
      const unwound = recheckHeldCall({ context, lookSymbol, lookTimeEt, at, priceToCycleScale, actions });
      if (unwound !== null) summaries.push(unwound);
    }
    if (lookTimeEt !== captureLookTimeEt) continue;
    const opened = openSymbol({ context, lookSymbol, farmer, at, priceToCycleScale, actions, optionSales });
    if (opened !== null) summaries.push(opened);
    const cash = stateOf(ledger, symbol).cash;
    cash.lowestFreeCash = Math.min(cash.lowestFreeCash ?? Number.POSITIVE_INFINITY, ledgerFreeCash(ledger));
  }

  const summary = summaries.length === 0 ? "No action" : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [] };
}

function openSymbol(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; farmer: BacktestVolFarmerSettings; at: Date; priceToCycleScale: number; actions: BacktestAction[]; optionSales: BacktestOptionSale[] }): string | null {
  const { context, lookSymbol, farmer, at, priceToCycleScale } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const lookTimeEt = captureLookTimeEt;
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const toCyclePrice = (price: number) => price * priceToCycleScale;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const openLegs = openLegsOfSymbol(ledger, symbol);
  const stockLegs = openLegs.filter(isStock);
  const hedgeLegs = ledgerOpenHedgeLegs(ledger, symbol);
  const sharesHeldToday = stockLegs.reduce((sum, leg) => sum + leg.quantity * priceToCycleScale, 0);

  // 3. Puts left without shares.
  if (sharesHeldToday === 0 && hedgeLegs.length > 0) {
    let endNote = "";
    if (farmer.afterAssignment === "continue_if_under_water") {
      const continued = continueAfterAssignment({ ...input, hedgeLegs });
      if (continued.summary !== null) return continued.summary;
      endNote = continued.endNote;
    }
    const sold: string[] = [];
    for (const leg of hedgeLegs) {
      const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
      const quote = lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find((candidate) => candidate.right === "P" && roundedStrike(candidate.strike) === strike);
      if (!quote || quote.ask === null || !(quote.ask > 0)) continue;
      const fill = optionSaleFillPrice(quote.bid ?? 0, quote.ask, context.settings.trading.spreadCostChargedPct / 100);
      const actionId = context.nextActionId();
      const positionId = leg.positionId;
      sellHedgePut(ledger, { legId: leg.id, contracts: leg.quantity, fillPrice: toCyclePrice(fill), at, actionId });
      const description = `${symbol} Sell ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}${describeOrderSize(leg.quantity, fill)} (hedge with no shares left)`;
      input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" }, quantity: leg.quantity, fillPrice: fill, positionIds: [positionId], scores: { bid: quote.bid, ask: quote.ask, stockPrice } }), automatic: false, chosenBecause: "vol farmer: the shares left at an expiry, so the hedge goes too" });
      sold.push(description);
    }
    if (sold.length > 0) state.unwoundOn = todayIso;
    return sold.length > 0 ? `${sold.join(" · ")}${endNote}` : `${symbol}: hedge Puts held without shares, no quote to sell them at`;
  }
  if (openLegs.some(isShortCall)) return null;
  if (sharesHeldToday === 0 && state.unwoundOn === todayIso) return `${symbol}: unwound today, the next cycle starts at the next day's 10:00 look`;
  if (!lookSymbol.optionContractsRepresentable) return `${symbol}: no option orders while the open cycle spans a split`;
  // Shares held and no Call sold: with no Put, a Put keeps them hedged (hedgeWithoutCall "put" or "cheapest_per_year");
  // with Puts held, those in profit are cashed in (putCashIn "when_no_call").
  const noCallNote = (message: string) => {
    if (sharesHeldToday === 0) return message;
    if (hedgeLegs.length > 0) return farmer.putCashIn === "when_no_call" ? cashInPuts({ ...input, hedgeLegs, sharesHeld: sharesHeldToday, noCallNote: message }) : message;
    return farmer.hedge === "put" && farmer.hedgeWithoutCall !== "none" ? `${message} · ${hedgeWithoutCall({ ...input, sharesHeld: sharesHeldToday, minProtectionPct: farmer.minPutProtectionPct, afterCashIn: false })}` : message;
  };

  const quotes = lookSymbol.market.quotes;
  // callExpiry "next": the Calls of the next listed expiry after today only.
  const nextCallExpiry = farmer.callExpiry === "next" ? quotes.reduce<string | null>((next, quote) => (quote.right === "C" && quote.expiry > todayIso && (next === null || quote.expiry < next) ? quote.expiry : next), null) : null;
  if (farmer.callExpiry === "next" && nextCallExpiry === null) return noCallNote(`${symbol}: no Call expiry listed after today`);
  const callDteRange = nextCallExpiry === null ? { minDte: farmer.callMinDte, maxDte: farmer.callMaxDte } : { minDte: daysToExpiry(nextCallExpiry, todayIso), maxDte: daysToExpiry(nextCallExpiry, todayIso) };
  const yearsToTodaysClose = Math.max(0, expirySettlementInstant(todayIso).getTime() - at.getTime()) / millisecondsPerYear;
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate });
  const { candidates, rejections } = selectBaselineCandidates({
    quotes,
    forwardAnchors,
    commissions: volFarmerCommissions,
    right: "C",
    todayIso,
    yearsToTodaysClose,
    stockPrice,
    riskFreeRate,
    previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract,
    settings: { minAbsDelta: farmer.callMinAbsDelta, maxAbsDelta: farmer.callMaxAbsDelta, ...callDteRange, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid },
    spreadShareCharged: context.settings.trading.spreadCostChargedPct / 100,
    isHeld: () => false,
    tradingSessionsThrough: (expiry) => context.calendar.sessionsHeld(todayIso, expiry),
  });
  const calls = candidates.filter((candidate) => candidate.strike > stockPrice);
  if (calls.length === 0) return noCallNote(`${symbol}: no Call within the rules (${describeRejections(rejections)})`);
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;

  // The cycle's shares: what they cost (step 2), or S with the commission (step 1).
  const shareCostToday = sharesHeldToday > 0 ? stockLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity, 0) / stockLegs.reduce((sum, leg) => sum + leg.quantity, 0) / priceToCycleScale : stockPrice + stockCommissionDollars(1);
  const cyclePositions = cyclePositionsOf(ledger, symbol, state.cycleStartedAt);
  const cycleHedgeRealized = cyclePositions.filter((position) => position.strategyKey === "hedge" && position.status === "closed").reduce((sum, position) => sum + ledgerRealizedPnl(ledger, position.id).total, 0);
  const cycleCallRealized = farmer.hedgeRuleCallPremiums === "included" ? cyclePositions.filter((position) => position.strategyKey === "covered_call").reduce((sum, position) => sum + ledgerRealizedPnl(ledger, position.id).premium, 0) : 0;
  const cycleStockRealized = farmer.hedgeRuleStockPnl === "included" ? cycleRealizedBySource(ledger, cyclePositions).shares : 0;
  const cycleRealized = cycleHedgeRealized + cycleCallRealized + cycleStockRealized;
  const realizedPerShare = sharesHeldToday > 0 ? cycleRealized / sharesHeldToday : 0;
  const lotsHeld = Math.floor(sharesHeldToday / sharesPerContract + 1e-9);
  const breakEvenNote = sharesHeldToday > 0 ? `shares at ${shareCostToday.toFixed(2)}${cycleHedgeRealized !== 0 ? `, the cycle's Puts sold or expired ${cycleHedgeRealized >= 0 ? "+" : "−"}${formatWholeDollars(Math.abs(cycleHedgeRealized))}` : ""}${cycleCallRealized !== 0 ? `, its Calls ${cycleCallRealized >= 0 ? "+" : "−"}${formatWholeDollars(Math.abs(cycleCallRealized))}` : ""}${cycleStockRealized !== 0 ? `, its shares sold or called away ${formatWholeDollars(cycleStockRealized, true)}` : ""}${cycleRealized !== 0 ? `, so the shares break even at ${(shareCostToday - realizedPerShare).toFixed(2)}` : ""}` : null;

  if (farmer.hedge === "none") return sellCallWithoutHedge({ ...input, calls, shareCostPerShare: shareCostToday, realizedPerShare, sharesHeld: sharesHeldToday, lotsHeld, breakEvenNote, sharesPerContractOnCycleScale });

  // A Put still held: the Call must pass the hedge rule with it, and expire on or before it.
  if (hedgeLegs.length > 0) {
    // hedgeAfterExpiry "sell_if_in_profit": after a Call expired below its strike, Puts in profit are rolled first.
    const lastCalls = lastClosedCoveredCalls(cyclePositions);
    if (farmer.hedgeAfterExpiry === "sell_if_in_profit" && lastCalls.length > 0 && lastCalls.every((position) => position.closeReason === "expired_worthless")) {
      const rolled = rollPutForCall({ ...input, calls, hedgeLegs, shareCostPerShare: shareCostToday, cycleRealized, sharesHeld: sharesHeldToday, lotsHeld, breakEvenNote, spreadShareCharged, sharesPerContractOnCycleScale, inProfitOnly: true });
      if (rolled !== null) return rolled;
    }
    const putLeg = hedgeLegs[0]!;
    const putStrike = putLeg.strikePrice! / priceToCycleScale;
    const putImpliedVolatility = state.impliedVolatilityByLegId.get(putLeg.id);
    if (putImpliedVolatility === undefined) return noCallNote(`${symbol}: the hedge Put has no implied volatility yet; no Call sold`);
    const lotsWanted = Math.min(lotsHeld, hedgeLegs.reduce((sum, leg) => sum + leg.quantity, 0));
    let pick: { call: BaselineCandidate; surplus: number } | null = null;
    let fallback: { call: BaselineCandidate; surplus: number } | null = null;
    for (const call of calls) {
      if (call.expiry > putLeg.expiryDate!) continue;
      const surplus = volFarmerHedgeSurplus({ callStrike: call.strike, shareCostPerShare: shareCostToday, put: { strike: putStrike, costPerShare: putLeg.entryPrice / priceToCycleScale, impliedVolatility: putImpliedVolatility, yearsLeftAtCallExpiry: yearsBetweenExpiries(call.expiry, putLeg.expiryDate!) }, realizedHedgePnlPerShare: realizedPerShare, riskFreeRate });
      if (surplus < 0) continue;
      if (call.volumeCap >= lotsWanted) {
        pick = { call, surplus };
        break;
      }
      if (fallback === null || call.volumeCap > fallback.call.volumeCap) fallback = { call, surplus };
    }
    pick ??= fallback;
    if (pick === null) {
      if (farmer.putRoll === "when_no_call") {
        const rolled = rollPutForCall({ ...input, calls, hedgeLegs, shareCostPerShare: shareCostToday, cycleRealized, sharesHeld: sharesHeldToday, lotsHeld, breakEvenNote, spreadShareCharged, sharesPerContractOnCycleScale });
        if (rolled !== null) return rolled;
      }
      return noCallNote(`${symbol}: no Call passes the hedge rule with the Put held and expires by it (${breakEvenNote})`);
    }
    const contracts = Math.min(lotsWanted, pick.call.volumeCap);
    if (contracts < 1) return noCallNote(`${symbol}: no Call sold: the volume limit allows none`);
    const coverage = contracts < lotsWanted ? `no Call's volume covers all ${lotsWanted} lots, this one covers the most` : "its volume covers every lot";
    noteCallSale(state, contracts < lotsWanted);
    const sold = sellCall({ ...input, call: pick.call, contracts, stockFillPrice: null, why: `the highest premium yield whose strike passes the hedge rule with the Put held, ${coverage} (${breakEvenNote}; surplus at the strike ${pick.surplus.toFixed(2)} a share)`, sharesPerContractOnCycleScale });
    return `${sold}${sellLotsLeftOut({ ...input, lotsHeld, lotsCovered: contracts })}`;
  }

  // A new Put with the Call. A cycle's first keeps putCashReservePct of the free cash for the later Puts; a later one
  // spends all of it.
  const putChoice = volFarmerPutCandidates({ lookSymbol, farmer, callExpiries: calls.map((call) => call.expiry), todayIso, at, spreadShareCharged, sessionsHeldTo: (expiry) => context.calendar.sessionsHeld(todayIso, expiry) });
  if (typeof putChoice === "string") return putChoice;
  const putCandidates = putChoice;
  const startsCycle = sharesHeldToday === 0;
  const freeCash = ledgerFreeCash(ledger);
  const reservedCash = startsCycle ? (freeCash * farmer.putCashReservePct) / 100 : 0;
  const { pick, cheapestUnaffordableLot } = pickVolFarmerOpening({ calls, putCandidates, farmer, shareCostPerShare: shareCostToday, realizedPerShare, stockPrice, riskFreeRate, freeCash, reservedCash, startsCycle, lotsHeld });
  if (!startsCycle) {
    // The cash check: every later Put purchase, and whether the cash paid for every lot held.
    const lotsPaid = pick === null ? (cheapestUnaffordableLot === null ? null : 0) : Math.min(pick.affordableLots, lotsHeld);
    if (lotsPaid !== null) {
      state.cash.laterPutPurchases += 1;
      if (lotsPaid < lotsHeld) {
        state.cash.shortPurchases += 1;
        state.cash.firstShort ??= { dateIso: todayIso, lotsPaid, lotsHeld };
      }
    }
  }
  if (pick === null) {
    if (cheapestUnaffordableLot !== null) return `${symbol}: ${startsCycle ? "no cycle opened" : "no Put bought"}: ${startsCycle ? "a lot" : "a lot's Put"} costs ${formatWholeDollars(cheapestUnaffordableLot)}, more than the free cash${startsCycle ? " less the reserve" : ""} (${formatWholeDollars(freeCash - reservedCash)})${startsCycle ? "" : sellLotsLeftOut({ ...input, lotsHeld, lotsCovered: 0 })}`;
    return noCallNote(`${symbol}: no Call has a Put that passes the hedge rule (${calls.length} Call(s), ${putCandidates.length} Put(s) tried${breakEvenNote ? `; ${breakEvenNote}` : ""})`);
  }
  const { call, chosen, contracts } = pick;
  const putContract = describeOptionContract({ strike: chosen.put.strike, right: "P", expiry: chosen.put.expiry, dte: daysToExpiry(chosen.put.expiry, todayIso) });
  const coverage = contracts < pick.lotsWanted ? `no Call's volume covers all ${pick.lotsWanted} lots, this one covers the most` : "its volume covers every lot";
  noteCallSale(state, contracts < pick.lotsWanted);
  const cashNote = startsCycle ? `; ${formatWholeDollars(reservedCash)} (${farmer.putCashReservePct}% of the free cash) kept for later Puts` : pick.affordableLots < lotsHeld ? `; the cash pays for the Puts of ${pick.affordableLots} of the ${lotsHeld} lots held` : "";
  const callSummary = sellCall({ ...input, call, contracts, stockFillPrice: startsCycle ? stockPrice : null, why: `the highest premium yield whose strike some Put passes the hedge rule for, ${coverage}${breakEvenNote ? ` (${breakEvenNote})` : ""}; hedged by the ${putContract}${cashNote}`, sharesPerContractOnCycleScale });
  const putSummary = buyPut({ ...input, put: chosen.put, contracts, surplus: chosen.surplus, protection: chosen.protection, callStrike: call.strike, sharesPerContractOnCycleScale });
  return `${callSummary} · ${putSummary}${cashNote}${startsCycle ? "" : sellLotsLeftOut({ ...input, lotsHeld, lotsCovered: contracts })}`;
}

/**
 * hedge "none" (above): the Calls by premium yield, the first whose strike passes the hedge rule on the shares alone and
 * whose volume covers every lot (a new cycle's lots, or those held), else the one covering the most; a new cycle buys its
 * shares with it. Returns the look's summary, or why no Call was sold.
 */
function sellCallWithoutHedge(input: Parameters<typeof openSymbol>[0] & { calls: readonly BaselineCandidate[]; shareCostPerShare: number; realizedPerShare: number; sharesHeld: number; lotsHeld: number; breakEvenNote: string | null; sharesPerContractOnCycleScale: number }): string {
  const { context, lookSymbol, farmer } = input;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const startsCycle = input.sharesHeld === 0;
  const lotCost = stockPrice * sharesPerContract + stockCommissionDollars(sharesPerContract);
  const freeCash = ledgerFreeCash(context.ledger);
  const reservedCash = (freeCash * farmer.putCashReservePct) / 100;
  const lotsWanted = startsCycle ? Math.floor((freeCash - reservedCash) / lotCost + 1e-9) : input.lotsHeld;
  if (lotsWanted < 1) return startsCycle ? `${symbol}: no cycle opened: a lot costs ${formatWholeDollars(lotCost)}, more than the free cash less the reserve (${formatWholeDollars(freeCash - reservedCash)})` : `${symbol}: no whole lot held, no Call sold`;
  let pick: BaselineCandidate | null = null;
  let fallback: BaselineCandidate | null = null;
  for (const call of input.calls) {
    if (call.strike - input.shareCostPerShare + input.realizedPerShare < 0) continue;
    if (call.volumeCap >= lotsWanted) {
      pick = call;
      break;
    }
    if (fallback === null || call.volumeCap > fallback.volumeCap) fallback = call;
  }
  pick ??= fallback;
  if (pick === null) return `${symbol}: no Call passes the hedge rule on the shares alone${input.breakEvenNote ? ` (${input.breakEvenNote})` : ""}`;
  const contracts = Math.min(lotsWanted, pick.volumeCap);
  if (contracts < 1) return `${symbol}: no Call sold: the volume limit allows none`;
  const coverage = contracts < lotsWanted ? `no Call's volume covers all ${lotsWanted} lots, this one covers the most` : "its volume covers every lot";
  noteCallSale(stateOf(context.ledger, symbol), contracts < lotsWanted);
  const sold = sellCall({ ...input, call: pick, contracts, stockFillPrice: startsCycle ? stockPrice : null, why: `the highest premium yield whose strike passes the hedge rule on the shares alone (no hedge), ${coverage}${input.breakEvenNote ? ` (${input.breakEvenNote})` : ""}` });
  return startsCycle ? sold : `${sold}${sellLotsLeftOut({ ...input, lotsCovered: contracts })}`;
}

/** The Puts a new hedge is chosen from (the "Puts tried" above) for the Calls' expiries (with no Call, the one protection is measured at), or why there are none. */
function volFarmerPutCandidates(input: { lookSymbol: BacktestLookSymbol; farmer: BacktestVolFarmerSettings; callExpiries: readonly string[]; todayIso: string; at: Date; spreadShareCharged: number; sessionsHeldTo: (expiry: string) => number }): VolFarmerPutCandidate[] | string {
  const { lookSymbol, farmer, todayIso, at } = input;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const putSource = lookSymbol.hedgePutQuotes;
  if (!putSource) return `${symbol}: no Put quotes`;
  const maxPutStrike = stockPrice * (1 + farmer.putMaxStrikeAbovePricePct / 100) + 1e-9;
  const putCandidates: VolFarmerPutCandidate[] = [];
  const shortestCallExpiry = input.callExpiries.reduce((earliest, expiry) => (expiry < earliest ? expiry : earliest), input.callExpiries[0]!);
  const withTheCall = farmer.putExpiry === "with_the_call";
  const callExpiries = new Set(input.callExpiries);
  for (const expiry of putSource.listedExpiries()) {
    const putDte = daysToExpiry(expiry, todayIso);
    if (withTheCall ? !callExpiries.has(expiry) : expiry < shortestCallExpiry || putDte < farmer.putMinDte || putDte > farmer.putMaxDte) continue;
    const yearsToExpiry = yearsToExpiryFrom(at.getTime(), expiry);
    for (const quote of putSource.quotesOf(expiry)) {
      if (quote.right !== "P" || quote.strike > maxPutStrike || baselineQuoteRejection(quote, farmer.maxSpreadPctOfMid) !== null) continue;
      const mid = (quote.bid! + quote.ask!) / 2;
      const impliedVolatility = impliedVolatilityFromPrice(mid, stockPrice * Math.exp(riskFreeRate * yearsToExpiry), quote.strike, yearsToExpiry, riskFreeRate, false);
      if (impliedVolatility === null) continue;
      putCandidates.push({ expiry, dte: putDte, sessionsHeld: input.sessionsHeldTo(expiry), strike: quote.strike, bid: quote.bid!, ask: quote.ask!, fillPrice: optionPurchaseFillPrice(quote.bid!, quote.ask!, input.spreadShareCharged), impliedVolatility });
    }
  }
  if (putCandidates.length === 0) return `${symbol}: no Put with a usable quote ${withTheCall ? "expiring with the Calls" : `from ${farmer.putMinDte} to ${farmer.putMaxDte} days`}`;
  return putCandidates;
}

type VolFarmerOpening = { call: BaselineCandidate; chosen: NonNullable<ReturnType<typeof chooseVolFarmerPut>>; lotsWanted: number; contracts: number; affordableLots: number; lotCost: number };

/** Steps 1 and 2's choice of a Call with a new Put: the Calls by premium yield, the first that has a Put and whose volume covers every lot the cash pays for, else the one covering the most. */
function pickVolFarmerOpening(input: {
  calls: readonly BaselineCandidate[];
  putCandidates: readonly VolFarmerPutCandidate[];
  farmer: BacktestVolFarmerSettings;
  shareCostPerShare: number;
  realizedPerShare: number;
  stockPrice: number;
  riskFreeRate: number;
  freeCash: number;
  reservedCash: number;
  startsCycle: boolean;
  lotsHeld: number;
}): { pick: VolFarmerOpening | null; cheapestUnaffordableLot: number | null } {
  const { farmer, stockPrice, startsCycle } = input;
  let pick: VolFarmerOpening | null = null;
  let fallback: VolFarmerOpening | null = null;
  let cheapestUnaffordableLot: number | null = null;
  for (const call of input.calls) {
    const chosen = chooseVolFarmerPut({ puts: input.putCandidates, callStrike: call.strike, callExpiry: call.expiry, shareCostPerShare: input.shareCostPerShare, realizedHedgePnlPerShare: input.realizedPerShare, stockPrice, fallFraction: farmer.protectionFallPct / 100, riskFreeRate: input.riskFreeRate, sameExpiry: farmer.putExpiry === "with_the_call", minProtection: farmer.minPutProtectionPct / 100, maxFillPrice: farmer.maxPutCostPctOfCallPremium > 0 ? (call.fillPrice * farmer.maxPutCostPctOfCallPremium) / 100 : undefined, choice: farmer.putChoice });
    if (chosen === null) continue;
    const putCostPerLot = chosen.put.fillPrice * sharesPerContract + optionCommissionDollars(1);
    const lotCost = startsCycle ? stockPrice * sharesPerContract + stockCommissionDollars(sharesPerContract) + putCostPerLot : putCostPerLot;
    const affordableLots = Math.floor((input.freeCash - input.reservedCash) / lotCost + 1e-9);
    const lotsWanted = startsCycle ? affordableLots : Math.min(input.lotsHeld, affordableLots);
    if (lotsWanted < 1) {
      cheapestUnaffordableLot = Math.min(cheapestUnaffordableLot ?? lotCost, lotCost);
      continue;
    }
    const opening: VolFarmerOpening = { call, chosen, lotsWanted, contracts: Math.min(lotsWanted, call.volumeCap), affordableLots, lotCost };
    if (call.volumeCap >= lotsWanted) {
      pick = opening;
      break;
    }
    if (fallback === null || opening.contracts > fallback.contracts) fallback = opening;
  }
  return { pick: pick ?? fallback, cheapestUnaffordableLot };
}

/**
 * putRoll "when_no_call" (above): sells the Puts held when their banked P&L lets a Call pass with a new Put, then sells
 * the Call and buys the new Put; null (nothing traded) when no Call would pass, or a Put held has no quote to sell at.
 * With inProfitOnly (hedgeAfterExpiry "sell_if_in_profit"), only when the sale banks a gain.
 */
function rollPutForCall(input: {
  context: BacktestLookContext;
  lookSymbol: BacktestLookSymbol;
  farmer: BacktestVolFarmerSettings;
  at: Date;
  priceToCycleScale: number;
  actions: BacktestAction[];
  optionSales: BacktestOptionSale[];
  calls: readonly BaselineCandidate[];
  hedgeLegs: readonly LedgerLeg[];
  shareCostPerShare: number;
  cycleRealized: number;
  sharesHeld: number;
  lotsHeld: number;
  breakEvenNote: string | null;
  spreadShareCharged: number;
  sharesPerContractOnCycleScale: number;
  inProfitOnly?: boolean;
}): string | null {
  const { context, lookSymbol, farmer, at, priceToCycleScale, inProfitOnly } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const sales: { leg: LedgerLeg; strike: number; fill: number }[] = [];
  let proceeds = 0;
  let realizedIfSold = 0;
  for (const leg of input.hedgeLegs) {
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const matches = (quote: SymbolFileQuote) => quote.expiry === leg.expiryDate && quote.right === "P" && roundedStrike(quote.strike) === strike;
    const quote = lookSymbol.market.quotes.find(matches) ?? lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find(matches);
    if (!quote || quote.ask === null || !(quote.ask > 0)) return null;
    const fill = optionSaleFillPrice(quote.bid ?? 0, quote.ask, input.spreadShareCharged);
    proceeds += fill * leg.quantity * sharesPerContract - optionCommissionDollars(leg.quantity);
    realizedIfSold += (fill - leg.entryPrice / priceToCycleScale) * leg.quantity * sharesPerContract - optionCommissionDollars(leg.quantity);
    sales.push({ leg, strike, fill });
  }
  if (inProfitOnly && !(realizedIfSold > 0)) return null;
  const putCandidates = volFarmerPutCandidates({ lookSymbol, farmer, callExpiries: input.calls.map((call) => call.expiry), todayIso, at, spreadShareCharged: input.spreadShareCharged, sessionsHeldTo: (expiry) => context.calendar.sessionsHeld(todayIso, expiry) });
  if (typeof putCandidates === "string") return null;
  const realizedPerShare = (input.cycleRealized + realizedIfSold) / input.sharesHeld;
  const { pick } = pickVolFarmerOpening({ calls: input.calls, putCandidates, farmer, shareCostPerShare: input.shareCostPerShare, realizedPerShare, stockPrice, riskFreeRate, freeCash: ledgerFreeCash(ledger) + proceeds, reservedCash: 0, startsCycle: false, lotsHeld: input.lotsHeld });
  if (pick === null) return null;

  const sold: string[] = [];
  for (const { leg, strike, fill } of sales) {
    const actionId = context.nextActionId();
    const positionId = leg.positionId;
    sellHedgePut(ledger, { legId: leg.id, contracts: leg.quantity, fillPrice: fill * priceToCycleScale, at, actionId });
    state.impliedVolatilityByLegId.delete(leg.id);
    const description = `${symbol} Sell ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}${describeOrderSize(leg.quantity, fill)} (${inProfitOnly ? "hedge sold in profit after the Call's expiry, with a new Call and Put" : "hedge rolled: what it realizes lets a Call pass the hedge rule"})`;
    const chosenBecause = inProfitOnly ? "vol farmer: the Call expired below its strike with the Put held in profit; it is sold with a new Call and a new Put that pass the hedge rule with its gain counted" : "vol farmer: no Call passes with the Put held; selling it banks its P&L, and with that a Call passes with a new Put (roll)";
    input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" }, quantity: leg.quantity, fillPrice: fill, positionIds: [positionId], scores: { stockPrice, bid: null, ask: null } }), automatic: false, chosenBecause });
    sold.push(description);
  }
  const { call, chosen, contracts } = pick;
  state.cash.laterPutPurchases += 1;
  if (pick.affordableLots < input.lotsHeld) {
    state.cash.shortPurchases += 1;
    state.cash.firstShort ??= { dateIso: todayIso, lotsPaid: pick.affordableLots, lotsHeld: input.lotsHeld };
  }
  noteCallSale(state, contracts < pick.lotsWanted);
  const putContract = describeOptionContract({ strike: chosen.put.strike, right: "P", expiry: chosen.put.expiry, dte: daysToExpiry(chosen.put.expiry, todayIso) });
  const rollReason = inProfitOnly ? "the Put held was in profit after the Call's expiry, so it was sold" : "no Call passed with the Put held, so it was rolled";
  const callSummary = sellCall({ ...input, call, contracts, stockFillPrice: null, why: `${rollReason}: the highest premium yield whose strike some Put passes the hedge rule for with the old Put's P&L banked (${formatWholeDollars(realizedIfSold)})${input.breakEvenNote ? `; ${input.breakEvenNote}` : ""}; hedged by the ${putContract}` });
  const putSummary = buyPut({ ...input, put: chosen.put, contracts, surplus: chosen.surplus, protection: chosen.protection, callStrike: call.strike });
  return `${sold.join(" · ")} · ${callSummary} · ${putSummary}${sellLotsLeftOut({ ...input, lotsCovered: contracts })}`;
}

/**
 * putCashIn "when_no_call" (above): the look sold no Call, so each Put held whose sale at the fill rule banks a gain is
 * sold (the hedge rule counts the gain from the next look) and the lots left without a Put get the hedgeWithoutCall Put.
 * Returns the look's note followed by what was traded; the note alone when no Put held would sell at a gain.
 */
function cashInPuts(input: Parameters<typeof openSymbol>[0] & { hedgeLegs: readonly LedgerLeg[]; sharesHeld: number; noCallNote: string }): string {
  const { context, lookSymbol, farmer, at, priceToCycleScale } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const stockPrice = lookSymbol.market.stockPrice;
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;
  const sold: string[] = [];
  let contractsKept = 0;
  for (const leg of input.hedgeLegs) {
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const matches = (quote: SymbolFileQuote) => quote.expiry === leg.expiryDate && quote.right === "P" && roundedStrike(quote.strike) === strike;
    const quote = lookSymbol.market.quotes.find(matches) ?? lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find(matches);
    const fill = quote && quote.ask !== null && quote.ask > 0 ? optionSaleFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged) : null;
    const gain = fill === null ? null : (fill - leg.entryPrice / priceToCycleScale) * leg.quantity * sharesPerContract - optionCommissionDollars(leg.quantity);
    if (fill === null || gain === null || !(gain > 0)) {
      contractsKept += leg.quantity;
      continue;
    }
    const actionId = context.nextActionId();
    sellHedgePut(ledger, { legId: leg.id, contracts: leg.quantity, fillPrice: fill * priceToCycleScale, at, actionId });
    state.impliedVolatilityByLegId.delete(leg.id);
    const description = `${symbol} Sell ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}${describeOrderSize(leg.quantity, fill)} (hedge cashed in: no Call sold; its gain of ${formatWholeDollars(gain)} counts in the hedge rule from the next look)`;
    const chosenBecause = "vol farmer: no Call is sold with the Put in profit; it is sold so its gain lowers the strike the hedge rule asks of a Call, and the shares get a new Put";
    input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" }, quantity: leg.quantity, fillPrice: fill, positionIds: [leg.positionId], scores: { stockPrice, bid: quote!.bid, ask: quote!.ask, gainDollars: gain } }), automatic: false, chosenBecause });
    sold.push(description);
  }
  if (sold.length === 0) return input.noCallNote;
  const lotsWithoutPut = Math.max(0, Math.floor(input.sharesHeld / sharesPerContract + 1e-9) - contractsKept);
  const replacement =
    lotsWithoutPut === 0 ? null : farmer.hedgeWithoutCall === "none" ? `${symbol}: the shares stay unhedged until a Call is sold with a new Put` : hedgeWithoutCall({ ...input, sharesHeld: lotsWithoutPut * sharesPerContract, minProtectionPct: farmer.cashInPutMinProtectionPct, afterCashIn: true });
  return [input.noCallNote, ...sold, ...(replacement === null ? [] : [replacement])].join(" · ");
}

/**
 * afterAssignment "continue_if_under_water" (step 3 above), Puts held after the shares were called away at the last
 * expiry: Rs + Rh + the Puts' sale at the fill rule (Calls left out). Above 0, `summary` is null and step 3 sells the
 * Puts (the cycle ends; `endNote` says why). Otherwise the shares called away are bought back at S (the lots the free cash
 * pays for), the Puts kept, and step 2 runs on them: `summary` is the look's. Puts without a quote: nothing is traded.
 */
function continueAfterAssignment(input: Parameters<typeof openSymbol>[0] & { hedgeLegs: readonly LedgerLeg[] }): { summary: string | null; endNote: string } {
  const { context, lookSymbol, at, priceToCycleScale } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const stockPrice = lookSymbol.market.stockPrice;
  const cyclePositions = cyclePositionsOf(ledger, symbol, state.cycleStartedAt);
  const calledAway = lastClosedCoveredCalls(cyclePositions);
  if (calledAway.length === 0 || calledAway.some((position) => position.closeReason !== "assigned")) return { summary: null, endNote: "" };
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;
  let putsIfSold = 0;
  for (const leg of input.hedgeLegs) {
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const quote = lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find((candidate) => candidate.right === "P" && roundedStrike(candidate.strike) === strike);
    if (!quote || quote.ask === null || !(quote.ask > 0)) return { summary: `${symbol}: hedge Puts held without shares, no quote to price them at`, endNote: "" };
    putsIfSold += (optionSaleFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged) * priceToCycleScale - leg.entryPrice) * leg.quantity * leg.multiplier - optionCommissionDollars(leg.quantity);
  }
  const realized = cycleRealizedBySource(ledger, cyclePositions);
  const net = realized.shares + realized.puts + putsIfSold;
  const netNote = `the cycle's shares ${formatWholeDollars(realized.shares, true)} and Puts ${formatWholeDollars(realized.puts + putsIfSold, true)} with their sale, Calls left out: ${formatWholeDollars(net, true)}`;
  if (net > 0) return { summary: null, endNote: `; ${netNote}, so the cycle ends` };

  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const sharesCalledAway = calledAway.reduce((sum, position) => sum + legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "stock").reduce((legSum, leg) => legSum + leg.quantity, 0), 0) * priceToCycleScale;
  const lotsCalledAway = Math.floor(sharesCalledAway / sharesPerContract + 1e-9);
  const lotCost = stockPrice * sharesPerContract + stockCommissionDollars(sharesPerContract);
  const lots = Math.min(lotsCalledAway, Math.floor(ledgerFreeCash(ledger) / lotCost + 1e-9));
  if (lots < 1) return { summary: null, endNote: `; ${netNote}, but the free cash pays for no lot to buy back, so the cycle ends` };
  const actionId = context.nextActionId();
  const bought = buyShares(ledger, { symbol, shares: lots * sharesPerContractOnCycleScale, fillPrice: stockPrice * priceToCycleScale, at, actionId, splitFactorToday: lookSymbol.splitFactorToday, tradedSharesPerLedgerShare: priceToCycleScale });
  context.priceByLegId.set(bought.legId, stockPrice * priceToCycleScale);
  const sharesToday = lots * sharesPerContract;
  const description = `${symbol} Buy ${sharesToday} shares @ ${stockPrice.toFixed(2)} (the shares called away at the last expiry bought back${lots < lotsCalledAway ? `: ${lots} of the ${lotsCalledAway} lots, what the free cash pays for` : ""}; ${netNote}, so the Puts are kept)`;
  input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "buy_shares", description, contract: null, quantity: sharesToday, fillPrice: stockPrice, positionIds: [bought.positionId], scores: { stockPrice, cycleSharesRealizedDollars: realized.shares, cyclePutsRealizedDollars: realized.puts, putsSaleDollars: putsIfSold, cycleNetDollars: net } }), automatic: false, chosenBecause: "vol farmer: shares called away with the cycle's shares and Puts under water are bought back and the Puts kept" });
  const next = openSymbol(input);
  return { summary: next === null ? description : `${description} · ${next}`, endNote: "" };
}

/**
 * The lots held that the look left without a Call and a Put (the volume limit or the cash): their shares are sold at
 * the look's price where it is above what they cost (commission included; Marcelo 2026-10-23), with as many of the Puts
 * no Call covers; the others are kept and tried again at the next 10:00 look. Returns the note on them; empty when none.
 */
function sellLotsLeftOut(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; at: Date; priceToCycleScale: number; actions: BacktestAction[]; lotsHeld: number; lotsCovered: number }): string {
  const { context, lookSymbol, at, priceToCycleScale } = input;
  const { ledger, todayIso } = context;
  const lotsLeftOut = input.lotsHeld - input.lotsCovered;
  if (lotsLeftOut <= 0) return "";
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  let ledgerSharesToSell = lotsLeftOut * sharesPerContractOnCycleScale;
  let lotsSold = 0;
  const notes: string[] = [];
  const uncoveredLegs = positionsOfSymbol(ledger, symbol)
    .filter((position) => position.status === "open" && position.strategyKey === "unstructured")
    .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null && isStock(leg)));
  for (const leg of uncoveredLegs) {
    if (ledgerSharesToSell <= 0) break;
    const costToday = leg.entryPrice / priceToCycleScale;
    if (!(stockPrice > costToday)) {
      notes.push(`${Math.round(leg.quantity * priceToCycleScale)} shares that cost ${costToday.toFixed(2)} kept: the price ${stockPrice.toFixed(2)} is not above it`);
      continue;
    }
    const shares = Math.min(leg.quantity, ledgerSharesToSell);
    const actionId = context.nextActionId();
    const positionId = leg.positionId;
    sellShares(ledger, { positionId, shares, fillPrice: stockPrice * priceToCycleScale, at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
    ledgerSharesToSell -= shares;
    const sharesToday = Math.round(shares * priceToCycleScale);
    lotsSold += Math.floor(sharesToday / sharesPerContract + 1e-9);
    const description = `${symbol} Sell ${sharesToday} shares @ ${stockPrice.toFixed(2)} (no Call and Put for them: the volume limit or the cash; above their cost ${costToday.toFixed(2)})`;
    input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "close_shares", description, contract: null, quantity: sharesToday, fillPrice: stockPrice, positionIds: [positionId], scores: { stockPrice, costPerShare: costToday } }), automatic: false, chosenBecause: "vol farmer: shares left without a Call and a Put are sold above what they cost" });
    notes.push(description);
  }
  // The Puts no Call covers go with the shares sold.
  const callContracts = openLegsOfSymbol(ledger, symbol).filter(isShortCall).reduce((sum, leg) => sum + leg.quantity, 0);
  let putsToSell = Math.min(lotsSold, ledgerOpenHedgeLegs(ledger, symbol).reduce((sum, leg) => sum + leg.quantity, 0) - callContracts);
  for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
    if (putsToSell <= 0) break;
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const matches = (quote: SymbolFileQuote) => quote.expiry === leg.expiryDate && quote.right === "P" && roundedStrike(quote.strike) === strike;
    const quote = lookSymbol.market.quotes.find(matches) ?? lookSymbol.hedgePutQuotes?.quotesOf(leg.expiryDate!).find(matches);
    if (!quote || quote.ask === null || !(quote.ask > 0)) {
      notes.push(`their ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })} kept: no quote to sell it at`);
      continue;
    }
    const contracts = Math.min(leg.quantity, putsToSell);
    const fill = optionSaleFillPrice(quote.bid ?? 0, quote.ask, context.settings.trading.spreadCostChargedPct / 100);
    const actionId = context.nextActionId();
    const positionId = leg.positionId;
    sellHedgePut(ledger, { legId: leg.id, contracts, fillPrice: fill * priceToCycleScale, at, actionId });
    putsToSell -= contracts;
    const description = `${symbol} Sell ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}${describeOrderSize(contracts, fill)} (hedge of the shares sold)`;
    input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" }, quantity: contracts, fillPrice: fill, positionIds: [positionId], scores: { bid: quote.bid, ask: quote.ask, stockPrice } }), automatic: false, chosenBecause: "vol farmer: the hedge of shares sold goes with them" });
    notes.push(description);
  }
  const kept = lotsLeftOut - lotsSold;
  const keptNote = kept > 0 ? `${kept} of the ${input.lotsHeld} lots held left without a Call and a Put (kept, tried again at the next 10:00 look)` : null;
  if (lotsSold > 0 && openLegsOfSymbol(ledger, symbol).length === 0) stateOf(ledger, symbol).unwoundOn = todayIso;
  return `; ${[...notes, ...(keptNote ? [keptNote] : [])].join("; ")}`;
}

function noteCallSale(state: VolFarmerSymbolState, shortOfVolume: boolean): void {
  state.cash.callSales += 1;
  if (shortOfVolume) state.cash.callSalesShortOfVolume += 1;
}

/**
 * The session note on the Vol Farmer's cash and volume: the later Puts it bought and those the cash could not pay for
 * every lot, the lowest free cash after a 10:00 look, and the Call sales no Call's volume could cover every lot for.
 */
export function describeVolFarmerCash(ledger: SimulatedLedger, symbols: readonly string[]): string | null {
  const bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) return null;
  const parts = symbols.flatMap((symbol) => {
    const cash = bySymbol.get(symbol)?.cash;
    if (!cash) return [];
    const shortfalls = cash.shortPurchases === 0 ? "the cash paid for every lot's Put each time" : `${cash.shortPurchases} time(s) the cash paid for fewer lots than held (first on ${cash.firstShort!.dateIso}: ${cash.firstShort!.lotsPaid} of ${cash.firstShort!.lotsHeld})`;
    const lowest = cash.lowestFreeCash === null ? "" : `; lowest free cash after a 10:00 look ${formatWholeDollars(cash.lowestFreeCash)}`;
    const volume = `; ${cash.callSales} Call sale(s), ${cash.callSalesShortOfVolume} with no Call whose volume covered every lot`;
    return [`${symbols.length > 1 ? `${symbol}: ` : ""}${cash.laterPutPurchases} later Put purchase(s) for held shares, ${shortfalls}${lowest}${volume}`];
  });
  return parts.length === 0 ? null : `Vol Farmer cash and volume: ${parts.join(" · ")}.`;
}

function sellCall(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; at: Date; priceToCycleScale: number; actions: BacktestAction[]; optionSales: BacktestOptionSale[]; call: BaselineCandidate; contracts: number; stockFillPrice: number | null; why: string; sharesPerContractOnCycleScale: number }): string {
  const { context, lookSymbol, at, priceToCycleScale, call, contracts } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const stockPrice = lookSymbol.market.stockPrice;
  const actionId = context.nextActionId();
  const opened = openCoveredCall(ledger, {
    symbol,
    expiryDate: call.expiry,
    strike: call.strike * priceToCycleScale,
    contracts,
    callFillPrice: call.fillPrice * priceToCycleScale,
    stockFillPrice: input.stockFillPrice === null ? null : input.stockFillPrice * priceToCycleScale,
    at,
    actionId,
    splitFactorToday: lookSymbol.splitFactorToday,
    sharesPerContract: input.sharesPerContractOnCycleScale,
    tradedSharesPerLedgerShare: priceToCycleScale,
  });
  if (input.stockFillPrice !== null) state.cycleStartedAt = at;
  state.impliedVolatilityByLegId.set(opened.callLegId, call.impliedVolatility);
  const mid = (call.bid + call.ask) / 2;
  context.priceByLegId.set(opened.callLegId, mid * priceToCycleScale);
  context.priceByLegId.set(opened.stockLegId, stockPrice * priceToCycleScale);
  if (opened.leftoverPositionId !== null) for (const leg of legsOfPosition(ledger, opened.leftoverPositionId)) context.priceByLegId.set(leg.id, stockPrice * priceToCycleScale);
  const contractLabel = describeOptionContract({ strike: call.strike, right: "C", expiry: call.expiry, dte: call.dte });
  const sharesNote = input.stockFillPrice === null ? " on held shares" : ` with ${contracts * sharesPerContract} shares bought @ ${input.stockFillPrice.toFixed(2)}`;
  const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, call.fillPrice)}${sharesNote} (delta ${Math.abs(call.delta).toFixed(2)}, IV ${percent(call.impliedVolatility)}, premium yield ${percent(call.premiumYield)})`;
  input.actions.push({
    actionId,
    tradingDate: todayIso,
    at: at.toISOString(),
    lookTimeEt: captureLookTimeEt,
    passNumber: 1,
    symbol,
    kind: "open_covered_call",
    candidateId: openCandidateId(symbol, { strategyKey: "covered_call", expiry: call.expiry, strike: call.strike }),
    description,
    automatic: false,
    chosenBecause: `vol farmer: ${input.why}`,
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer", ok: true, detail: `${contracts} contract(s): volume allows ${call.volumeCap}` }],
    contract: { strategyKey: "covered_call", expiry: call.expiry, strike: call.strike, right: "C" },
    candidateScores: { premiumYield: call.premiumYield, delta: call.delta, impliedVolatility: call.impliedVolatility, timeValue: call.timeValue, dte: call.dte, bid: call.bid, ask: call.ask, volumeCap: call.volumeCap, stockPrice },
    quantity: contracts,
    limitPrice: call.fillPrice,
    fillPrice: call.fillPrice,
    positionIds: [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])],
  });
  input.optionSales.push({
    legId: opened.callLegId,
    actionId,
    symbol,
    openedOn: todayIso,
    strategyKey: "covered_call",
    expiry: call.expiry,
    strike: call.strike,
    optionRight: "C",
    contracts,
    bid: call.bid,
    ask: call.ask,
    fillPrice: call.fillPrice,
    commissionDollars: optionCommissionDollars(contracts),
    spotAtOpen: stockPrice,
    sharePriceAtOpen: stockPrice,
    exposureDollars: ledgerCapitalAtRisk(ledger, opened.positionId) ?? (stockPrice - call.fillPrice) * sharesPerContract * contracts,
    dte: call.dte,
    delta: call.delta,
    grade: null,
    edgeMargin: null,
    expectedPnlDollars: null,
    calibratedExpectedPnlDollars: null,
    edgeYield: null,
    histYield: null,
    kellyContracts: null,
    stressContracts: null,
    priceToCycleScale,
  });
  return description;
}

/** Buys a hedge Put: with a Call (its surplus at the Call's strike), or with none (callStrike and surplus null: hedgeWithoutCall). */
function buyPut(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; at: Date; priceToCycleScale: number; actions: BacktestAction[]; put: VolFarmerPutCandidate; contracts: number; surplus: number | null; protection: number; callStrike: number | null; sharesPerContractOnCycleScale: number; minProtectionPct?: number; afterCashIn?: boolean }): string {
  const { context, lookSymbol, at, priceToCycleScale, put, contracts } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const actionId = context.nextActionId();
  const opened = buyHedgePut(ledger, { symbol, expiryDate: put.expiry, strike: put.strike * priceToCycleScale, contracts, fillPrice: put.fillPrice * priceToCycleScale, at, actionId, sharesPerContract: input.sharesPerContractOnCycleScale });
  stateOf(ledger, symbol).impliedVolatilityByLegId.set(opened.legId, put.impliedVolatility);
  context.priceByLegId.set(opened.legId, ((put.bid + put.ask) / 2) * priceToCycleScale);
  const dte = daysToExpiry(put.expiry, todayIso);
  const contractLabel = describeOptionContract({ strike: put.strike, right: "P", expiry: put.expiry, dte });
  const farmer = context.settings.volFarmer;
  const withCall = input.callStrike !== null && input.surplus !== null;
  const strikeNote = withCall ? `; at the ${input.callStrike} strike the shares and the Put make ${input.surplus! >= 0 ? "+" : "−"}${Math.abs(input.surplus!).toFixed(2)} a share` : "; no Call qualifies, the shares stay hedged";
  const cheapestPerYear = farmer.putChoice === "cheapest_per_year";
  const costPerYear = volFarmerPutCostPerYear(put, stockPrice);
  const description = `${symbol} Buy ${contractLabel}${describeOrderSize(contracts, put.fillPrice)} (hedge: IV ${percent(put.impliedVolatility)}; offsets ${percent(input.protection)} of a ${farmer.protectionFallPct}% fall${cheapestPerYear ? `; costs ${percent(costPerYear)} a year` : ""}${strikeNote})`;
  const choiceNote = cheapestPerYear ? `of those offering at least ${input.minProtectionPct ?? farmer.minPutProtectionPct}% protection, the cheapest per year` : "the most protection";
  const keepsAPut = input.afterCashIn ? "the lots a cash-in left without a Put keep one" : "shares with no Call that qualifies keep a Put";
  const chosenBecause = withCall ? `vol farmer: of the Puts that pass the hedge rule, ${choiceNote}` : farmer.hedgeWithoutCall === "cheapest_per_year" ? `vol farmer: ${keepsAPut}: ${choiceNote}` : `vol farmer: ${keepsAPut} (the strike cap, the nearest expiry 7 or more days out)`;
  input.actions.push({
    actionId,
    tradingDate: todayIso,
    at: at.toISOString(),
    lookTimeEt: captureLookTimeEt,
    passNumber: 1,
    symbol,
    kind: "buy_hedge",
    candidateId: `${symbol}:hedge:${put.expiry}:${roundedStrike(put.strike)}`,
    description,
    automatic: false,
    chosenBecause,
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer", ok: true, detail: `${contracts} contract(s)` }],
    contract: { strategyKey: "hedge", expiry: put.expiry, strike: put.strike, right: "P" },
    candidateScores: { bid: put.bid, ask: put.ask, dte, sessionsHeld: put.sessionsHeld, stockPrice, impliedVolatility: put.impliedVolatility, protection: input.protection, hedgeSurplusPerShare: input.surplus, costDollars: put.fillPrice * sharesPerContract * contracts + optionCommissionDollars(contracts), halfSpreadDollars: ((put.ask - put.bid) / 2) * sharesPerContract * contracts, ...(cheapestPerYear ? { costPerYear } : {}) },
    quantity: contracts,
    limitPrice: put.fillPrice,
    fillPrice: put.fillPrice,
    positionIds: [opened.positionId],
  });
  return description;
}

/** Shares the look hedges with no Call: `minProtectionPct` the protection asked of the Put ("cheapest_per_year"), `afterCashIn` the lots a cash-in left without one. */
type HedgeWithoutCallInput = { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; farmer: BacktestVolFarmerSettings; at: Date; priceToCycleScale: number; actions: BacktestAction[]; sharesHeld: number; minProtectionPct: number; afterCashIn: boolean };

/**
 * Shares held with no Put and no Call sold at the look (hedgeWithoutCall "put"): the Put at the highest strike up to
 * S × (1 + putMaxStrikeAbovePricePct ÷ 100) of the nearest listed expiry 7 or more days out (spread and bid as every Put's),
 * on as many lots as held and the free cash pays for. Returns its summary, or why none was bought.
 */
function hedgeWithoutCall(input: HedgeWithoutCallInput): string {
  const { context, lookSymbol, farmer, at, priceToCycleScale } = input;
  if (farmer.hedgeWithoutCall === "cheapest_per_year") return hedgeWithoutCallByPutChoice(input);
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const putSource = lookSymbol.hedgePutQuotes;
  if (!putSource) return `${symbol}: no Put quotes to hedge the shares`;
  const expiry = putSource.listedExpiries().find((listed) => daysToExpiry(listed, context.todayIso) >= 7);
  if (expiry === undefined) return `${symbol}: no Put expiry 7 or more days out to hedge the shares`;
  const maxPutStrike = stockPrice * (1 + farmer.putMaxStrikeAbovePricePct / 100) + 1e-9;
  const quote = putSource
    .quotesOf(expiry)
    .filter((candidate) => candidate.right === "P" && candidate.strike <= maxPutStrike && baselineQuoteRejection(candidate, farmer.maxSpreadPctOfMid) === null)
    .reduce<SymbolFileQuote | null>((highest, candidate) => (highest === null || candidate.strike > highest.strike ? candidate : highest), null);
  if (quote === null) return `${symbol}: no usable Put quote of ${expiry} to hedge the shares`;
  const yearsToExpiry = yearsToExpiryFrom(at.getTime(), expiry);
  const impliedVolatility = impliedVolatilityFromPrice((quote.bid! + quote.ask!) / 2, stockPrice * Math.exp(riskFreeRate * yearsToExpiry), quote.strike, yearsToExpiry, riskFreeRate, false);
  if (impliedVolatility === null) return `${symbol}: no implied volatility for the Put to hedge the shares`;
  const fillPrice = optionPurchaseFillPrice(quote.bid!, quote.ask!, context.settings.trading.spreadCostChargedPct / 100);
  const lotsHeld = Math.floor(input.sharesHeld / sharesPerContract + 1e-9);
  const affordableLots = Math.floor(ledgerFreeCash(context.ledger) / (fillPrice * sharesPerContract + optionCommissionDollars(1)) + 1e-9);
  const contracts = Math.min(lotsHeld, affordableLots);
  if (contracts < 1) return `${symbol}: the free cash pays for no Put to hedge the shares`;
  const put: VolFarmerPutCandidate = { expiry, dte: daysToExpiry(expiry, context.todayIso), sessionsHeld: context.calendar.sessionsHeld(context.todayIso, expiry), strike: quote.strike, bid: quote.bid!, ask: quote.ask!, fillPrice, impliedVolatility };
  const protection = volFarmerProtection({ stockPrice, fallFraction: farmer.protectionFallPct / 100, put: { strike: put.strike, costPerShare: fillPrice + putSaleCommissionPerShare, impliedVolatility, yearsLeftAtCallExpiry: 0 }, riskFreeRate });
  return buyPut({ ...input, put, contracts, surplus: null, protection, callStrike: null, sharesPerContractOnCycleScale: Math.round(sharesPerContract / priceToCycleScale) });
}

/**
 * hedgeWithoutCall "cheapest_per_year": shares held with no Put and no Call sold at the look (above all, once the Put has
 * expired): the Put the putChoice rule takes among the Puts tried, with no hedge rule (there is no Call) and protection
 * measured to the next listed Call expiry, on as many lots as held and the free cash pays for. Returns its summary, or
 * why none was bought.
 */
function hedgeWithoutCallByPutChoice(input: HedgeWithoutCallInput): string {
  const { context, lookSymbol, farmer, at, priceToCycleScale, minProtectionPct } = input;
  const { todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const nextCallExpiry = lookSymbol.market.quotes.reduce<string | null>((next, quote) => (quote.right === "C" && quote.expiry > todayIso && (next === null || quote.expiry < next) ? quote.expiry : next), null);
  if (nextCallExpiry === null) return `${symbol}: no Call expiry listed to measure a Put's protection at`;
  const puts = volFarmerPutCandidates({ lookSymbol, farmer, callExpiries: [nextCallExpiry], todayIso, at, spreadShareCharged: context.settings.trading.spreadCostChargedPct / 100, sessionsHeldTo: (expiry) => context.calendar.sessionsHeld(todayIso, expiry) });
  if (typeof puts === "string") return puts;
  const chosen = chooseVolFarmerPut({ puts, callStrike: null, callExpiry: nextCallExpiry, shareCostPerShare: 0, realizedHedgePnlPerShare: 0, stockPrice, fallFraction: farmer.protectionFallPct / 100, riskFreeRate, minProtection: minProtectionPct / 100, choice: farmer.putChoice });
  if (chosen === null) return `${symbol}: no Put ${minProtectionPct > 0 ? `offers ${minProtectionPct}% protection` : "qualifies"} to hedge the shares`;
  const lotsHeld = Math.floor(input.sharesHeld / sharesPerContract + 1e-9);
  const affordableLots = Math.floor(ledgerFreeCash(context.ledger) / (chosen.put.fillPrice * sharesPerContract + optionCommissionDollars(1)) + 1e-9);
  const contracts = Math.min(lotsHeld, affordableLots);
  if (contracts < 1) return `${symbol}: the free cash pays for no Put to hedge the shares`;
  return buyPut({ ...input, put: chosen.put, contracts, surplus: null, protection: chosen.protection, callStrike: null, sharesPerContractOnCycleScale: Math.round(sharesPerContract / priceToCycleScale) });
}

function describeRejections(rejections: BaselineRejections): string {
  const parts = Object.entries(rejections as unknown as Record<string, number>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`);
  return parts.length === 0 ? "no Call quoted" : parts.join(", ");
}
