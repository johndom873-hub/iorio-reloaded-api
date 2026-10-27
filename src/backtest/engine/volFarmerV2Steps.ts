import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesDelta, impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import type { BacktestVolFarmerSettings, BacktestVolFarmerV2Settings } from "../backtestTypes.js";
import type { HedgePutQuoteSource } from "./backtestBaselineHedge.js";
import { sharesPerContract } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { baselineQuoteRejection, describeRejections, roundedStrike, selectBaselineCandidates, type BaselineCandidate, type BaselineCommissions, type BaselineForwardAnchor } from "./baselineSaleSteps.js";
import { optionCommissionDollars as ledgerOptionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice } from "./ledger/ledgerFills.js";

// Vol Farmer v2 (decision maker "vol_farmer_v2", Marcelo 2026-10-27; research): two Covered Calls at different price
// levels and a LEAPS Call, no hedge Put. The steps of one look at one symbol, shared by the backtest
// (backtestVolFarmerV2Look.ts, on the simulated ledger) and Pluto (on the live book): what they read and the orders they
// place go through a VolFarmerV2Book, so the rules exist once. Per symbol (prices as traded today, S the look's stock
// price, P the cycle's pot: the backtest's free cash, Pluto's ticker allocation):
//   1. flat: the first position buys lots = floor(P ÷ 2 ÷ (100 × S + the stock commission)) at S, with a Call sold on them
//      as in 2 (none: no cycle, tried again at the next look).
//   2. Calls: each position holding shares with no Call open sells one on every lot: the Calls of the next listed expiry
//      after today, OTM, inside the Vol Farmer's |delta| range and spread limit (bid ≥ $0.05, volume as the ladder's),
//      struck at or above the position's break-even, in order of premium yield: the first whose volume covers every lot,
//      else the one covering the most. Held to expiry: in the money there, its shares are called away (the session's
//      settlement). Both positions picking the same contract at a look sell it as one order (one position per contract).
//        break-even, first   = what its shares cost (fill plus stock commission) − its Calls' premiums net of
//                              commissions ÷ its shares
//        break-even, second  = the assigned Put's strike − the premiums net of commissions of every Put sold for it and of
//                              its Calls ÷ its shares
//   3. Puts: at a look where the first position holds shares and needed a new Call (none open when the look began; one
//      still open defers the check to its expiry, Marcelo 2026-10-27), the second holds none and has no Put open, and the
//      best Call 2 finds for the first position yields under putsStartCallYieldPct a year (no Call: 0%): the Puts of
//      the same next expiry with |delta| ≤ putMaxAbsDelta, struck ≤ the first break-even × (1 − stepBelowFirstBreak-
//      EvenPct ÷ 100), spread and volume as the Calls', by premium yield; contracts = min(floor(P ÷ 2 ÷ (100 × strike)),
//      floor(free cash ÷ (100 × strike)), the volume limit). Assigned, the Put's shares are the second position.
//   4. LEAPS: the second position holds shares and no Call at or above its break-even passes 2's rules, and it has bought
//      no LEAPS since it holds them: of the Calls of the first listed expiry at least leapsMinDte days out (spread within
//      the limit, bid ≥ $0.05), the one whose |delta| (its own IV, on the forward) is nearest leapsAbsDelta; as many
//      contracts as min(the free cash, leapsMaxAccountPct % of the book's cap base; 0: no cap) pays for (fill +
//      commission): its intended count N, fixed then. The backtest buys no more than its ask offered; tried again at each
//      look until one is bought (strategy "leaps", its own records: buy_leaps, sell_leaps). Bought short of N (the ask's
//      size in the backtest, a partial fill live), it is topped up at the next looks with the same contract, N − held
//      contracts, each top-up no more than the free cash then pays for (and its ask offers, in the backtest), until N are
//      held or the second position is called away (Marcelo 2026-10-27). It is sold whole at the first look after the
//      second position is called away (the session's fill rule); held to its expiry, the session settles it at its
//      intrinsic value.
// The first position's Calls are struck above the second's break-even (step 3's strike rule), so the second is called away
// first or with it; a first position called away with the second's Puts open leaves them to their expiry, the same day.
// When nothing is held, the next cycle starts at the next look (the backtest's next day when it decides at 10:00 only). A
// cycle that spans a split whose contracts do not fit its share scale sells and buys no option until it ends.
//
// Example: P = $100,000 and S = $240: the first position buys floor(50,000 ÷ 24,000.50) = 2 lots (200 shares, $48,001)
// and sells Calls at or above its break-even each week. With its break-even at $236 after a fall to $200, no Call at or
// above $236 yields 5% a year, so Puts are sold struck at most 236 × 0.85 = $200.60: floor(50,000 ÷ 19,500) = 2 contracts
// of the $195 Put.

const percent = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

/** One of the two Covered Calls, on the cycle's scale. */
export interface VolFarmerV2Position {
  /** Shares held; 0 for a second position still selling Puts. */
  shares: number;
  /** What each share cost: the first's fill plus the stock commission, the second's assigned strike. */
  costPerShare: number;
  /** Premiums net of commissions, in dollars: its Calls' and, for the second, every Put's sold for it. */
  premiumDollars: number;
  /** Its open Call and the shares that Call covers (another position's Call can share the leg). */
  call: { legId: string; shares: number } | null;
  /** The second position's open Put and the shares it would deliver. */
  put: { legId: string; shares: number } | null;
}

