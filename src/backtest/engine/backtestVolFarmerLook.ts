import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesPriceOnForward, impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction, BacktestVolFarmerSettings } from "../backtestTypes.js";
import type { FileIntradayBarPrices } from "../backtestFileStockBars.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestLookSymbol, BacktestOptionSale } from "./backtestLook.js";
import { captureLookTimeEt, lookInstantMs } from "./backtestTickerInputs.js";
import { baselineQuoteRejection, noteBaselineForwardAnchors, roundedStrike, selectBaselineCandidates, type BaselineCandidate, type BaselineCommissions, type BaselineForwardAnchor, type BaselineRejections } from "./baselineSaleSteps.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buyHedgePut, closeCoveredCall, expirySettlementInstant, openCoveredCall, sellHedgePut, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerOpenHedgeLegs, ledgerRealizedPnl } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

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
//   maxPutCostPctOfCallPremium   > 0: a Put passes only when its fill ≤ the Call's fill × this ÷ 100 (100 = a zero-cost collar)
//   putRoll "when_no_call"        step 2 with Puts held and no Call that passes with them: selling them at the fill rule
//                                would realize (fill − entry) × 100 × contracts − commission; with that added to the
//                                cycle's realized P&L and the sale's cash free, step 2's choice of a Call with a new Put
//                                runs; when it finds one, the Puts are sold, the Call sold and the new Put bought (a roll)

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
  /** The cash check (describeVolFarmerCash). */
  cash: { laterPutPurchases: number; shortPurchases: number; firstShort: { dateIso: string; lotsPaid: number; lotsHeld: number } | null; lowestFreeCash: number | null; callSales: number; callSalesShortOfVolume: number };
}

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, VolFarmerSymbolState>>();

function stateOf(ledger: SimulatedLedger, symbol: string): VolFarmerSymbolState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  let state = bySymbol.get(symbol);
  if (!state) bySymbol.set(symbol, (state = { impliedVolatilityByLegId: new Map(), scannedThroughMs: 0, unwoundOn: null, cycleStartedAt: null, cash: { laterPutPurchases: 0, shortPurchases: 0, firstShort: null, lowestFreeCash: null, callSales: 0, callSalesShortOfVolume: 0 } }));
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
  strike: number;
  bid: number;
  ask: number;
  fillPrice: number;
  impliedVolatility: number;
}

