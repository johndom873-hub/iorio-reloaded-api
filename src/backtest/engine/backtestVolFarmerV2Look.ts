import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { blackScholesDelta, impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction, BacktestVolFarmerSettings, BacktestVolFarmerV2Settings } from "../backtestTypes.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestLookSymbol, BacktestOptionSale } from "./backtestLook.js";
import { captureLookTimeEt, lookInstantMs } from "./backtestTickerInputs.js";
import { baselineQuoteRejection, describeRejections, noteBaselineForwardAnchors, roundedStrike, selectBaselineCandidates, type BaselineCandidate, type BaselineCommissions, type BaselineForwardAnchor } from "./baselineSaleSteps.js";
import { buyHedgePut, expirySettlementInstant, openCashSecuredPut, openCoveredCall, sellHedgePut } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, isSymbolFlat, legsOfPosition, positionsOfSymbol, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// Vol Farmer v2 (decision maker "vol_farmer_v2", Marcelo 2026-10-27; research): two Covered Calls at different price
// levels and a LEAPS Call, no hedge Put. At the 10:00 look only, per symbol (prices as traded today, S the look's stock
// price; one-symbol sessions: the pot is the account's free cash):
//   1. flat: the cycle's pot P = the free cash. The first position buys lots = floor(P ÷ 2 ÷ (100 × S + the stock
//      commission)) at S, with a Call sold on them as in 2 (none: no cycle, tried again at the next look).
//   2. Calls: each position holding shares with no Call open sells one on every lot: the Calls of the next listed expiry
//      after today, OTM, inside the Vol Farmer's |delta| range and spread limit (bid ≥ $0.05, volume as the ladder's),
//      struck at or above the position's break-even, in order of premium yield: the first whose volume covers every lot,
//      else the one covering the most. Held to expiry: in the money there, its shares are called away (the session's
//      settlement). Both positions picking the same contract at a look sell it as one order (one position per contract).
//        break-even, first   = what its shares cost (fill plus stock commission) − its Calls' premiums net of
//                              commissions ÷ its shares
//        break-even, second  = the assigned Put's strike − the premiums net of commissions of every Put sold for it and of
//                              its Calls ÷ its shares
//   3. Puts: the first position holds shares, the second holds none and has no Put open, and the best Call 2 finds for
//      the first position (open Calls not excluded) yields under putTriggerCallYieldPct a year (no Call: 0%): the Puts of
//      the same next expiry with |delta| ≤ putMaxAbsDelta, struck ≤ the first break-even × (1 − putStrikeBelowFirstBreak-
//      EvenPct ÷ 100), spread and volume as the Calls', by premium yield; contracts = min(floor(P ÷ 2 ÷ (100 × strike)),
//      floor(free cash ÷ (100 × strike)), the volume limit). Assigned, the Put's shares are the second position.
//   4. LEAPS: the second position holds shares and no Call at or above its break-even passes 2's rules, and it has bought
//      no LEAPS since it holds them: of the 10:00 Calls of the first listed expiry at least leapsMinDte days out (spread
//      within the limit, bid ≥ $0.05), the one whose |delta| (its own IV, on the forward) is nearest leapsAbsDelta; as
//      many contracts as the free cash pays for (fill + commission), tried again at each look until one is bought. It is
//      sold at the first 10:00 look after the second position is called away (the session's fill rule); held to its
//      expiry, the session settles it at its intrinsic value.
// The first position's Calls are struck above the second's break-even (step 3's strike rule), so the second is called away
// first or with it; a first position called away with the second's Puts open leaves them to their expiry, the same day.
// When nothing is held, the next cycle starts at the next day's 10:00 look. A cycle that spans a split whose contracts do
// not fit its share scale sells and buys no option until it ends.
//
// Example: P = $100,000 and S = $240: the first position buys floor(50,000 ÷ 24,000.50) = 2 lots (200 shares, $48,001)
// and sells Calls at or above its break-even each week. With its break-even at $236 after a fall to $200, no Call at or
// above $236 yields 5% a year, so Puts are sold struck at most 236 × 0.85 = $200.60: floor(50,000 ÷ 19,500) = 2 contracts
// of the $195 Put.

/** The flat rates the ledger charges (ledgerFills.ts), for ranking the options. */
const volFarmerV2Commissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const millisecondsPerYear = 365 * 86_400_000;
const percent = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