/** Each LEAPS trigger: what the free cash was against one contract, and what was bought. */
export interface VolFarmerV2LeapsTrigger {
  dateIso: string;
  freeCash: number;
  contractCost: number | null;
  boughtOn: string | null;
  contracts: number;
}

export interface VolFarmerV2SymbolState {
  potDollars: number;
  first: VolFarmerV2Position | null;
  second: VolFarmerV2Position | null;
  /** The LEAPS held: one leg per purchase (the first and its top-ups), all of one contract, and the count intended. */
  leaps: { legIds: string[]; expiry: string; strike: number; intendedContracts: number } | null;
  /** The second position holding shares now has bought its LEAPS (one per holding). */
  leapsBought: boolean;
  /** The second position was called away and a LEAPS is still to be sold. */
  leapsToSell: boolean;
  /** The second position holding shares now: its LEAPS trigger, once one fired. */
  leapsTrigger: VolFarmerV2LeapsTrigger | null;
  /** The cash check (the backtest's describeVolFarmerV2Run). */
  cash: { cycles: number; firstHalfLeft: number[]; secondHalfLeft: number[]; leapsTriggers: VolFarmerV2LeapsTrigger[] };
}

export function newVolFarmerV2SymbolState(): VolFarmerV2SymbolState {
  return { potDollars: 0, first: null, second: null, leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 0, firstHalfLeft: [], secondHalfLeft: [], leapsTriggers: [] } };
}

/** The Step, % below the first break-even, and the IV it came from (null: the fixed Step). */
export interface VolFarmerV2Step {
  stepPct: number;
  impliedVolatility: number | null;
}

/** How many sessions back the implied-move Step looks for IBKR's 30-day IV before falling back to the fixed Step. */
export const stepImpliedVolatilityLookbackSessions = 10;

/** The one-month implied move as the Step: IV × √(21 ÷ 252), in %; the fixed Step without an IV (Marcelo 2026-10-27). */
export function volFarmerV2ImpliedMoveStep(fixedStepPct: number, impliedVolatility: number | null): VolFarmerV2Step {
  return impliedVolatility === null ? { stepPct: fixedStepPct, impliedVolatility: null } : { stepPct: impliedVolatility * Math.sqrt(21 / 252) * 100, impliedVolatility };
}

/** What a LEAPS purchase may spend (Marcelo 2026-10-27): the free cash, no more than the cap's share of the cap base. */
export function volFarmerV2LeapsBudget(freeCash: number, capBaseDollars: number, leapsMaxAccountPct: number): number {
  return leapsMaxAccountPct > 0 ? Math.min(freeCash, capBaseDollars * (leapsMaxAccountPct / 100)) : freeCash;
}

/** A position's break-even per share, on the cycle's scale; null without shares. */
export function volFarmerV2BreakEven(position: Pick<VolFarmerV2Position, "shares" | "costPerShare" | "premiumDollars">): number | null {
  return position.shares > 0 ? position.costPerShare - position.premiumDollars / position.shares : null;
}

/** The highest strike step 3 sells a Put at, as traded today: the first break-even × (1 − pct ÷ 100). */
export function volFarmerV2PutStrikeCap(firstBreakEvenAsTraded: number, stepBelowFirstBreakEvenPct: number): number {
  return firstBreakEvenAsTraded * (1 - stepBelowFirstBreakEvenPct / 100);
}

/** The most contracts `cashDollars` pays for at `fillPrice` a share, commission included. */
export function contractsAffordable(cashDollars: number, fillPrice: number, optionCommissionDollars: (contracts: number) => number = ledgerOptionCommissionDollars): number {
  let contracts = Math.floor(cashDollars / (fillPrice * sharesPerContract + optionCommissionDollars(1)));
  while (contracts > 0 && contracts * fillPrice * sharesPerContract + optionCommissionDollars(contracts) > cashDollars + 1e-9) contracts -= 1;
  return Math.max(0, contracts);
}

/** A LEAPS the look may buy: the Call nearest the |delta| asked of the first listed expiry far enough out, with the contracts its ask offered. */
export function chooseVolFarmerV2Leaps(input: { quotes: readonly { expiry: string; strike: number; right: "C" | "P"; bid: number | null; ask: number | null; askSize: number | null }[]; expiry: string; stockPrice: number; yearsToExpiry: number; riskFreeRate: number; absDelta: number; maxSpreadPctOfMid: number; spreadShareCharged: number }): { strike: number; bid: number; ask: number; askSize: number | null; fillPrice: number; delta: number; impliedVolatility: number } | null {
  const forward = input.stockPrice * Math.exp(input.riskFreeRate * input.yearsToExpiry);
  let best: { strike: number; bid: number; ask: number; askSize: number | null; fillPrice: number; delta: number; impliedVolatility: number } | null = null;
  for (const quote of input.quotes) {
    if (quote.right !== "C" || quote.expiry !== input.expiry || baselineQuoteRejection(quote, input.maxSpreadPctOfMid) !== null) continue;
    const mid = (quote.bid! + quote.ask!) / 2;
    const impliedVolatility = impliedVolatilityFromPrice(mid, forward, quote.strike, input.yearsToExpiry, input.riskFreeRate, true);
    if (impliedVolatility === null) continue;
    const delta = blackScholesDelta(forward, quote.strike, input.yearsToExpiry, input.riskFreeRate, impliedVolatility, true);
    if (best === null || Math.abs(delta - input.absDelta) < Math.abs(best.delta - input.absDelta) - 1e-12) best = { strike: quote.strike, bid: quote.bid!, ask: quote.ask!, askSize: quote.askSize, fillPrice: optionPurchaseFillPrice(quote.bid!, quote.ask!, input.spreadShareCharged), delta, impliedVolatility };
  }
  return best;
}