/** Of the Puts expiring on or after the Call, the one that passes the hedge rule with the most protection (a tie: the cheaper); null when none passes. */
export function chooseVolFarmerPut(input: {
  puts: readonly VolFarmerPutCandidate[];
  callStrike: number;
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
}): { put: VolFarmerPutCandidate; surplus: number; protection: number } | null {
  let best: { put: VolFarmerPutCandidate; surplus: number; protection: number; costPerShare: number } | null = null;
  for (const put of input.puts) {
    if (put.expiry < input.callExpiry || (input.sameExpiry && put.expiry !== input.callExpiry) || (input.maxFillPrice !== undefined && put.fillPrice > input.maxFillPrice + 1e-9)) continue;
    const terms: VolFarmerPutTerms = { strike: put.strike, costPerShare: put.fillPrice + putSaleCommissionPerShare, impliedVolatility: put.impliedVolatility, yearsLeftAtCallExpiry: yearsBetweenExpiries(input.callExpiry, put.expiry) };
    const surplus = volFarmerHedgeSurplus({ callStrike: input.callStrike, shareCostPerShare: input.shareCostPerShare, put: terms, realizedHedgePnlPerShare: input.realizedHedgePnlPerShare, riskFreeRate: input.riskFreeRate });
    if (surplus < 0) continue;
    const protection = volFarmerProtection({ stockPrice: input.stockPrice, fallFraction: input.fallFraction, put: terms, riskFreeRate: input.riskFreeRate });
    if ((input.minProtection ?? 0) > 0 && protection < input.minProtection! - 1e-12) continue;
    if (best === null || protection > best.protection + 1e-12 || (Math.abs(protection - best.protection) <= 1e-12 && terms.costPerShare < best.costPerShare)) best = { put, surplus, protection, costPerShare: terms.costPerShare };
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
  if (!callLeg) return null;
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
  const actionId = scan.nextActionId();
  const summaries: string[] = [];
  const actions: BacktestAction[] = [];
  const modelValueOf = (leg: LedgerLeg) => {
    const impliedVolatility = state.impliedVolatilityByLegId.get(leg.id);
    if (impliedVolatility === undefined) throw new Error(`${symbol}: the Vol Farmer has no implied volatility for leg ${leg.id} to price it at the crossing.`);
    return volFarmerOptionValue({ isCall: leg.optionType === "call", stockPrice, strike: leg.strikePrice! / priceToCycleScale, yearsToExpiry: yearsToExpiryFrom(at.getTime(), leg.expiryDate!), riskFreeRate: scan.riskFreeRate, impliedVolatility });
  };
  const callContract = describeOptionContract({ strike: strikeToday, right: "C", expiry: callLeg.expiryDate!, dte: daysToExpiry(callLeg.expiryDate!, todayIso) });
  const howReached = crossing.gapped ? `opened at ${stockPrice.toFixed(2)}, past the strike` : `reached ${strikeToday.toFixed(2)}`;

  // The Covered Call: the Call bought back and its shares sold.
  const callBuyback = modelValueOf(callLeg);
  const callPositionId = callLeg.positionId;
  const callPremiumToday = callLeg.entryPrice / priceToCycleScale;
  const callContracts = callLeg.quantity;
  closeCoveredCall(ledger, { positionId: callPositionId, callFillPrice: callBuyback * priceToCycleScale, stockFillPrice: stockPrice * priceToCycleScale, at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
  const coveredShares = Math.round(callContracts * callLeg.multiplier * priceToCycleScale);
  const callDescription = `${symbol} Buy back ${callContract}${describeOrderSize(callContracts, callBuyback)} and sell ${coveredShares} shares @ ${stockPrice.toFixed(2)} (the stock ${howReached} in the ${clockTime(crossing.bar.startMinutesEt)} bar; sold at ${callPremiumToday.toFixed(2)}, Call ${callBuyback <= callPremiumToday ? "gain" : "loss"} ${formatWholeDollars(Math.abs(callPremiumToday - callBuyback) * callContracts * sharesPerContract)})`;
  actions.push(crossingAction({ actionId, symbol, todayIso, at, lookTimeEt: crossingEt, kind: "close_position", description: callDescription, contract: { strategyKey: "covered_call", expiry: callLeg.expiryDate!, strike: strikeToday, right: "C" }, quantity: callContracts, fillPrice: callBuyback, positionIds: [callPositionId], scores: { stockPrice, callStrike: strikeToday, callBuyback, callPremium: callPremiumToday, impliedVolatility: state.impliedVolatilityByLegId.get(callLeg.id) ?? null, gapped: crossing.gapped ? 1 : 0 } }));
  summaries.push(callDescription);

  // Shares no Call covered.
  for (const leg of openLegsOfSymbol(ledger, symbol).filter(isStock)) {
    const sharesActionId = scan.nextActionId();
    sellShares(ledger, { positionId: leg.positionId, shares: leg.quantity, fillPrice: stockPrice * priceToCycleScale, at, actionId: sharesActionId, tradedSharesPerLedgerShare: priceToCycleScale });
    const sharesToday = Math.round(leg.quantity * priceToCycleScale);
    const description = `${symbol} Sell ${sharesToday} uncovered shares @ ${stockPrice.toFixed(2)} (unwound with the Covered Call)`;
    actions.push(crossingAction({ actionId: sharesActionId, symbol, todayIso, at, lookTimeEt: crossingEt, kind: "close_shares", description, contract: null, quantity: sharesToday, fillPrice: stockPrice, positionIds: [leg.positionId], scores: { stockPrice } }));
    summaries.push(description);
  }

  // The Puts.
  for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
    const putActionId = scan.nextActionId();
    const putValue = modelValueOf(leg);
    const positionId = leg.positionId;
    const entryToday = leg.entryPrice / priceToCycleScale;
    const contracts = leg.quantity;
    sellHedgePut(ledger, { legId: leg.id, contracts, fillPrice: putValue * priceToCycleScale, at, actionId: putActionId });
    const realized = (putValue - entryToday) * contracts * sharesPerContract - optionCommissionDollars(contracts);
    const putContract = describeOptionContract({ strike: roundedStrike(leg.strikePrice! / priceToCycleScale), right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) });
    const description = `${symbol} Sell ${putContract}${describeOrderSize(contracts, putValue)} (hedge, unwound with the Covered Call; bought at ${entryToday.toFixed(2)} with its commission, ${realized >= 0 ? "gain" : "loss"} ${formatWholeDollars(Math.abs(realized))})`;
    actions.push(crossingAction({ actionId: putActionId, symbol, todayIso, at, lookTimeEt: crossingEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike: roundedStrike(leg.strikePrice! / priceToCycleScale), right: "P" }, quantity: contracts, fillPrice: putValue, positionIds: [positionId], scores: { stockPrice, entryPrice: entryToday, realizedPnlDollars: realized, impliedVolatility: state.impliedVolatilityByLegId.get(leg.id) ?? null } }));
    summaries.push(description);
  }
  for (const leg of ledger.legs) if (leg.exitAt !== null) state.impliedVolatilityByLegId.delete(leg.id);
  state.unwoundOn = todayIso;
  state.cycleStartedAt = null;
  return { actions, summary: `Unwound at the crossing: ${summaries.join(" · ")}`, lookTimeEt: crossingEt };
}