/** One of the two Covered Calls, on the cycle's scale. */
interface VolFarmerV2Position {
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
interface VolFarmerV2LeapsTrigger {
  dateIso: string;
  freeCash: number;
  contractCost: number | null;
  boughtOn: string | null;
  contracts: number;
}

interface VolFarmerV2SymbolState {
  potDollars: number;
  first: VolFarmerV2Position | null;
  second: VolFarmerV2Position | null;
  leaps: { legId: string; expiry: string; strike: number } | null;
  /** The second position holding shares now has bought its LEAPS (one per holding). */
  leapsBought: boolean;
  /** The second position was called away and a LEAPS is still to be sold. */
  leapsToSell: boolean;
  /** The second position holding shares now: its LEAPS trigger, once one fired. */
  leapsTrigger: VolFarmerV2LeapsTrigger | null;
  /** The cash check (describeVolFarmerV2Run). */
  cash: { cycles: number; firstHalfLeft: number[]; secondHalfLeft: number[]; leapsTriggers: VolFarmerV2LeapsTrigger[] };
}

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, VolFarmerV2SymbolState>>();

function newSymbolState(): VolFarmerV2SymbolState {
  return { potDollars: 0, first: null, second: null, leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 0, firstHalfLeft: [], secondHalfLeft: [], leapsTriggers: [] } };
}

function stateOf(ledger: SimulatedLedger, symbol: string): VolFarmerV2SymbolState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  let state = bySymbol.get(symbol);
  if (!state) bySymbol.set(symbol, (state = newSymbolState()));
  return state;
}

/** A position's break-even per share, on the cycle's scale; null without shares. */
export function volFarmerV2BreakEven(position: Pick<VolFarmerV2Position, "shares" | "costPerShare" | "premiumDollars">): number | null {
  return position.shares > 0 ? position.costPerShare - position.premiumDollars / position.shares : null;
}

/** The highest strike step 3 sells a Put at, as traded today: the first break-even × (1 − pct ÷ 100). */
export function volFarmerV2PutStrikeCap(firstBreakEvenAsTraded: number, putStrikeBelowFirstBreakEvenPct: number): number {
  return firstBreakEvenAsTraded * (1 - putStrikeBelowFirstBreakEvenPct / 100);
}

/** The most contracts `cashDollars` pays for at `fillPrice` a share, commission included. */
export function contractsAffordable(cashDollars: number, fillPrice: number): number {
  let contracts = Math.floor(cashDollars / (fillPrice * sharesPerContract + optionCommissionDollars(1)));
  while (contracts > 0 && contracts * fillPrice * sharesPerContract + optionCommissionDollars(contracts) > cashDollars + 1e-9) contracts -= 1;
  return Math.max(0, contracts);
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

const contractKeyOf = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${roundedStrike(contract.strike)}`;

/**
 * Updates the positions from what the session settled since the last look: Calls assigned or expired, Puts assigned or
 * expired, the LEAPS settled. A position whose last shares were called away ends; the second's Puts' premiums then start
 * afresh and its LEAPS is sold at this look.
 */
function reconcile(ledger: SimulatedLedger, state: VolFarmerV2SymbolState, notes: string[]): void {
  const legById = (legId: string): LedgerLeg | undefined => ledger.legs.find((leg) => leg.id === legId);
  const calledAway = new Set<"first" | "second">();
  for (const [name, position] of [["first", state.first], ["second", state.second]] as const) {
    if (position === null) continue;
    const callLeg = position.call === null ? undefined : legById(position.call.legId);
    if (position.call !== null && callLeg !== undefined && callLeg.exitAt !== null) {
      if (callLeg.settledAs === "assigned") {
        position.shares = Math.max(0, position.shares - position.call.shares);
        notes.push(`the ${name} position's Call was assigned: ${position.call.shares} shares called away${position.shares > 0 ? `, ${position.shares} left` : ""}`);
        if (position.shares === 0) calledAway.add(name);
      }
      position.call = null;
    }
    const putLeg = position.put === null ? undefined : legById(position.put.legId);
    if (position.put !== null && putLeg !== undefined && putLeg.exitAt !== null) {
      if (putLeg.settledAs === "assigned") {
        position.shares += position.put.shares;
        position.costPerShare = putLeg.strikePrice!;
        notes.push(`the second position's Put was assigned: ${position.put.shares} shares at ${putLeg.strikePrice!.toFixed(2)}`);
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
  const leapsLeg = state.leaps === null ? undefined : legById(state.leaps.legId);
  if (state.leaps !== null && leapsLeg !== undefined && leapsLeg.exitAt !== null) {
    state.leaps = null;
    state.leapsToSell = false;
  }
}

/** The Vol Farmer v2 look: at 10:00 only (runBacktestSession.ts skips the later looks). */
export async function runVolFarmerV2Look(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const at = new Date(lookInstantMs(todayIso, lookTimeEt));
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];
  for (const lookSymbol of context.symbols) {
    const summary = lookAtSymbol({ context, lookSymbol, farmer: settings.volFarmer, v2: settings.volFarmerV2, at, actions, optionSales });
    if (summary !== null) summaries.push(summary);
  }
  const summary = summaries.length === 0 ? "No action" : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
}