/** What one look knows of one symbol's market, as traded today, and how its book's records scale. */
export interface VolFarmerV2Market {
  symbol: string;
  todayIso: string;
  stockPrice: number;
  /** As a fraction. */
  riskFreeRate: number;
  quotes: readonly SymbolFileQuote[];
  forwardAnchors: ReadonlyMap<string, BaselineForwardAnchor>;
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** Years from the look to today's close: a same-day expiry's time. */
  yearsToTodaysClose: number;
  /** Years from the look to an expiry's settlement: the LEAPS' time. */
  yearsToExpiry(expiry: string): number;
  /** The long-dated Calls the LEAPS is chosen from; absent when none are quoted at this look. */
  leapsCallQuotes: HedgePutQuoteSource | undefined;
  /** IBKR's 30-day IV the implied-move Step reads; null when none is recent enough. */
  stepImpliedVolatility(): number | null;
  /** r: the book's prices ÷ this are the prices as traded today (1 unless a split fell inside the open cycle). */
  priceToCycleScale: number;
  /** False when the open cycle spans a split whose contracts do not fit its share scale. */
  optionContractsRepresentable: boolean;
  /** The share of the half-spread a fill pays (0: the mid). */
  spreadShareCharged: number;
  /** The rates the candidates are ranked with. */
  commissions: BaselineCommissions;
  /** The commissions the book charges. */
  optionCommissionDollars(contracts: number): number;
  stockCommissionDollars(shares: number): number;
  /** What the LEAPS cap is a share of, as its note names it ("the account"). */
  leapsCapBaseLabel: string;
  /** The backtest buys a LEAPS no larger than its ask's size; live, the order fills what the market offers. */
  capsLeapsAtAskSize: boolean;
}

/** A Call the look sells: on held shares, or with the shares a new cycle buys. */
export interface VolFarmerV2CallSale {
  candidate: BaselineCandidate;
  contracts: number;
  /** A new cycle: the shares are bought with the Call, at the look's stock price. */
  startsCycle: boolean;
  description: string;
  chosenBecause: string;
  candidateScores: Record<string, number | null>;
}

export interface VolFarmerV2PutSale {
  candidate: BaselineCandidate;
  contracts: number;
  description: string;
  chosenBecause: string;
  candidateScores: Record<string, number | null>;
}

export interface VolFarmerV2LeapsPurchase {
  expiry: string;
  strike: number;
  bid: number;
  ask: number;
  fillPrice: number;
  contracts: number;
  description: string;
  chosenBecause: string;
  candidateScores: Record<string, number | null>;
}

export interface VolFarmerV2LeapsSale {
  /** Every open leg of the LEAPS, sold as one order. */
  legIds: string[];
  expiry: string;
  strike: number;
  contracts: number;
  fillPrice: number;
  description: string;
  chosenBecause: string;
  candidateScores: Record<string, number | null>;
}

/** One of the symbol's legs, as the book holds it now. */
export interface VolFarmerV2LegStatus {
  closed: boolean;
  assigned: boolean;
  /** On the cycle's scale. */
  strike: number | null;
  contracts: number;
}

/**
 * The symbol's book: what the steps read of it and the orders they place on it. Each order is applied at once (the next
 * step sees it) and answers the leg it opened. Prices and shares the book reads or is handed are on the cycle's scale.
 */
export interface VolFarmerV2Book {
  /** No shares and no option held on the symbol. */
  isFlat(): boolean;
  freeCash(): number;
  /** A new cycle's pot P. */
  potForNewCycle(): number;
  /** What leapsMaxAccountPct is a share of. */
  leapsCapBaseDollars(): number;
  /** The symbol's open option legs' contracts, strikes on the cycle's scale. */
  openOptionContracts(): { expiry: string; strike: number }[];
  /** Undefined when the book has no such leg. */
  leg(legId: string): VolFarmerV2LegStatus | undefined;
  sellCoveredCall(sale: VolFarmerV2CallSale): string;
  sellCashSecuredPut(sale: VolFarmerV2PutSale): string;
  buyLeaps(purchase: VolFarmerV2LeapsPurchase): string;
  sellLeaps(sale: VolFarmerV2LeapsSale): void;
}

export interface VolFarmerV2LookInput {
  state: VolFarmerV2SymbolState;
  market: VolFarmerV2Market;
  farmer: Pick<BacktestVolFarmerSettings, "callMinAbsDelta" | "callMaxAbsDelta" | "maxSpreadPctOfMid">;
  v2: BacktestVolFarmerV2Settings;
  book: VolFarmerV2Book;
}