function crossingAction(input: {
  /** The candidate id's kind: "vol_farmer_unwind" for a crossing's orders (the cycle detail finds crossings by it), "vol_farmer_sale" for the other sales. */
  candidateKind?: "vol_farmer_unwind" | "vol_farmer_sale";
  actionId: string;
  symbol: string;
  todayIso: string;
  at: Date;
  lookTimeEt: string;
  kind: "close_position" | "close_shares" | "sell_hedge";
  description: string;
  contract: BacktestAction["contract"];
  quantity: number;
  fillPrice: number;
  positionIds: string[];
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
    chosenBecause: "vol farmer: the stock reached the Call's strike; the whole position is unwound at Black-Scholes values (perfect limit orders)",
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
    if (lookTimeEt !== captureLookTimeEt) continue;
    const opened = openSymbol({ context, lookSymbol, farmer, at, priceToCycleScale, actions, optionSales });
    if (opened !== null) summaries.push(opened);
    const cash = stateOf(ledger, symbol).cash;
    cash.lowestFreeCash = Math.min(cash.lowestFreeCash ?? Number.POSITIVE_INFINITY, ledgerFreeCash(ledger));
  }

  const summary = summaries.length === 0 ? "No action" : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
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
    return sold.length > 0 ? sold.join(" · ") : `${symbol}: hedge Puts held without shares, no quote to sell them at`;
  }
  if (openLegs.some(isShortCall)) return null;
  if (sharesHeldToday === 0 && state.unwoundOn === todayIso) return `${symbol}: unwound today, the next cycle starts at the next day's 10:00 look`;
  if (!lookSymbol.optionContractsRepresentable) return `${symbol}: no option orders while the open cycle spans a split`;
  // Shares held with no Put and no Call sold (hedgeWithoutCall "put"): a Put keeps them hedged.
  const unhedgedNote = (message: string) => (sharesHeldToday > 0 && hedgeLegs.length === 0 && farmer.hedgeWithoutCall === "put" ? `${message} · ${hedgeWithoutCall({ ...input, sharesHeld: sharesHeldToday })}` : message);

  const quotes = lookSymbol.market.quotes;
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
    settings: { minAbsDelta: farmer.callMinAbsDelta, maxAbsDelta: farmer.callMaxAbsDelta, minDte: farmer.callMinDte, maxDte: farmer.callMaxDte, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid },
    spreadShareCharged: context.settings.trading.spreadCostChargedPct / 100,
    isHeld: () => false,
  });
  const calls = candidates.filter((candidate) => candidate.strike > stockPrice);
  if (calls.length === 0) return unhedgedNote(`${symbol}: no Call within the rules (${describeRejections(rejections)})`);
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;

  // The cycle's shares: what they cost (step 2), or S with the commission (step 1).
  const shareCostToday = sharesHeldToday > 0 ? stockLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity, 0) / stockLegs.reduce((sum, leg) => sum + leg.quantity, 0) / priceToCycleScale : stockPrice + stockCommissionDollars(1);
  const cyclePositions = state.cycleStartedAt === null ? [] : positionsOfSymbol(ledger, symbol).filter((position) => position.openedAt >= state.cycleStartedAt!);
  const cycleHedgeRealized = cyclePositions.filter((position) => position.strategyKey === "hedge" && position.status === "closed").reduce((sum, position) => sum + ledgerRealizedPnl(ledger, position.id).total, 0);
  const cycleCallRealized = farmer.hedgeRuleCallPremiums === "included" ? cyclePositions.filter((position) => position.strategyKey === "covered_call").reduce((sum, position) => sum + ledgerRealizedPnl(ledger, position.id).premium, 0) : 0;
  const realizedPerShare = sharesHeldToday > 0 ? (cycleHedgeRealized + cycleCallRealized) / sharesHeldToday : 0;
  const lotsHeld = Math.floor(sharesHeldToday / sharesPerContract + 1e-9);
  const breakEvenNote = sharesHeldToday > 0 ? `shares at ${shareCostToday.toFixed(2)}${cycleHedgeRealized !== 0 ? `, the cycle's expired Puts ${cycleHedgeRealized >= 0 ? "+" : "−"}${formatWholeDollars(Math.abs(cycleHedgeRealized))}` : ""}${cycleCallRealized !== 0 ? `, its Calls ${cycleCallRealized >= 0 ? "+" : "−"}${formatWholeDollars(Math.abs(cycleCallRealized))}` : ""}` : null;

  // A Put still held: the Call must pass the hedge rule with it, and expire on or before it.
  if (hedgeLegs.length > 0) {
    const putLeg = hedgeLegs[0]!;
    const putStrike = putLeg.strikePrice! / priceToCycleScale;
    const putImpliedVolatility = state.impliedVolatilityByLegId.get(putLeg.id);
    if (putImpliedVolatility === undefined) return `${symbol}: the hedge Put has no implied volatility yet; no Call sold`;
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
        const rolled = rollPutForCall({ ...input, calls, hedgeLegs, shareCostPerShare: shareCostToday, cycleRealized: cycleHedgeRealized + cycleCallRealized, sharesHeld: sharesHeldToday, lotsHeld, breakEvenNote, spreadShareCharged, sharesPerContractOnCycleScale });
        if (rolled !== null) return rolled;
      }
      return `${symbol}: no Call passes the hedge rule with the Put held and expires by it (${breakEvenNote})`;
    }
    const contracts = Math.min(lotsWanted, pick.call.volumeCap);
    if (contracts < 1) return `${symbol}: no Call sold: the volume limit allows none`;
    const coverage = contracts < lotsWanted ? `no Call's volume covers all ${lotsWanted} lots, this one covers the most` : "its volume covers every lot";
    noteCallSale(state, contracts < lotsWanted);
    const sold = sellCall({ ...input, call: pick.call, contracts, stockFillPrice: null, why: `the highest premium yield whose strike passes the hedge rule with the Put held, ${coverage} (${breakEvenNote}; surplus at the strike ${pick.surplus.toFixed(2)} a share)`, sharesPerContractOnCycleScale });
    return `${sold}${sellLotsLeftOut({ ...input, lotsHeld, lotsCovered: contracts })}`;
  }

  // A new Put with the Call. A cycle's first keeps putCashReservePct of the free cash for the later Puts; a later one
  // spends all of it.
  const putChoice = volFarmerPutCandidates({ lookSymbol, farmer, calls, todayIso, at, spreadShareCharged });
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
    return unhedgedNote(`${symbol}: no Call has a Put that passes the hedge rule (${calls.length} Call(s), ${putCandidates.length} Put(s) tried${breakEvenNote ? `; ${breakEvenNote}` : ""})`);
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