interface SymbolLook {
  context: BacktestLookContext;
  lookSymbol: BacktestLookSymbol;
  farmer: BacktestVolFarmerSettings;
  v2: BacktestVolFarmerV2Settings;
  at: Date;
  actions: BacktestAction[];
  optionSales: BacktestOptionSale[];
}

function lookAtSymbol(input: SymbolLook): string | null {
  const { context, lookSymbol, farmer, v2, at } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const parts: string[] = [];
  reconcile(ledger, state, parts);
  const stockPrice = lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const priceToCycleScale = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at) / lookSymbol.splitFactorToday;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const spreadShareCharged = context.settings.trading.spreadCostChargedPct / 100;
  const asTraded = (cyclePrice: number) => cyclePrice / priceToCycleScale;
  const say = (text: string) => parts.push(text);
  const finish = () => (parts.length === 0 ? null : `${symbol}: ${parts.join("; ")}`);

  const flat = isSymbolFlat(ledger, symbol);
  if (flat && (state.first !== null || state.second !== null || state.leaps !== null)) Object.assign(state, { ...newSymbolState(), cash: state.cash });
  if (!lookSymbol.optionContractsRepresentable) {
    say("no option orders while the open cycle spans a split");
    return finish();
  }

  // 4b. The LEAPS of a second position called away goes first, at the look's fill.
  if (state.leapsToSell && state.leaps !== null) {
    const sold = sellLeaps(input, state, priceToCycleScale);
    say(sold);
    if (isSymbolFlat(ledger, symbol)) return finish();
  }

  const quotes = lookSymbol.market.quotes;
  const nextExpiry = quotes.reduce<string | null>((next, quote) => (quote.right === "C" && quote.expiry > todayIso && (next === null || quote.expiry < next) ? quote.expiry : next), null);
  if (nextExpiry === null) {
    say("no Call expiry listed after today");
    return finish();
  }
  const dte = daysToExpiry(nextExpiry, todayIso);
  const yearsToTodaysClose = Math.max(0, expirySettlementInstant(todayIso).getTime() - at.getTime()) / millisecondsPerYear;
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate });
  const heldContracts = new Set(openOptionLegsOf(ledger, symbol).map((leg) => contractKeyOf({ expiry: leg.expiryDate!, strike: asTraded(leg.strikePrice!) })));
  const candidatesOf = (right: "C" | "P", limits: { minAbsDelta: number; maxAbsDelta: number; minimumStrike?: number; maximumStrike?: number; heldExcluded: boolean }) =>
    selectBaselineCandidates({
      quotes,
      forwardAnchors,
      commissions: volFarmerV2Commissions,
      right,
      todayIso,
      yearsToTodaysClose,
      stockPrice,
      riskFreeRate,
      previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract,
      settings: { minAbsDelta: limits.minAbsDelta, maxAbsDelta: limits.maxAbsDelta, minDte: dte, maxDte: dte, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid },
      spreadShareCharged,
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
    if (!isSymbolFlat(ledger, symbol)) return finish();
    const pot = ledgerFreeCash(ledger);
    const lotCost = stockPrice * sharesPerContract + stockCommissionDollars(sharesPerContract);
    const lotsWanted = Math.floor(pot / 2 / lotCost + 1e-9);
    if (lotsWanted < 1) {
      say(`no cycle opened: a lot costs ${formatWholeDollars(lotCost)}, more than half the free cash (${formatWholeDollars(pot / 2)})`);
      return finish();
    }
    const shareCost = stockPrice + stockCommissionDollars(lotsWanted * sharesPerContract) / (lotsWanted * sharesPerContract);
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
    const spent = lots * sharesPerContract * stockPrice + stockCommissionDollars(lots * sharesPerContract);
    Object.assign(state, { ...newSymbolState(), cash: state.cash, potDollars: pot });
    state.cash.cycles += 1;
    state.cash.firstHalfLeft.push(pot / 2 - spent);
    state.first = { shares: lots * sharesPerContractOnCycleScale, costPerShare: (spent / (lots * sharesPerContractOnCycleScale)), premiumDollars: 0, call: null, put: null };
    say(sellCalls(input, [{ name: "first", position: state.first, call, contracts: lots }], priceToCycleScale, sharesPerContractOnCycleScale, stockPrice));
    return finish();
  }

  // 2. Calls on the positions holding shares with none open.
  const breakEvenAsTraded = (position: VolFarmerV2Position | null) => {
    const breakEven = position === null ? null : volFarmerV2BreakEven(position);
    return breakEven === null ? null : asTraded(breakEven);
  };
  const volumeUsed = new Map<string, number>();
  const orders: { name: "first" | "second"; position: VolFarmerV2Position; call: BaselineCandidate; contracts: number }[] = [];
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
  if (orders.length > 0) say(sellCalls(input, orders, priceToCycleScale, sharesPerContractOnCycleScale, stockPrice));

  // 3. Puts for the second position, while the first's best Call yields under the trigger.
  const first = state.first;
  const second = state.second;
  if (first !== null && first.shares > 0 && (second === null || (second.shares === 0 && second.put === null))) {
    const firstBreakEven = breakEvenAsTraded(first)!;
    const bestCall = callCandidates(firstBreakEven, false).calls[0] ?? null;
    const bestYield = bestCall?.premiumYield ?? 0;
    if (bestYield * 100 < v2.putTriggerCallYieldPct) {
      const strikeCap = volFarmerV2PutStrikeCap(firstBreakEven, v2.putStrikeBelowFirstBreakEvenPct);
      const { candidates: puts, rejections } = candidatesOf("P", { minAbsDelta: 0, maxAbsDelta: v2.putMaxAbsDelta, maximumStrike: strikeCap, heldExcluded: true });
      const freeCash = ledgerFreeCash(ledger);
      const wanted = (candidate: BaselineCandidate) => Math.min(Math.floor(state.potDollars / 2 / (candidate.strike * sharesPerContract) + 1e-9), Math.floor(freeCash / (candidate.strike * sharesPerContract) + 1e-9));
      const put = pickByVolume(puts, wanted, (candidate) => candidate.volumeCap);
      const trigger = bestCall === null ? `no Call at or above the first break-even ${firstBreakEven.toFixed(2)}` : `the best Call at or above the first break-even ${firstBreakEven.toFixed(2)} yields ${percent(bestYield, 2)} a year, under ${v2.putTriggerCallYieldPct}%`;
      if (put === null) say(`no Put: ${trigger}, but none qualifies at or below ${strikeCap.toFixed(2)} (${describeRejections(rejections) || "none listed"})`);
      else {
        const contracts = Math.min(wanted(put), put.volumeCap);
        if (contracts < 1) say(`no Put: ${trigger}, but the volume limit allows none`);
        else {
          state.second ??= { shares: 0, costPerShare: 0, premiumDollars: 0, call: null, put: null };
          state.cash.secondHalfLeft.push(state.potDollars / 2 - contracts * put.strike * sharesPerContract);
          say(sellPut(input, state.second, put, contracts, `${trigger}; strike at most ${strikeCap.toFixed(2)}`, priceToCycleScale, sharesPerContractOnCycleScale, stockPrice));
        }
      }
    }
  }

  // 4. The LEAPS, once the second position holds shares no Call at or above its break-even fits.
  if (secondFindsNoCall && state.second !== null && state.second.shares > 0 && state.leaps === null && !state.leapsBought) {
    say(buyLeaps(input, state, breakEvenAsTraded(state.second)!, priceToCycleScale, sharesPerContractOnCycleScale, riskFreeRate));
  }
  return finish();
}