const contractKeyOf = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${roundedStrike(contract.strike)}`;

/**
 * Updates the positions from what settled since the last look: Calls assigned or expired, Puts assigned or expired, the
 * LEAPS settled. A position whose last shares were called away ends; the second's Puts' premiums then start afresh and
 * its LEAPS is sold at this look.
 */
function reconcile(book: VolFarmerV2Book, state: VolFarmerV2SymbolState, notes: string[]): void {
  const calledAway = new Set<"first" | "second">();
  for (const [name, position] of [["first", state.first], ["second", state.second]] as const) {
    if (position === null) continue;
    const callLeg = position.call === null ? undefined : book.leg(position.call.legId);
    if (position.call !== null && callLeg !== undefined && callLeg.closed) {
      if (callLeg.assigned) {
        position.shares = Math.max(0, position.shares - position.call.shares);
        notes.push(`the ${name} position's Call was assigned: ${position.call.shares} shares called away${position.shares > 0 ? `, ${position.shares} left` : ""}`);
        if (position.shares === 0) calledAway.add(name);
      }
      position.call = null;
    }
    const putLeg = position.put === null ? undefined : book.leg(position.put.legId);
    if (position.put !== null && putLeg !== undefined && putLeg.closed) {
      if (putLeg.assigned) {
        position.shares += position.put.shares;
        position.costPerShare = putLeg.strike!;
        notes.push(`the second position's Put was assigned: ${position.put.shares} shares at ${putLeg.strike!.toFixed(2)}`);
      }
      position.put = null;
    }
  }
  if (calledAway.has("first")) state.first = null;
  if (calledAway.has("second")) {
    state.second = null;
    state.leapsBought = false;
    state.leapsTrigger = null;
    if (state.leaps !== null) state.leapsToSell = true;
  }
  if (state.leaps !== null && openLeapsLegs(book, state.leaps).length === 0 && state.leaps.legIds.some((legId) => book.leg(legId) !== undefined)) {
    state.leaps = null;
    state.leapsToSell = false;
  }
}

/** The LEAPS' legs still held, with their contracts. */
function openLeapsLegs(book: VolFarmerV2Book, leaps: NonNullable<VolFarmerV2SymbolState["leaps"]>): { legId: string; contracts: number }[] {
  return leaps.legIds.flatMap((legId) => {
    const leg = book.leg(legId);
    return leg !== undefined && !leg.closed ? [{ legId, contracts: leg.contracts }] : [];
  });
}

/** The candidate whose volume covers `wanted(candidate)` contracts, in their order; else the one covering the most. */
function pickByVolume(candidates: readonly BaselineCandidate[], wanted: (candidate: BaselineCandidate) => number, capOf: (candidate: BaselineCandidate) => number): BaselineCandidate | null {
  let fallback: BaselineCandidate | null = null;
  for (const candidate of candidates) {
    if (wanted(candidate) < 1) continue;
    if (capOf(candidate) >= wanted(candidate)) return candidate;
    if (fallback === null || capOf(candidate) > capOf(fallback)) fallback = candidate;
  }
  return fallback;
}