/** The Puts a new hedge is chosen from (the "Puts tried" above), or why there are none. */
function volFarmerPutCandidates(input: { lookSymbol: BacktestLookSymbol; farmer: BacktestVolFarmerSettings; calls: readonly BaselineCandidate[]; todayIso: string; at: Date; spreadShareCharged: number }): VolFarmerPutCandidate[] | string {
  const { lookSymbol, farmer, calls, todayIso, at } = input;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const putSource = lookSymbol.hedgePutQuotes;
  if (!putSource) return `${symbol}: no Put quotes`;
  const maxPutStrike = stockPrice * (1 + farmer.putMaxStrikeAbovePricePct / 100) + 1e-9;
  const putCandidates: VolFarmerPutCandidate[] = [];
  const shortestCallExpiry = calls.reduce((earliest, call) => (call.expiry < earliest ? call.expiry : earliest), calls[0]!.expiry);
  const withTheCall = farmer.putExpiry === "with_the_call";
  const callExpiries = new Set(calls.map((call) => call.expiry));
  for (const expiry of putSource.listedExpiries()) {
    const putDte = daysToExpiry(expiry, todayIso);
    if (withTheCall ? !callExpiries.has(expiry) : expiry < shortestCallExpiry || putDte < farmer.putMinDte || putDte > farmer.putMaxDte) continue;
    const yearsToExpiry = yearsToExpiryFrom(at.getTime(), expiry);
    for (const quote of putSource.quotesOf(expiry)) {
      if (quote.right !== "P" || quote.strike > maxPutStrike || baselineQuoteRejection(quote, farmer.maxSpreadPctOfMid) !== null) continue;
      const mid = (quote.bid! + quote.ask!) / 2;
      const impliedVolatility = impliedVolatilityFromPrice(mid, stockPrice * Math.exp(riskFreeRate * yearsToExpiry), quote.strike, yearsToExpiry, riskFreeRate, false);
      if (impliedVolatility === null) continue;
      putCandidates.push({ expiry, strike: quote.strike, bid: quote.bid!, ask: quote.ask!, fillPrice: optionPurchaseFillPrice(quote.bid!, quote.ask!, input.spreadShareCharged), impliedVolatility });
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
    const chosen = chooseVolFarmerPut({ puts: input.putCandidates, callStrike: call.strike, callExpiry: call.expiry, shareCostPerShare: input.shareCostPerShare, realizedHedgePnlPerShare: input.realizedPerShare, stockPrice, fallFraction: farmer.protectionFallPct / 100, riskFreeRate: input.riskFreeRate, sameExpiry: farmer.putExpiry === "with_the_call", minProtection: farmer.minPutProtectionPct / 100, maxFillPrice: farmer.maxPutCostPctOfCallPremium > 0 ? (call.fillPrice * farmer.maxPutCostPctOfCallPremium) / 100 : undefined });
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
}): string | null {
  const { context, lookSymbol, farmer, at, priceToCycleScale } = input;
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
  const putCandidates = volFarmerPutCandidates({ lookSymbol, farmer, calls: input.calls, todayIso, at, spreadShareCharged: input.spreadShareCharged });
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
    const description = `${symbol} Sell ${describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}${describeOrderSize(leg.quantity, fill)} (hedge rolled: what it realizes lets a Call pass the hedge rule)`;
    input.actions.push({ ...crossingAction({ candidateKind: "vol_farmer_sale", actionId, symbol, todayIso, at, lookTimeEt: captureLookTimeEt, kind: "sell_hedge", description, contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" }, quantity: leg.quantity, fillPrice: fill, positionIds: [positionId], scores: { stockPrice, bid: null, ask: null } }), automatic: false, chosenBecause: "vol farmer: no Call passes with the Put held; selling it banks its P&L, and with that a Call passes with a new Put (roll)" });
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
  const callSummary = sellCall({ ...input, call, contracts, stockFillPrice: null, why: `no Call passed with the Put held, so it was rolled: the highest premium yield whose strike some Put passes the hedge rule for with the old Put's P&L banked (${formatWholeDollars(realizedIfSold)})${input.breakEvenNote ? `; ${input.breakEvenNote}` : ""}; hedged by the ${putContract}` });
  const putSummary = buyPut({ ...input, put: chosen.put, contracts, surplus: chosen.surplus, protection: chosen.protection, callStrike: call.strike });
  return `${sold.join(" · ")} · ${callSummary} · ${putSummary}${sellLotsLeftOut({ ...input, lotsCovered: contracts })}`;
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
function buyPut(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; at: Date; priceToCycleScale: number; actions: BacktestAction[]; put: VolFarmerPutCandidate; contracts: number; surplus: number | null; protection: number; callStrike: number | null; sharesPerContractOnCycleScale: number }): string {
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
  const withCall = input.callStrike !== null && input.surplus !== null;
  const strikeNote = withCall ? `; at the ${input.callStrike} strike the shares and the Put make ${input.surplus! >= 0 ? "+" : "−"}${Math.abs(input.surplus!).toFixed(2)} a share` : "; no Call qualifies, the shares stay hedged";
  const description = `${symbol} Buy ${contractLabel}${describeOrderSize(contracts, put.fillPrice)} (hedge: IV ${percent(put.impliedVolatility)}; offsets ${percent(input.protection)} of a ${context.settings.volFarmer.protectionFallPct}% fall${strikeNote})`;
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
    chosenBecause: withCall ? "vol farmer: of the Puts that pass the hedge rule, the most protection" : "vol farmer: shares with no Call that qualifies keep a Put (the strike cap, the nearest expiry 7 or more days out)",
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer", ok: true, detail: `${contracts} contract(s)` }],
    contract: { strategyKey: "hedge", expiry: put.expiry, strike: put.strike, right: "P" },
    candidateScores: { bid: put.bid, ask: put.ask, dte, stockPrice, impliedVolatility: put.impliedVolatility, protection: input.protection, hedgeSurplusPerShare: input.surplus, costDollars: put.fillPrice * sharesPerContract * contracts + optionCommissionDollars(contracts), halfSpreadDollars: ((put.ask - put.bid) / 2) * sharesPerContract * contracts },
    quantity: contracts,
    limitPrice: put.fillPrice,
    fillPrice: put.fillPrice,
    positionIds: [opened.positionId],
  });
  return description;
}

/**
 * Shares held with no Put and no Call sold at the look (hedgeWithoutCall "put"): the Put at the highest strike up to
 * S × (1 + putMaxStrikeAbovePricePct ÷ 100) of the nearest listed expiry 7 or more days out (spread and bid as every Put's),
 * on as many lots as held and the free cash pays for. Returns its summary, or why none was bought.
 */
function hedgeWithoutCall(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; farmer: BacktestVolFarmerSettings; at: Date; priceToCycleScale: number; actions: BacktestAction[]; sharesHeld: number }): string {
  const { context, lookSymbol, farmer, at, priceToCycleScale } = input;
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
  const put: VolFarmerPutCandidate = { expiry, strike: quote.strike, bid: quote.bid!, ask: quote.ask!, fillPrice, impliedVolatility };
  const protection = volFarmerProtection({ stockPrice, fallFraction: farmer.protectionFallPct / 100, put: { strike: put.strike, costPerShare: fillPrice + putSaleCommissionPerShare, impliedVolatility, yearsLeftAtCallExpiry: 0 }, riskFreeRate });
  return buyPut({ ...input, put, contracts, surplus: null, protection, callStrike: null, sharesPerContractOnCycleScale: Math.round(sharesPerContract / priceToCycleScale) });
}

function describeRejections(rejections: BaselineRejections): string {
  const parts = Object.entries(rejections as unknown as Record<string, number>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`);
  return parts.length === 0 ? "no Call quoted" : parts.join(", ");
}