function openOptionLegsOf(ledger: SimulatedLedger, symbol: string): LedgerLeg[] {
  return positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null && leg.legType === "option" && leg.expiryDate !== null && leg.strikePrice !== null));
}

/** Sells the look's Calls, one order per contract (positions picking the same one share it), each position's premium its share of the order's. */
function sellCalls(input: SymbolLook, orders: readonly { name: "first" | "second"; position: VolFarmerV2Position; call: BaselineCandidate; contracts: number }[], priceToCycleScale: number, sharesPerContractOnCycleScale: number, stockPrice: number): string {
  const { context, lookSymbol, at } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const byContract = new Map<string, typeof orders>();
  for (const order of orders) byContract.set(contractKeyOf(order.call), [...(byContract.get(contractKeyOf(order.call)) ?? []), order]);
  const descriptions: string[] = [];
  for (const group of byContract.values()) {
    const call = group[0]!.call;
    const contracts = group.reduce((sum, order) => sum + order.contracts, 0);
    const startsCycle = isSymbolFlat(ledger, symbol);
    const actionId = context.nextActionId();
    const opened = openCoveredCall(ledger, {
      symbol,
      expiryDate: call.expiry,
      strike: call.strike * priceToCycleScale,
      contracts,
      callFillPrice: call.fillPrice * priceToCycleScale,
      stockFillPrice: startsCycle ? stockPrice * priceToCycleScale : null,
      at,
      actionId,
      splitFactorToday: lookSymbol.splitFactorToday,
      sharesPerContract: sharesPerContractOnCycleScale,
      tradedSharesPerLedgerShare: priceToCycleScale,
    });
    context.priceByLegId.set(opened.callLegId, ((call.bid + call.ask) / 2) * priceToCycleScale);
    context.priceByLegId.set(opened.stockLegId, stockPrice * priceToCycleScale);
    if (opened.leftoverPositionId !== null) for (const leg of legsOfPosition(ledger, opened.leftoverPositionId)) context.priceByLegId.set(leg.id, stockPrice * priceToCycleScale);
    const commission = optionCommissionDollars(contracts);
    const whose: string[] = [];
    for (const order of group) {
      order.position.call = { legId: opened.callLegId, shares: order.contracts * sharesPerContractOnCycleScale };
      order.position.premiumDollars += call.fillPrice * sharesPerContract * order.contracts - (commission * order.contracts) / contracts;
      whose.push(`${order.name} position ${order.contracts}×, break-even now ${(volFarmerV2BreakEven(order.position)! / priceToCycleScale).toFixed(2)}`);
    }
    const contractLabel = describeOptionContract({ strike: call.strike, right: "C", expiry: call.expiry, dte: call.dte });
    const sharesNote = startsCycle ? ` with ${contracts * sharesPerContract} shares bought @ ${stockPrice.toFixed(2)}` : " on held shares";
    const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, call.fillPrice)}${sharesNote} (delta ${Math.abs(call.delta).toFixed(2)}, IV ${percent(call.impliedVolatility)}, premium yield ${percent(call.premiumYield)}; ${whose.join(", ")})`;
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
      chosenBecause: `vol farmer v2: the highest premium yield at or above the ${group.map((order) => order.name).join(" and ")} position's break-even, ${contracts < group.reduce((sum, order) => sum + Math.floor(order.position.shares / sharesPerContractOnCycleScale + 1e-9), 0) ? "the volume covering the most lots" : "its volume covering every lot"}`,
      outcome: "filled",
      blockReason: null,
      gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${contracts} contract(s): volume allows ${call.volumeCap}` }],
      contract: { strategyKey: "covered_call", expiry: call.expiry, strike: call.strike, right: "C" },
      candidateScores: { premiumYield: call.premiumYield, delta: call.delta, impliedVolatility: call.impliedVolatility, timeValue: call.timeValue, dte: call.dte, bid: call.bid, ask: call.ask, volumeCap: call.volumeCap, stockPrice },
      quantity: contracts,
      limitPrice: call.fillPrice,
      fillPrice: call.fillPrice,
      positionIds: [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])],
    });
    input.optionSales.push({ legId: opened.callLegId, actionId, symbol, openedOn: todayIso, strategyKey: "covered_call", expiry: call.expiry, strike: call.strike, optionRight: "C", contracts, bid: call.bid, ask: call.ask, fillPrice: call.fillPrice, commissionDollars: commission, spotAtOpen: stockPrice, sharePriceAtOpen: stockPrice, exposureDollars: ledgerCapitalAtRisk(ledger, opened.positionId) ?? (stockPrice - call.fillPrice) * sharesPerContract * contracts, dte: call.dte, delta: call.delta, grade: null, edgeMargin: null, expectedPnlDollars: null, calibratedExpectedPnlDollars: null, edgeYield: null, histYield: null, kellyContracts: null, stressContracts: null, priceToCycleScale });
    descriptions.push(description);
  }
  return descriptions.join(" · ");
}

function sellPut(input: SymbolLook, second: VolFarmerV2Position, put: BaselineCandidate, contracts: number, why: string, priceToCycleScale: number, sharesPerContractOnCycleScale: number, stockPrice: number): string {
  const { context, lookSymbol, at } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const actionId = context.nextActionId();
  const opened = openCashSecuredPut(ledger, { symbol, expiryDate: put.expiry, strike: put.strike * priceToCycleScale, contracts, fillPrice: put.fillPrice * priceToCycleScale, at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
  context.priceByLegId.set(opened.legId, ((put.bid + put.ask) / 2) * priceToCycleScale);
  const commission = optionCommissionDollars(contracts);
  second.put = { legId: opened.legId, shares: contracts * sharesPerContractOnCycleScale };
  second.premiumDollars += put.fillPrice * sharesPerContract * contracts - commission;
  const contractLabel = describeOptionContract({ strike: put.strike, right: "P", expiry: put.expiry, dte: put.dte });
  const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, put.fillPrice)} (second position: delta ${Math.abs(put.delta).toFixed(2)}, IV ${percent(put.impliedVolatility)}, premium yield ${percent(put.premiumYield)}; ${why})`;
  input.actions.push({
    actionId,
    tradingDate: todayIso,
    at: at.toISOString(),
    lookTimeEt: captureLookTimeEt,
    passNumber: 1,
    symbol,
    kind: "open_cash_secured_put",
    candidateId: openCandidateId(symbol, { strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike }),
    description,
    automatic: false,
    chosenBecause: `vol farmer v2: ${why}; the highest premium yield up to |delta| ${input.v2.putMaxAbsDelta}, on half the pot`,
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${contracts} contract(s): volume allows ${put.volumeCap}` }],
    contract: { strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike, right: "P" },
    candidateScores: { premiumYield: put.premiumYield, delta: put.delta, impliedVolatility: put.impliedVolatility, timeValue: put.timeValue, dte: put.dte, bid: put.bid, ask: put.ask, volumeCap: put.volumeCap, stockPrice },
    quantity: contracts,
    limitPrice: put.fillPrice,
    fillPrice: put.fillPrice,
    positionIds: [opened.positionId],
  });
  input.optionSales.push({ legId: opened.legId, actionId, symbol, openedOn: todayIso, strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike, optionRight: "P", contracts, bid: put.bid, ask: put.ask, fillPrice: put.fillPrice, commissionDollars: commission, spotAtOpen: stockPrice, sharePriceAtOpen: stockPrice, exposureDollars: ledgerCapitalAtRisk(ledger, opened.positionId) ?? (put.strike - put.fillPrice) * sharesPerContract * contracts, dte: put.dte, delta: put.delta, grade: null, edgeMargin: null, expectedPnlDollars: null, calibratedExpectedPnlDollars: null, edgeYield: null, histYield: null, kellyContracts: null, stressContracts: null, priceToCycleScale });
  return description;
}

/** A LEAPS the look may buy: the Call nearest the |delta| asked of the first listed expiry far enough out. */
export function chooseVolFarmerV2Leaps(input: { quotes: readonly { expiry: string; strike: number; right: "C" | "P"; bid: number | null; ask: number | null }[]; expiry: string; stockPrice: number; yearsToExpiry: number; riskFreeRate: number; absDelta: number; maxSpreadPctOfMid: number; spreadShareCharged: number }): { strike: number; bid: number; ask: number; fillPrice: number; delta: number; impliedVolatility: number } | null {
  const forward = input.stockPrice * Math.exp(input.riskFreeRate * input.yearsToExpiry);
  let best: { strike: number; bid: number; ask: number; fillPrice: number; delta: number; impliedVolatility: number } | null = null;
  for (const quote of input.quotes) {
    if (quote.right !== "C" || quote.expiry !== input.expiry || baselineQuoteRejection(quote, input.maxSpreadPctOfMid) !== null) continue;
    const mid = (quote.bid! + quote.ask!) / 2;
    const impliedVolatility = impliedVolatilityFromPrice(mid, forward, quote.strike, input.yearsToExpiry, input.riskFreeRate, true);
    if (impliedVolatility === null) continue;
    const delta = blackScholesDelta(forward, quote.strike, input.yearsToExpiry, input.riskFreeRate, impliedVolatility, true);
    if (best === null || Math.abs(delta - input.absDelta) < Math.abs(best.delta - input.absDelta) - 1e-12) best = { strike: quote.strike, bid: quote.bid!, ask: quote.ask!, fillPrice: optionPurchaseFillPrice(quote.bid!, quote.ask!, input.spreadShareCharged), delta, impliedVolatility };
  }
  return best;
}

function buyLeaps(input: SymbolLook, state: VolFarmerV2SymbolState, secondBreakEvenAsTraded: number, priceToCycleScale: number, sharesPerContractOnCycleScale: number, riskFreeRate: number): string {
  const { context, lookSymbol, v2, at } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.market.stockPrice;
  const freeCash = ledgerFreeCash(ledger);
  if (state.leapsTrigger === null) {
    state.leapsTrigger = { dateIso: todayIso, freeCash, contractCost: null, boughtOn: null, contracts: 0 };
    state.cash.leapsTriggers.push(state.leapsTrigger);
  }
  const log = state.leapsTrigger;
  const source = lookSymbol.leapsCallQuotes;
  const expiry = source?.listedExpiries().find((listed) => daysToExpiry(listed, todayIso) >= v2.leapsMinDte) ?? null;
  if (!source || expiry === null) return `no LEAPS: no Call expiry listed ${v2.leapsMinDte} or more days out`;
  const yearsToExpiry = Math.max(0, expirySettlementInstant(expiry).getTime() - at.getTime()) / millisecondsPerYear;
  const leaps = chooseVolFarmerV2Leaps({ quotes: source.quotesOf(expiry), expiry, stockPrice, yearsToExpiry, riskFreeRate, absDelta: v2.leapsAbsDelta, maxSpreadPctOfMid: input.farmer.maxSpreadPctOfMid, spreadShareCharged: context.settings.trading.spreadCostChargedPct / 100 });
  if (leaps === null) return `no LEAPS: no Call of ${expiry} has a usable quote`;
  const contractCost = leaps.fillPrice * sharesPerContract + optionCommissionDollars(1);
  if (log.contractCost === null) log.contractCost = contractCost;
  const contracts = contractsAffordable(freeCash, leaps.fillPrice);
  if (contracts < 1) return `no LEAPS: one contract of the ${leaps.strike} Call costs ${formatWholeDollars(contractCost)}, more than the free cash (${formatWholeDollars(freeCash)})`;
  const actionId = context.nextActionId();
  const opened = buyHedgePut(ledger, { symbol, expiryDate: expiry, strike: leaps.strike * priceToCycleScale, contracts, fillPrice: leaps.fillPrice * priceToCycleScale, at, actionId, sharesPerContract: sharesPerContractOnCycleScale, optionType: "call" });
  context.priceByLegId.set(opened.legId, ((leaps.bid + leaps.ask) / 2) * priceToCycleScale);
  state.leaps = { legId: opened.legId, expiry, strike: leaps.strike };
  state.leapsBought = true;
  log.boughtOn = todayIso;
  log.contracts = contracts;
  const dte = daysToExpiry(expiry, todayIso);
  const contractLabel = describeOptionContract({ strike: leaps.strike, right: "C", expiry, dte });
  const description = `${symbol} Buy ${contractLabel}${describeOrderSize(contracts, leaps.fillPrice)} (LEAPS: delta ${leaps.delta.toFixed(2)}, IV ${percent(leaps.impliedVolatility)}; the second position has no Call at or above its break-even ${secondBreakEvenAsTraded.toFixed(2)}; free cash ${formatWholeDollars(freeCash)})`;
  input.actions.push({
    actionId,
    tradingDate: todayIso,
    at: at.toISOString(),
    lookTimeEt: captureLookTimeEt,
    passNumber: 1,
    symbol,
    kind: "buy_hedge",
    candidateId: `${symbol}:leaps:${expiry}:${roundedStrike(leaps.strike)}`,
    description,
    automatic: false,
    chosenBecause: `vol farmer v2: the second position has no Call at or above its break-even; of the first expiry ${v2.leapsMinDte} or more days out, the Call whose |delta| is nearest ${v2.leapsAbsDelta}, with all the free cash`,
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${contracts} contract(s)` }],
    contract: { strategyKey: "hedge", expiry, strike: leaps.strike, right: "C" },
    candidateScores: { bid: leaps.bid, ask: leaps.ask, dte, stockPrice, impliedVolatility: leaps.impliedVolatility, delta: leaps.delta, freeCash, costDollars: leaps.fillPrice * sharesPerContract * contracts + optionCommissionDollars(contracts) },
    quantity: contracts,
    limitPrice: leaps.fillPrice,
    fillPrice: leaps.fillPrice,
    positionIds: [opened.positionId],
  });
  return description;
}