/** One look at one symbol: its orders go to the book as they are decided. Answers the look's note on it, or null. */
export function runVolFarmerV2Steps(input: VolFarmerV2LookInput): string | null {
  const { state, market, farmer, v2, book } = input;
  const { symbol, todayIso, stockPrice, riskFreeRate, quotes, priceToCycleScale } = market;
  const parts: string[] = [];
  reconcile(book, state, parts);
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const asTraded = (cyclePrice: number) => cyclePrice / priceToCycleScale;
  const say = (text: string) => parts.push(text);
  const finish = () => (parts.length === 0 ? null : `${symbol}: ${parts.join("; ")}`);

  if (book.isFlat() && (state.first !== null || state.second !== null || state.leaps !== null)) Object.assign(state, { ...newVolFarmerV2SymbolState(), cash: state.cash });
  if (!market.optionContractsRepresentable) {
    say("no option orders while the open cycle spans a split");
    return finish();
  }

  // 4b. The LEAPS of a second position called away goes first, at the look's fill.
  if (state.leapsToSell && state.leaps !== null) {
    say(sellLeaps(input));
    if (book.isFlat()) return finish();
  }

  const nextExpiry = quotes.reduce<string | null>((next, quote) => (quote.right === "C" && quote.expiry > todayIso && (next === null || quote.expiry < next) ? quote.expiry : next), null);
  if (nextExpiry === null) {
    say("no Call expiry listed after today");
    return finish();
  }
  const dte = daysToExpiry(nextExpiry, todayIso);
  const heldContracts = new Set(book.openOptionContracts().map((contract) => contractKeyOf({ expiry: contract.expiry, strike: asTraded(contract.strike) })));
  const candidatesOf = (right: "C" | "P", limits: { minAbsDelta: number; maxAbsDelta: number; minimumStrike?: number; maximumStrike?: number; heldExcluded: boolean }) =>
    selectBaselineCandidates({
      quotes,
      forwardAnchors: market.forwardAnchors,
      commissions: market.commissions,
      right,
      todayIso,
      yearsToTodaysClose: market.yearsToTodaysClose,
      stockPrice,
      riskFreeRate,
      previousSessionVolumeByContract: market.previousSessionVolumeByContract,
      settings: { minAbsDelta: limits.minAbsDelta, maxAbsDelta: limits.maxAbsDelta, minDte: dte, maxDte: dte, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid },
      spreadShareCharged: market.spreadShareCharged,
      isHeld: (contract) => limits.heldExcluded && heldContracts.has(contractKeyOf(contract)),
      ...(limits.minimumStrike === undefined ? {} : { minimumStrike: limits.minimumStrike }),
      ...(limits.maximumStrike === undefined ? {} : { maximumStrike: limits.maximumStrike }),
    });
  const callCandidates = (breakEvenAsTraded: number, heldExcluded: boolean) => {
    const selected = candidatesOf("C", { minAbsDelta: farmer.callMinAbsDelta, maxAbsDelta: farmer.callMaxAbsDelta, minimumStrike: breakEvenAsTraded, heldExcluded });
    return { calls: selected.candidates.filter((candidate) => candidate.strike > stockPrice), rejections: selected.rejections };
  };

  // 1. Flat: a new cycle, the first position's shares bought with its first Call.
  if (state.first === null && state.second === null && state.leaps === null) {
    if (!book.isFlat()) return finish();
    const pot = book.potForNewCycle();
    const lotCost = stockPrice * sharesPerContract + market.stockCommissionDollars(sharesPerContract);
    const lotsWanted = Math.floor(pot / 2 / lotCost + 1e-9);
    if (lotsWanted < 1) {
      say(`no cycle opened: a lot costs ${formatWholeDollars(lotCost)}, more than half the free cash (${formatWholeDollars(pot / 2)})`);
      return finish();
    }
    const shareCost = stockPrice + market.stockCommissionDollars(lotsWanted * sharesPerContract) / (lotsWanted * sharesPerContract);
    const { calls, rejections } = callCandidates(shareCost, false);
    const call = pickByVolume(calls, () => lotsWanted, (candidate) => candidate.volumeCap);
    if (call === null) {
      say(`no cycle opened: no Call at or above the shares' cost ${shareCost.toFixed(2)} (${describeRejections(rejections) || "none listed"})`);
      return finish();
    }
    const lots = Math.min(lotsWanted, call.volumeCap);
    if (lots < 1) {
      say("no cycle opened: the volume limit allows no Call");
      return finish();
    }
    const spent = lots * sharesPerContract * stockPrice + market.stockCommissionDollars(lots * sharesPerContract);
    Object.assign(state, { ...newVolFarmerV2SymbolState(), cash: state.cash, potDollars: pot });
    state.cash.cycles += 1;
    state.cash.firstHalfLeft.push(pot / 2 - spent);
    state.first = { shares: lots * sharesPerContractOnCycleScale, costPerShare: spent / (lots * sharesPerContractOnCycleScale), premiumDollars: 0, call: null, put: null };
    say(sellCalls(input, [{ name: "first", position: state.first, call, contracts: lots }]));
    return finish();
  }

  // 2. Calls on the positions holding shares with none open.
  const breakEvenAsTraded = (position: VolFarmerV2Position | null) => {
    const breakEven = position === null ? null : volFarmerV2BreakEven(position);
    return breakEven === null ? null : asTraded(breakEven);
  };
  const firstNeedsCall = state.first !== null && state.first.shares > 0 && state.first.call === null;
  const volumeUsed = new Map<string, number>();
  const orders: CallOrder[] = [];
  let secondFindsNoCall = false;
  for (const [name, position] of [["first", state.first], ["second", state.second]] as const) {
    if (position === null || position.shares <= 0 || position.call !== null) continue;
    const breakEven = breakEvenAsTraded(position)!;
    const lots = Math.floor(position.shares / sharesPerContractOnCycleScale + 1e-9);
    if (lots < 1) continue;
    // Contracts held from earlier looks are left out (one position per contract); one the other position picks at this
    // look is not, and they sell it as one order.
    const { calls, rejections } = callCandidates(breakEven, true);
    const capLeft = (candidate: BaselineCandidate) => candidate.volumeCap - (volumeUsed.get(contractKeyOf(candidate)) ?? 0);
    const call = pickByVolume(calls, () => lots, capLeft);
    if (call === null) {
      say(`${name} position: no Call at or above its break-even ${breakEven.toFixed(2)} (${describeRejections(rejections) || "none listed"})`);
      if (name === "second") secondFindsNoCall = true;
      continue;
    }
    const contracts = Math.min(lots, capLeft(call));
    if (contracts < 1) {
      say(`${name} position: no Call sold: the volume limit allows none`);
      continue;
    }
    volumeUsed.set(contractKeyOf(call), (volumeUsed.get(contractKeyOf(call)) ?? 0) + contracts);
    orders.push({ name, position, call, contracts });
  }
  if (orders.length > 0) say(sellCalls(input, orders));

  // 3. Puts for the second position, when the first needed a new Call and its best yields under putsStartCallYieldPct.
  const first = state.first;
  const second = state.second;
  if (firstNeedsCall && first !== null && first.shares > 0 && (second === null || (second.shares === 0 && second.put === null))) {
    const firstBreakEven = breakEvenAsTraded(first)!;
    const bestCall = callCandidates(firstBreakEven, false).calls[0] ?? null;
    const bestYield = bestCall?.premiumYield ?? 0;
    if (bestYield * 100 < v2.putsStartCallYieldPct) {
      const step: VolFarmerV2Step = v2.stepRule === "implied_move_at_put_sale" ? volFarmerV2ImpliedMoveStep(v2.stepBelowFirstBreakEvenPct, market.stepImpliedVolatility()) : { stepPct: v2.stepBelowFirstBreakEvenPct, impliedVolatility: null };
      const strikeCap = volFarmerV2PutStrikeCap(firstBreakEven, step.stepPct);
      // The implied-move rule says which Step it used and records it with the Put; the fixed rule's records stay as they were.
      const stepNote =
        v2.stepRule === "fixed"
          ? ""
          : step.impliedVolatility === null
            ? ` (Step ${step.stepPct.toFixed(1)}%: no IV in the last ${stepImpliedVolatilityLookbackSessions} sessions, the fixed Step)`
            : ` (Step ${step.stepPct.toFixed(1)}%: IV ${percent(step.impliedVolatility)} × √(21 ÷ 252))`;
      const stepScores: Record<string, number | null> = v2.stepRule === "fixed" ? {} : { stepPct: step.stepPct, stepImpliedVolatility: step.impliedVolatility };
      const { candidates: puts, rejections } = candidatesOf("P", { minAbsDelta: 0, maxAbsDelta: v2.putMaxAbsDelta, maximumStrike: strikeCap, heldExcluded: true });
      const freeCash = book.freeCash();
      const wanted = (candidate: BaselineCandidate) => Math.min(Math.floor(state.potDollars / 2 / (candidate.strike * sharesPerContract) + 1e-9), Math.floor(freeCash / (candidate.strike * sharesPerContract) + 1e-9));
      const put = pickByVolume(puts, wanted, (candidate) => candidate.volumeCap);
      const trigger = bestCall === null ? `no Call at or above the first break-even ${firstBreakEven.toFixed(2)}` : `the best Call at or above the first break-even ${firstBreakEven.toFixed(2)} yields ${percent(bestYield, 2)} a year, under ${v2.putsStartCallYieldPct}%`;
      if (put === null) say(`no Put: ${trigger}, but none qualifies at or below ${strikeCap.toFixed(2)}${stepNote} (${describeRejections(rejections) || "none listed"})`);
      else {
        const contracts = Math.min(wanted(put), put.volumeCap);
        if (contracts < 1) say(`no Put: ${trigger}, but the volume limit allows none`);
        else {
          state.second ??= { shares: 0, costPerShare: 0, premiumDollars: 0, call: null, put: null };
          state.cash.secondHalfLeft.push(state.potDollars / 2 - contracts * put.strike * sharesPerContract);
          say(sellPut(input, state.second, put, contracts, `${trigger}; strike at most ${strikeCap.toFixed(2)}${stepNote}`, firstBreakEven, stepScores));
        }
      }
    }
  }

  // 4. The LEAPS, once the second position holds shares no Call at or above its break-even fits; one bought short of its
  // intended count at an earlier look is topped up while the second position holds its shares.
  if (secondFindsNoCall && state.second !== null && state.second.shares > 0 && state.leaps === null && !state.leapsBought) {
    say(buyLeaps(input, breakEvenAsTraded(state.second)!));
  } else if (state.leaps !== null && !state.leapsToSell && state.second !== null && state.second.shares > 0) {
    const toppedUp = topUpLeaps(input);
    if (toppedUp !== null) say(toppedUp);
  }
  return finish();
}

interface CallOrder {
  name: "first" | "second";
  position: VolFarmerV2Position;
  call: BaselineCandidate;
  contracts: number;
}

/** Sells the look's Calls, one order per contract (positions picking the same one share it), each position's premium its share of the order's. */
function sellCalls(input: VolFarmerV2LookInput, orders: readonly CallOrder[]): string {
  const { market, book } = input;
  const { symbol, stockPrice, priceToCycleScale } = market;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const byContract = new Map<string, CallOrder[]>();
  for (const order of orders) byContract.set(contractKeyOf(order.call), [...(byContract.get(contractKeyOf(order.call)) ?? []), order]);
  const descriptions: string[] = [];
  for (const group of byContract.values()) {
    const call = group[0]!.call;
    const contracts = group.reduce((sum, order) => sum + order.contracts, 0);
    const startsCycle = book.isFlat();
    const commission = market.optionCommissionDollars(contracts);
    // The break-even each position held this Call to, before its premium: the Wheel cycles' B-E¹ / B-E² of the sale.
    const breakEvensBefore = Object.fromEntries(group.map((order) => [order.name === "first" ? "breakEvenFirst" : "breakEvenSecond", volFarmerV2BreakEven(order.position)! / priceToCycleScale]));
    const whose: string[] = [];
    for (const order of group) {
      order.position.premiumDollars += call.fillPrice * sharesPerContract * order.contracts - (commission * order.contracts) / contracts;
      whose.push(`${order.name} position ${order.contracts}×, break-even now ${(volFarmerV2BreakEven(order.position)! / priceToCycleScale).toFixed(2)}`);
    }
    const contractLabel = describeOptionContract({ strike: call.strike, right: "C", expiry: call.expiry, dte: call.dte });
    const sharesNote = startsCycle ? ` with ${contracts * sharesPerContract} shares bought @ ${stockPrice.toFixed(2)}` : " on held shares";
    const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, call.fillPrice)}${sharesNote} (delta ${Math.abs(call.delta).toFixed(2)}, IV ${percent(call.impliedVolatility)}, premium yield ${percent(call.premiumYield)}; ${whose.join(", ")})`;
    const callLegId = book.sellCoveredCall({
      candidate: call,
      contracts,
      startsCycle,
      description,
      chosenBecause: `vol farmer v2: the highest premium yield at or above the ${group.map((order) => order.name).join(" and ")} position's break-even, ${contracts < group.reduce((sum, order) => sum + Math.floor(order.position.shares / sharesPerContractOnCycleScale + 1e-9), 0) ? "the volume covering the most lots" : "its volume covering every lot"}`,
      candidateScores: { premiumYield: call.premiumYield, delta: call.delta, impliedVolatility: call.impliedVolatility, timeValue: call.timeValue, dte: call.dte, bid: call.bid, ask: call.ask, volumeCap: call.volumeCap, stockPrice, ...breakEvensBefore },
    });
    for (const order of group) order.position.call = { legId: callLegId, shares: order.contracts * sharesPerContractOnCycleScale };
    descriptions.push(description);
  }
  return descriptions.join(" · ");
}