function sellLeaps(input: SymbolLook, state: VolFarmerV2SymbolState, priceToCycleScale: number): string {
  const { context, lookSymbol, at } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const leaps = state.leaps!;
  const leg = ledger.legs.find((candidate) => candidate.id === leaps.legId);
  if (!leg || leg.exitAt !== null) {
    state.leaps = null;
    state.leapsToSell = false;
    return "the LEAPS is no longer held";
  }
  const quote = lookSymbol.leapsCallQuotes?.quotesOf(leaps.expiry).find((candidate) => candidate.right === "C" && roundedStrike(candidate.strike) === roundedStrike(leaps.strike));
  if (!quote || quote.ask === null || !(quote.ask > 0)) return `the LEAPS is kept: no quote to sell the ${leaps.strike} Call at`;
  const fill = optionSaleFillPrice(quote.bid ?? 0, quote.ask, context.settings.trading.spreadCostChargedPct / 100);
  const actionId = context.nextActionId();
  sellHedgePut(ledger, { legId: leg.id, contracts: leg.quantity, fillPrice: fill * priceToCycleScale, at, actionId });
  state.leaps = null;
  state.leapsToSell = false;
  const contractLabel = describeOptionContract({ strike: leaps.strike, right: "C", expiry: leaps.expiry, dte: daysToExpiry(leaps.expiry, todayIso) });
  const description = `${symbol} Sell ${contractLabel}${describeOrderSize(leg.quantity, fill)} (LEAPS: the second position was called away)`;
  input.actions.push({
    actionId,
    tradingDate: todayIso,
    at: at.toISOString(),
    lookTimeEt: captureLookTimeEt,
    passNumber: 1,
    symbol,
    kind: "sell_hedge",
    candidateId: `${symbol}:leaps:${leaps.expiry}:${roundedStrike(leaps.strike)}`,
    description,
    automatic: true,
    chosenBecause: "vol farmer v2: the second position was called away, so its LEAPS is sold",
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${leg.quantity} contract(s)` }],
    contract: { strategyKey: "hedge", expiry: leaps.expiry, strike: leaps.strike, right: "C" },
    candidateScores: { bid: quote.bid, ask: quote.ask, stockPrice: lookSymbol.market.stockPrice },
    quantity: leg.quantity,
    limitPrice: fill,
    fillPrice: fill,
    positionIds: [leg.positionId],
  });
  return description;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};

/**
 * The session note on Vol Farmer v2's cash (Marcelo 2026-10-27, "test that there is cash to spare"): what each half of the
 * pot left unspent once sized (whole lots, whole contracts), and every LEAPS trigger: the free cash then against one
 * contract's cost, and what was bought.
 */
export function describeVolFarmerV2Run(ledger: SimulatedLedger, symbols: readonly string[]): string | null {
  const bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) return null;
  const parts = symbols.flatMap((symbol) => {
    const cash = bySymbol.get(symbol)?.cash;
    if (!cash) return [];
    const left = (values: readonly number[]) => (values.length === 0 ? "none sized" : `median ${formatWholeDollars(median(values)!)} (${formatWholeDollars(Math.min(...values))} to ${formatWholeDollars(Math.max(...values))}, ${values.length}×)`);
    const triggers = cash.leapsTriggers;
    const bought = triggers.filter((trigger) => trigger.boughtOn !== null);
    const unaffordable = triggers.filter((trigger) => trigger.boughtOn === null && trigger.contractCost !== null && trigger.contractCost > trigger.freeCash);
    const leapsPart = triggers.length === 0 ? "no LEAPS trigger" : `${triggers.length} LEAPS trigger(s), ${bought.length} bought (${bought.map((trigger) => `${trigger.contracts}× on ${trigger.boughtOn}`).join(", ") || "none"})${unaffordable.length === 0 ? "" : `, ${unaffordable.length} never affordable (first: free cash ${formatWholeDollars(unaffordable[0]!.freeCash)} on ${unaffordable[0]!.dateIso}, a contract ${formatWholeDollars(unaffordable[0]!.contractCost!)})`}`;
    return [`${symbols.length > 1 ? `${symbol}: ` : ""}${cash.cycles} cycle(s); unspent once sized: first half ${left(cash.firstHalfLeft)}, second half ${left(cash.secondHalfLeft)}; ${leapsPart}`];
  });
  return parts.length === 0 ? null : `Vol Farmer v2 cash: ${parts.join(" · ")}.`;
}