function sellPut(input: VolFarmerV2LookInput, second: VolFarmerV2Position, put: BaselineCandidate, contracts: number, why: string, firstBreakEvenAsTraded: number, stepScores: Record<string, number | null>): string {
  const { market, book, v2 } = input;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / market.priceToCycleScale);
  const commission = market.optionCommissionDollars(contracts);
  second.premiumDollars += put.fillPrice * sharesPerContract * contracts - commission;
  const contractLabel = describeOptionContract({ strike: put.strike, right: "P", expiry: put.expiry, dte: put.dte });
  const description = `${market.symbol} Sell ${contractLabel}${describeOrderSize(contracts, put.fillPrice)} (second position: delta ${Math.abs(put.delta).toFixed(2)}, IV ${percent(put.impliedVolatility)}, premium yield ${percent(put.premiumYield)}; ${why})`;
  const putLegId = book.sellCashSecuredPut({
    candidate: put,
    contracts,
    description,
    chosenBecause: `vol farmer v2: ${why}; the highest premium yield up to |delta| ${v2.putMaxAbsDelta}, on half the pot`,
    candidateScores: { premiumYield: put.premiumYield, delta: put.delta, impliedVolatility: put.impliedVolatility, timeValue: put.timeValue, dte: put.dte, bid: put.bid, ask: put.ask, volumeCap: put.volumeCap, stockPrice: market.stockPrice, breakEvenFirst: firstBreakEvenAsTraded, ...stepScores },
  });
  second.put = { legId: putLegId, shares: contracts * sharesPerContractOnCycleScale };
  return description;
}

function buyLeaps(input: VolFarmerV2LookInput, secondBreakEvenAsTraded: number): string {
  const { state, market, book, farmer, v2 } = input;
  const { todayIso, stockPrice } = market;
  const freeCash = book.freeCash();
  if (state.leapsTrigger === null) {
    state.leapsTrigger = { dateIso: todayIso, freeCash, contractCost: null, boughtOn: null, contracts: 0 };
    state.cash.leapsTriggers.push(state.leapsTrigger);
  }
  const log = state.leapsTrigger;
  const source = market.leapsCallQuotes;
  const expiry = source?.listedExpiries().find((listed) => daysToExpiry(listed, todayIso) >= v2.leapsMinDte) ?? null;
  if (!source || expiry === null) return `no LEAPS: no Call expiry listed ${v2.leapsMinDte} or more days out`;
  const leaps = chooseVolFarmerV2Leaps({ quotes: source.quotesOf(expiry), expiry, stockPrice, yearsToExpiry: market.yearsToExpiry(expiry), riskFreeRate: market.riskFreeRate, absDelta: v2.leapsAbsDelta, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid, spreadShareCharged: market.spreadShareCharged });
  if (leaps === null) return `no LEAPS: no Call of ${expiry} has a usable quote`;
  const contractCost = leaps.fillPrice * sharesPerContract + market.optionCommissionDollars(1);
  if (log.contractCost === null) log.contractCost = contractCost;
  const capped = v2.leapsMaxAccountPct > 0;
  const capBase = book.leapsCapBaseDollars();
  const budget = volFarmerV2LeapsBudget(freeCash, capBase, v2.leapsMaxAccountPct);
  const cashText = capped ? `free cash ${formatWholeDollars(freeCash)}, LEAPS cap ${formatWholeDollars(capBase * (v2.leapsMaxAccountPct / 100))} (${v2.leapsMaxAccountPct}% of ${market.leapsCapBaseLabel} ${formatWholeDollars(capBase)})` : `free cash ${formatWholeDollars(freeCash)}`;
  const affordable = contractsAffordable(budget, leaps.fillPrice, market.optionCommissionDollars);
  if (affordable < 1) return `no LEAPS: one contract of the ${leaps.strike} Call costs ${formatWholeDollars(contractCost)}, more than ${capped ? `${formatWholeDollars(budget)} (${cashText})` : `the free cash (${formatWholeDollars(freeCash)})`}`;
  // The backtest buys no more than the ask offered (Marcelo 2026-10-27): long-dated Calls trade rarely, but are quoted deep.
  const offered = market.capsLeapsAtAskSize ? (leaps.askSize ?? 0) : affordable;
  if (offered < 1) return `no LEAPS: the ${leaps.strike} Call shows no size at its ask`;
  const contracts = Math.min(affordable, offered);
  const dte = daysToExpiry(expiry, todayIso);
  const contractLabel = describeOptionContract({ strike: leaps.strike, right: "C", expiry, dte });
  const description = `${market.symbol} Buy ${contractLabel}${describeOrderSize(contracts, leaps.fillPrice)} (LEAPS: delta ${leaps.delta.toFixed(2)}, IV ${percent(leaps.impliedVolatility)}; the second position has no Call at or above its break-even ${secondBreakEvenAsTraded.toFixed(2)}; ${cashText}${contracts < affordable ? `, which pays for ${affordable}: ${offered} offered at the ask` : ""})`;
  const legId = book.buyLeaps({
    expiry,
    strike: leaps.strike,
    bid: leaps.bid,
    ask: leaps.ask,
    fillPrice: leaps.fillPrice,
    contracts,
    description,
    chosenBecause: `vol farmer v2: the second position has no Call at or above its break-even; of the first expiry ${v2.leapsMinDte} or more days out, the Call whose |delta| is nearest ${v2.leapsAbsDelta}, with ${capped ? `the free cash up to the LEAPS cap (${v2.leapsMaxAccountPct}% of ${market.leapsCapBaseLabel})` : "all the free cash"}, up to the contracts offered at its ask`,
    candidateScores: { bid: leaps.bid, ask: leaps.ask, askSize: leaps.askSize, dte, stockPrice, impliedVolatility: leaps.impliedVolatility, delta: leaps.delta, freeCash, costDollars: leaps.fillPrice * sharesPerContract * contracts + market.optionCommissionDollars(contracts), ...(capped ? { accountValue: capBase, leapsBudget: budget } : {}) },
  });
  state.leaps = { legIds: [legId], expiry, strike: leaps.strike, intendedContracts: affordable };
  state.leapsBought = true;
  log.boughtOn = todayIso;
  log.contracts = contracts;
  return description;
}

/** A LEAPS held short of its intended count: N − held more of the same contract, as the free cash (and, in the backtest, the ask) allows; null when none is due. */
function topUpLeaps(input: VolFarmerV2LookInput): string | null {
  const { state, market, book, farmer } = input;
  const leaps = state.leaps!;
  const held = openLeapsLegs(book, leaps).reduce((sum, leg) => sum + leg.contracts, 0);
  const wanted = leaps.intendedContracts - held;
  if (held < 1 || wanted < 1) return null;
  const progress = `${held} of ${leaps.intendedContracts} held`;
  const quote = market.leapsCallQuotes?.quotesOf(leaps.expiry).find((candidate) => candidate.right === "C" && roundedStrike(candidate.strike) === roundedStrike(leaps.strike));
  if (!quote || baselineQuoteRejection(quote, farmer.maxSpreadPctOfMid) !== null) return `LEAPS top-up: no usable quote for the ${leaps.strike} Call (${progress})`;
  const fillPrice = optionPurchaseFillPrice(quote.bid!, quote.ask!, market.spreadShareCharged);
  const freeCash = book.freeCash();
  const affordable = contractsAffordable(freeCash, fillPrice, market.optionCommissionDollars);
  if (affordable < 1) return `LEAPS top-up: one more ${leaps.strike} Call costs ${formatWholeDollars(fillPrice * sharesPerContract + market.optionCommissionDollars(1))}, more than the free cash (${formatWholeDollars(freeCash)}; ${progress})`;
  const offered = market.capsLeapsAtAskSize ? (quote.askSize ?? 0) : wanted;
  if (offered < 1) return `LEAPS top-up: the ${leaps.strike} Call shows no size at its ask (${progress})`;
  const contracts = Math.min(wanted, affordable, offered);
  const dte = daysToExpiry(leaps.expiry, market.todayIso);
  const contractLabel = describeOptionContract({ strike: leaps.strike, right: "C", expiry: leaps.expiry, dte });
  const description = `${market.symbol} Buy ${contractLabel}${describeOrderSize(contracts, fillPrice)} (LEAPS top-up: ${progress}, free cash ${formatWholeDollars(freeCash)})`;
  const legId = book.buyLeaps({
    expiry: leaps.expiry,
    strike: leaps.strike,
    bid: quote.bid!,
    ask: quote.ask!,
    fillPrice,
    contracts,
    description,
    chosenBecause: `vol farmer v2: the LEAPS was bought short of its ${leaps.intendedContracts} contracts, so the same contract is topped up`,
    candidateScores: { bid: quote.bid, ask: quote.ask, askSize: quote.askSize, dte, stockPrice: market.stockPrice, freeCash, intendedContracts: leaps.intendedContracts, heldContracts: held, costDollars: fillPrice * sharesPerContract * contracts + market.optionCommissionDollars(contracts) },
  });
  leaps.legIds.push(legId);
  if (state.leapsTrigger !== null) state.leapsTrigger.contracts += contracts;
  return description;
}

function sellLeaps(input: VolFarmerV2LookInput): string {
  const { state, market, book } = input;
  const leaps = state.leaps!;
  const legs = openLeapsLegs(book, leaps);
  if (legs.length === 0) {
    state.leaps = null;
    state.leapsToSell = false;
    return "the LEAPS is no longer held";
  }
  const quote = market.leapsCallQuotes?.quotesOf(leaps.expiry).find((candidate) => candidate.right === "C" && roundedStrike(candidate.strike) === roundedStrike(leaps.strike));
  if (!quote || quote.ask === null || !(quote.ask > 0)) return `the LEAPS is kept: no quote to sell the ${leaps.strike} Call at`;
  const fill = optionSaleFillPrice(quote.bid ?? 0, quote.ask, market.spreadShareCharged);
  const contracts = legs.reduce((sum, leg) => sum + leg.contracts, 0);
  const contractLabel = describeOptionContract({ strike: leaps.strike, right: "C", expiry: leaps.expiry, dte: daysToExpiry(leaps.expiry, market.todayIso) });
  const description = `${market.symbol} Sell ${contractLabel}${describeOrderSize(contracts, fill)} (LEAPS: the second position was called away)`;
  book.sellLeaps({ legIds: legs.map((leg) => leg.legId), expiry: leaps.expiry, strike: leaps.strike, contracts, fillPrice: fill, description, chosenBecause: "vol farmer v2: the second position was called away, so its LEAPS is sold", candidateScores: { bid: quote.bid, ask: quote.ask, stockPrice: market.stockPrice } });
  state.leaps = null;
  state.leapsToSell = false;
  return description;
}
