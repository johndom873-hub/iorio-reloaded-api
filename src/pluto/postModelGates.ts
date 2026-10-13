import type { CandidateModelScore, SignalCandidate } from "../lib/signalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import { expectedDailyMovePct } from "./moveContext.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import type { PlutoGateResult } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";
import { describeOptionContract } from "../lib/optionContractLabel.js";
import { formatSignedDollars } from "../lib/formatSignedDollars.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { checkHeldShareCallStrike, commissionPerShare, describeCalledAwayShortfall, type CycleBreakEven } from "./heldShareCalls.js";

// Post-model validation (design round 3, item 21, approved 2026-09-28). Nothing the model said
// is trusted: the chosen candidate is re-scored on fresh quotes and re-filtered by the caller,
// and this module re-derives everything else — confidence, drift, capacity, the quantity (code
// sizes in dollars from the standard order size) and the limit price. Pure, so every rule is unit-tested.
// The platform's order gate (halt, limits from trading_settings including working orders, delta band, close gate,
// limit-price check) runs again at build and confirm, and in the worker before placement, on top of this.

export interface PostModelBookInput {
  netLiquidationValue: number;
  freeCash: number;
  /** Capital the book already commits: every open position on an enabled ticker, hedges aside (book.ts). */
  committedDollars: number;
  /**
   * Notional of orders confirmed but not yet done (the same statuses and formula as the order gate's limits): every
   * origin's, this symbol's, and the book's (Pluto's orders plus anyone's on an enabled ticker). Room is sized net of them,
   * so Pluto never sizes what the gate would refuse.
   */
  inFlight: { totalNotional: number; tickerNotional: number; managedNotional: number };
  openPositionCount: number;
  /** Every open position's exposure on this symbol and sector, humans' included (computePositionExposures). */
  existingTickerExposure: number;
  existingSectorExposure: number;
  /** Uncovered shares of the symbol: a buy-write buys only what they do not cover; a round lot of them is code's (runHeldShareCallGates). */
  freeShares: number;
  /** Live underlying price: a covered call buys 100 shares per contract beyond the free ones (buy-write). */
  spotPrice: number | null;
  workingOrderOnSymbol: boolean;
  /** When Pluto last acted on this symbol with an order that filled (fully or partly); null if never. */
  lastFilledActionAt: Date | null;
  nowMs: number;
  /**
   * An open position (anyone's) or a working order on the same ticker, expiry and strike, puts and calls alike
   * (Marcelo, 2026-10-06): the platform keeps one position per contract, so a second order would merge into it.
   * Null when the contract is free; otherwise what occupies it, for the gate's detail.
   */
  sameContractConflict: string | null;
}

export interface PostModelGateInput {
  decision: PlutoDecision;
  /** The fresh re-score of the chosen open candidate (null for rolls). */
  candidate: SignalCandidate | null;
  /** The fresh re-score of the chosen roll (null for opens). */
  roll: RollSignalCandidate | null;
  /** Reasons the fresh re-filter rejected the choice; empty means it still qualifies. */
  freshRejectionReasons: string[];
  /** The valuation model's edge margin (fraction, before friction) the model saw when it decided: the open's, or the roll's. */
  marginAtDecision: number;
  settings: PlutoSettings;
  book: PostModelBookInput;
  sector: string | null;
  /** What the stress cap needs about the ticker today (fresh re-score). */
  stress: StressCapInput;
  /** Share of full Kelly to size with; Pluto's fixed kellyFraction when omitted (a backtest session passes its own). */
  kellyFraction?: number;
  /** What the Kelly cap's μ is; Edge $ when omitted (a backtest session may pass its own). */
  kellyBasis?: KellyEdgeBasis;
}

export interface StressCapInput {
  /** The valuation model's forecast (YZ21) annualized on sessions; null means the cap cannot be sized and the order is refused. */
  forecastVolatility: number | null;
  elevatedVolatility: boolean;
  /** Today's move in normal days (day change ÷ forecast daily move); null when either is unknown. */
  dayMoveSigmas: number | null;
}

/** What the sizing gate's stress cap needs about the ticker today: the valuation model's forecast (YZ21), the vol flag and today's move. */
export function stressCapInputFor(ticker: Pick<TickerSignals, "modelForecast" | "elevatedVolatility" | "dayChangePercent">): StressCapInput {
  return stressCapInputFromFigures(ticker.modelForecast?.annualizedVolatility ?? null, ticker.elevatedVolatility?.elevated === true, ticker.dayChangePercent);
}

/** The same from the bare figures: forecast (annualized on sessions), whether volatility is elevated, today's change in %. */
export function stressCapInputFromFigures(forecastVolatility: number | null, elevatedVolatility: boolean, dayChangePercent: number | null): StressCapInput {
  const normalDayMovePct = expectedDailyMovePct(forecastVolatility);
  return {
    forecastVolatility,
    elevatedVolatility,
    dayMoveSigmas: dayChangePercent !== null && normalDayMovePct !== null ? dayChangePercent / normalDayMovePct : null,
  };
}

export interface PlutoOrderPlan {
  quantity: number;
  limitPrice: number;
  /** Cash this order commits (0 for a call code sells on held shares). */
  notional: number;
  fullSizeQuantity: number;
}

export interface PostModelGateOutput {
  ok: boolean;
  gates: PlutoGateResult[];
  plan: PlutoOrderPlan | null;
}

export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sell at the mid, rounded to cents, clamped inside the current market (design item 22: mid, no concession). */
export function midLimitPrice(bid: number, ask: number): number {
  return Math.min(ask, Math.max(bid, roundToCents((bid + ask) / 2)));
}

export interface SizingRoom {
  budgetRoom: number;
  /** The standard order size: NLV × capital budget % × order size % (Marcelo, 2026-10-06). */
  orderCap: number;
  tickerRoom: number;
  sectorRoom: number;
  cashRoom: number;
}

export function computeSizingRoom(settings: PlutoSettings, book: PostModelBookInput, sectorKnown: boolean): SizingRoom {
  const nlv = book.netLiquidationValue;
  return {
    budgetRoom: (nlv * settings.capitalBudgetPct) / 100 - book.committedDollars - book.inFlight.managedNotional,
    orderCap: (((nlv * settings.capitalBudgetPct) / 100) * settings.orderSizePctOfBudget) / 100,
    tickerRoom: (nlv * settings.maxTickerExposurePct) / 100 - book.existingTickerExposure - book.inFlight.tickerNotional,
    sectorRoom: sectorKnown && settings.maxSectorExposurePct < 100 ? (nlv * settings.maxSectorExposurePct) / 100 - book.existingSectorExposure : Number.POSITIVE_INFINITY,
    cashRoom: book.freeCash - book.inFlight.totalNotional - (nlv * settings.minCashReservePct) / 100,
  };
}

function describeRoom(room: SizingRoom): string {
  const parts = [`order size ${formatWholeDollars(room.orderCap)}`, `budget left ${formatWholeDollars(room.budgetRoom)}`, `ticker room ${formatWholeDollars(room.tickerRoom)}`, `cash room ${formatWholeDollars(room.cashRoom)}`];
  if (Number.isFinite(room.sectorRoom)) parts.push(`sector room ${formatWholeDollars(room.sectorRoom)}`);
  return parts.join(", ");
}

function volumeCap(volume: number | null, settings: PlutoSettings): number {
  return volume === null ? 0 : Math.floor((volume * settings.maxContractsVolumeSharePct) / 100);
}

/** The ticker cooldown: over once tickerCooldownMinutes have passed since the last Pluto action on the symbol whose order filled. */
export function tickerCooldownStatus(lastFilledActionAt: Date | null, nowMs: number, cooldownMinutes: number): { cooledDown: boolean; detail: string } {
  if (lastFilledActionAt === null) return { cooledDown: true, detail: "no filled Pluto action on this symbol" };
  const minutesSinceLastFill = (nowMs - lastFilledActionAt.getTime()) / 60_000;
  return {
    cooledDown: cooldownMinutes === 0 || minutesSinceLastFill >= cooldownMinutes,
    detail: `last filled Pluto action on this symbol ${Math.floor(minutesSinceLastFill)} min ago (cooldown ${cooldownMinutes} min)`,
  };
}

// Stress cap (Marcelo, 2026-10-08; on the valuation model's forecast and variance clock since 2026-10-10): the risk an
// order adds is sized so that an adverse move of k forecast standard deviations by expiry loses at most
// stressRiskBudgetPct of the account.
//   σ_T = forecast volatility (YZ21, per session ×√252) × √(τ ÷ 252)     τ = variance sessions to the expiry close
//   k   = stressSigmas + 0.5 if the stock is in an elevated-volatility stretch + 0.5 if today it is down more than one normal day
//   stressed spot = spot × (1 − k × σ_T)
//   loss per contract: cash-secured put = max(0, strike − stressed spot) × 100 − mid × 100
//                      covered call bought with new shares = (spot − stressed spot) × 100 − mid × 100
//   contracts = floor(account × stressRiskBudgetPct ÷ 100 ÷ loss per contract)   (no limit when the loss is ≤ 0)
// The two add-ons are fixed here, not settings (Marcelo, 2026-10-08). A call written on shares already held adds no risk and is not capped.
export const stressSigmasElevatedVolatilityAddOn = 0.5;
export const stressSigmasAdverseDayAddOn = 0.5;
/** Down more than this many normal days today counts as an adverse day. */
export const adverseDayMoveSigmas = 1;

export interface StressCap {
  /** Contracts of new risk the cap allows (Infinity when it does not bind or is off). */
  contracts: number;
  detail: string;
}

export function computeStressCap(settings: PlutoSettings, stress: StressCapInput, contract: Pick<SignalCandidate, "strategyKey" | "strike" | "bid" | "ask"> & { model: Pick<CandidateModelScore, "varianceSessions"> | null }, spotPrice: number | null, netLiquidationValue: number): StressCap {
  if (settings.stressRiskBudgetPct <= 0) return { contracts: Number.POSITIVE_INFINITY, detail: "stress cap off" };
  if (stress.forecastVolatility === null || !(stress.forecastVolatility > 0) || spotPrice === null || !(spotPrice > 0) || !contract.model) return { contracts: 0, detail: "stress cap: no volatility forecast, model valuation or live spot to size it" };
  const varianceSessions = contract.model.varianceSessions;
  const sigmaToExpiry = stress.forecastVolatility * Math.sqrt(varianceSessions / 252);
  const adverseDay = stress.dayMoveSigmas !== null && stress.dayMoveSigmas <= -adverseDayMoveSigmas;
  const sigmas = settings.stressSigmas + (stress.elevatedVolatility ? stressSigmasElevatedVolatilityAddOn : 0) + (adverseDay ? stressSigmasAdverseDayAddOn : 0);
  const stressedSpot = Math.max(0, spotPrice * (1 - sigmas * sigmaToExpiry));
  const mid = (contract.bid + contract.ask) / 2;
  const lossPerContract = contract.strategyKey === "covered_call" ? (spotPrice - stressedSpot) * 100 - mid * 100 : Math.max(0, contract.strike - stressedSpot) * 100 - mid * 100;
  const budgetDollars = (netLiquidationValue * settings.stressRiskBudgetPct) / 100;
  const contracts = lossPerContract > 0 ? Math.floor(budgetDollars / lossPerContract) : Number.POSITIVE_INFINITY;
  const why = [stress.elevatedVolatility ? "elevated volatility" : null, adverseDay ? "down more than a normal day" : null].filter(Boolean).join(", ");
  return {
    contracts,
    detail: `stress cap: a ${sigmas}σ${why ? ` (${why})` : ""} move to expiry (−${(Math.min(1, sigmas * sigmaToExpiry) * 100).toFixed(1)}% over ${varianceSessions.toFixed(2)} sessions of variance) loses ${formatWholeDollars(lossPerContract)}/contract → ${Number.isFinite(contracts) ? contracts : "no limit"} within ${formatWholeDollars(budgetDollars)} (${settings.stressRiskBudgetPct}% of account)`,
  };
}

// Half-Kelly cap (model review P5, approved by Marcelo 2026-10-10; half-Kelly on the model's Edge $ since 2026-10-12, was
// quarter-Kelly on Hist Edge $): one more cap on the number of contracts, never a reason to trade more than the other caps allow.
//   contracts ≤ floor(kellyFraction × bankroll × μ ÷ σ²)
//   μ  = the model's expected P&L per contract after friction (Edge $)
//   σ² = the variance of the per-contract P&L under the model's distribution, on the same basis as the risk figures: the
//        option for a put; 100 shares plus the short call for every covered call, on shares already held or bought with it
//   bankroll = Pluto's capital budget (net liquidation × capitalBudgetPct)
// Example: AAPL $330 Put · 14 Oct (5DTE) on staging 2026-10-09: 0.5 × $519,698 × $43 ÷ $402² = 69.1 → 69 contracts.
// No contracts when μ ≤ 0. A covered call's cap covers all its contracts together.
export const kellyFraction = 0.5;

export interface KellyCap {
  contracts: number;
  detail: string;
}

/** What μ is: the model's Edge $ (live), or history's Hist Edge $ (live until 2026-10-12; a backtest session may choose it). */
export type KellyEdgeBasis = "edge_dollars" | "hist_edge_dollars";

/** `fraction` is Pluto's fixed kellyFraction live and `basis` Edge $; a backtest session sizes with its own. */
export function computeKellyCap(
  settings: PlutoSettings,
  contract: Pick<SignalCandidate, "strategyKey"> & { model: (Pick<CandidateModelScore, "expectedPnlDollars" | "pnlVarianceDollars" | "coveredPositionPnlVarianceDollars"> & Partial<Pick<CandidateModelScore, "calibratedExpectedPnlDollars">>) | null },
  netLiquidationValue: number,
  fraction: number = kellyFraction,
  basis: KellyEdgeBasis = "edge_dollars",
): KellyCap {
  const model = contract.model;
  if (!model) return { contracts: 0, detail: "Kelly cap: the contract has no model valuation" };
  const bankroll = (netLiquidationValue * settings.capitalBudgetPct) / 100;
  const mu = basis === "hist_edge_dollars" ? (model.calibratedExpectedPnlDollars ?? Number.NaN) : model.expectedPnlDollars;
  const edgeLabel = basis === "hist_edge_dollars" ? "Hist Edge" : "Edge";
  if (!(mu > 0)) return { contracts: 0, detail: `Kelly cap: ${edgeLabel} ${formatWholeDollars(mu)}/contract ≤ 0, so no contracts` };
  const isCall = contract.strategyKey === "covered_call";
  const variance = isCall ? model.coveredPositionPnlVarianceDollars : model.pnlVarianceDollars;
  const contracts = variance !== null && variance > 0 ? Math.floor((fraction * bankroll * mu) / variance) : 0;
  return {
    contracts,
    detail: `Kelly cap: ${fraction} × ${formatWholeDollars(bankroll)} budget × ${edgeLabel} ${formatWholeDollars(mu)}/contract ÷ P&L variance${isCall ? " (shares + call)" : ""} → ${contracts} contract(s)`,
  };
}

export function runPostModelGates(input: PostModelGateInput): PostModelGateOutput {
  const { decision, settings, book } = input;
  const gates: PlutoGateResult[] = [];
  const gate = (name: string, ok: boolean, detail: string) => gates.push({ gate: name, ok, detail });

  gate("verdict", decision.decision === "trade", decision.decision === "trade" ? "trade" : `model said ${decision.decision}`);
  gate("confidence_floor", decision.confidence >= settings.confidenceFloor, `${decision.confidence.toFixed(2)} vs floor ${settings.confidenceFloor}`);
  gate("candidate_fresh", input.freshRejectionReasons.length === 0, input.freshRejectionReasons.length === 0 ? "still passes every filter on fresh quotes" : input.freshRejectionReasons.join("; "));

  const isRoll = decision.actionKind === "roll";
  const candidate = isRoll ? input.roll?.replacement ?? null : input.candidate;
  if (!candidate) {
    gate("candidate_present", false, "the chosen candidate could not be re-scored");
    return { ok: false, gates, plan: null };
  }
  const marginNow = isRoll ? input.roll!.model?.edgeMargin ?? null : candidate.model?.edgeMargin ?? null;
  const driftPoints = marginNow === null ? null : Math.abs(marginNow - input.marginAtDecision) * 100;
  gate("edge_drift", driftPoints !== null && driftPoints <= settings.maxEdgeMarginDriftPts, driftPoints === null ? "the fresh re-score has no model valuation" : `edge margin moved ${driftPoints.toFixed(1)} points since the decision, max ${settings.maxEdgeMarginDriftPts}`);
  gate("working_order", !book.workingOrderOnSymbol, book.workingOrderOnSymbol ? "a Pluto order on this symbol is already working" : "no working Pluto order on the symbol");
  const cooldown = tickerCooldownStatus(book.lastFilledActionAt, book.nowMs, settings.tickerCooldownMinutes);
  gate("ticker_cooldown", cooldown.cooledDown, cooldown.detail);
  if (!isRoll) gate("open_positions_cap", book.openPositionCount < settings.maxOpenPositions, `${book.openPositionCount} of ${settings.maxOpenPositions} managed positions`);
  gate("same_contract", book.sameContractConflict === null, book.sameContractConflict ?? `no open position or working order on ${describeOptionContract({ strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P", expiry: candidate.expiry, dte: candidate.dte })}`);

  // Sizing in dollars: the standard order size, less only where a tighter limit binds; contracts follow from it. A contract's
  // notional is its exposure net of the premium at the order's limit price (Marcelo 2026-10-12), as the order gate counts it.
  const room = computeSizingRoom(settings, book, input.sector !== null);
  const limitPrice = midLimitPrice(candidate.bid, candidate.ask);
  const liquidityCap = volumeCap(candidate.volume, settings);
  let fullSizeQuantity: number;
  let unitNotional: number;
  if (isRoll) {
    const roll = input.roll!;
    fullSizeQuantity = roll.quantity; // rolls keep the held leg's quantity (design item 64)
    // A roll re-uses the closed leg's collateral; only a cash-secured put whose strike rise beats its net credit adds cash (per contract).
    unitNotional = roll.strategyKey === "cash_secured_put" ? Math.max(0, roll.dollarRiskChange) : 0;
    gate("sizing", fullSizeQuantity >= 1, `roll keeps the held quantity of ${fullSizeQuantity}`);
  } else if (candidate.strategyKey === "cash_secured_put") {
    unitNotional = (candidate.strike - limitPrice) * 100;
    const roomDollars = Math.min(room.budgetRoom, room.orderCap, room.tickerRoom, room.sectorRoom, room.cashRoom);
    const byRoom = Math.floor(Math.max(0, roomDollars) / unitNotional);
    const stressCap = computeStressCap(settings, input.stress, candidate, book.spotPrice, book.netLiquidationValue);
    const kellyCap = computeKellyCap(settings, candidate, book.netLiquidationValue, input.kellyFraction, input.kellyBasis);
    fullSizeQuantity = Math.min(byRoom, liquidityCap, stressCap.contracts, kellyCap.contracts);
    gate("sizing", fullSizeQuantity >= 1, `${describeRoom(room)} → ${byRoom} contract(s) at ${formatWholeDollars(unitNotional)} each; volume share allows ${liquidityCap}; ${stressCap.detail}; ${kellyCap.detail} → ${formatWholeDollars(fullSizeQuantity * unitNotional)}`);
  } else {
    // Covered calls (Marcelo, 2026-09-28): contracts already covered by free shares cost nothing; every further
    // contract is a buy-write that buys 100 shares at the live spot, sized from the same room as a put.
    const kellyCap = computeKellyCap(settings, candidate, book.netLiquidationValue, input.kellyFraction, input.kellyBasis);
    // One Kelly cap for all the call's contracts, on shares + call: free-share contracts first, buy-writes within what is left.
    const coveredByShares = Math.min(Math.floor(book.freeShares / 100), kellyCap.contracts);
    if (book.spotPrice === null || !(book.spotPrice > 0)) {
      unitNotional = 0;
      fullSizeQuantity = Math.min(coveredByShares, liquidityCap);
      gate("sizing", fullSizeQuantity >= 1, `no live spot to price the shares to buy; ${book.freeShares} free shares cover ${coveredByShares} contract(s) within the Kelly cap (${kellyCap.detail}), volume share allows ${liquidityCap}`);
    } else {
      unitNotional = (book.spotPrice - limitPrice) * 100;
      const roomDollars = Math.min(room.budgetRoom, room.orderCap, room.tickerRoom, room.sectorRoom, room.cashRoom);
      // Only the contracts that buy shares add risk, so only they are stress-capped.
      const stressCap = computeStressCap(settings, input.stress, candidate, book.spotPrice, book.netLiquidationValue);
      const buyWriteContracts = Math.min(Math.floor(Math.max(0, roomDollars) / unitNotional), stressCap.contracts, Math.max(0, kellyCap.contracts - coveredByShares));
      fullSizeQuantity = Math.min(coveredByShares + buyWriteContracts, liquidityCap);
      gate("sizing", fullSizeQuantity >= 1, `${book.freeShares} free shares cover ${coveredByShares} contract(s) within the Kelly cap, room allows ${buyWriteContracts} more contract(s) buying 100 shares each at ${book.spotPrice.toFixed(2)} less the ${limitPrice.toFixed(2)} premium (${describeRoom(room)}; ${stressCap.detail}; ${kellyCap.detail}), volume share allows ${liquidityCap}`);
    }
    // Only the shares actually bought count as notional: the free-share contracts commit no new cash.
    unitNotional = fullSizeQuantity > 0 ? (Math.max(0, fullSizeQuantity - coveredByShares) * unitNotional) / fullSizeQuantity : 0;
  }
  const quantity = fullSizeQuantity;

  gate("limit_price", limitPrice >= candidate.bid && limitPrice <= candidate.ask && limitPrice > 0, `mid ${limitPrice.toFixed(2)} inside ${candidate.bid.toFixed(2)}–${candidate.ask.toFixed(2)}`);

  const ok = gates.every((entry) => entry.ok);
  return { ok, gates, plan: ok ? { quantity, limitPrice, notional: unitNotional * quantity, fullSizeQuantity } : null };
}

export interface HeldShareCallGateInput {
  /** The call code chose on fresh quotes (selectHeldShareCall), or null when none is left. */
  candidate: SignalCandidate | null;
  settings: PlutoSettings;
  book: Pick<PostModelBookInput, "freeShares" | "workingOrderOnSymbol" | "lastFilledActionAt" | "nowMs" | "sameContractConflict">;
  /** The ticker's open cycle: the break-even rule is checked again at the size sent and the limit price. */
  cycleBreakEven: CycleBreakEven | null;
  /** False in a backtest, whose quotes are taken at the look's own instant: no live-quote gate. True when omitted. */
  requireLiveQuote?: boolean;
}

/**
 * The gates on a call code sells on free shares (Marcelo, 2026-10-12), in place of the post-model gates: no verdict,
 * confidence or edge drift (no model chose it), no budget, exposure, positions, stress, Kelly or volume cap (it adds no
 * exposure and covers every free round lot). The kill switch, pause, breakers and the session's action cap are the
 * round's own checks; the order route's gates run on top.
 */
export function runHeldShareCallGates(input: HeldShareCallGateInput): PostModelGateOutput {
  const { candidate, settings, book } = input;
  const gates: PlutoGateResult[] = [];
  const gate = (name: string, ok: boolean, detail: string) => gates.push({ gate: name, ok, detail });
  if (!candidate) {
    gate("candidate_present", false, "no call on the held shares passes every rule on fresh quotes");
    return { ok: false, gates, plan: null };
  }
  if (input.requireLiveQuote !== false) gate("live_quote", candidate.quoteSource === "live", candidate.quoteSource === "live" ? "priced from a live quote" : `priced from a ${candidate.quoteSource} quote, not a live one`);
  gate("working_order", !book.workingOrderOnSymbol, book.workingOrderOnSymbol ? "a Pluto order on this symbol is already working" : "no working Pluto order on the symbol");
  const cooldown = tickerCooldownStatus(book.lastFilledActionAt, book.nowMs, settings.tickerCooldownMinutes);
  gate("ticker_cooldown", cooldown.cooledDown, cooldown.detail);
  gate("same_contract", book.sameContractConflict === null, book.sameContractConflict ?? `no open position or working order on ${describeOptionContract({ strike: candidate.strike, right: "C", expiry: candidate.expiry, dte: candidate.dte })}`);
  const contracts = Math.floor(book.freeShares / 100);
  gate("sizing", contracts >= 1, `${book.freeShares} free shares cover ${contracts} contract(s), no shares bought`);
  const limitPrice = midLimitPrice(candidate.bid, candidate.ask);
  const calledAway = checkHeldShareCallStrike({ cycle: input.cycleBreakEven, strike: candidate.strike, contracts: Math.max(1, contracts), cashPerShareCovered: limitPrice - commissionPerShare(candidate.commissionPerContractDollars), settings });
  gate(
    "break_even",
    calledAway.check?.passes === true,
    !calledAway.check
      ? `no cycle break-even for the held shares: ${calledAway.unavailableReason}`
      : calledAway.check.passes
        ? `strike at or above the cycle break-even of ${calledAway.check.breakEvenBefore.toFixed(2)}; if assigned, ${100 * contracts} shares close ${formatSignedDollars(calledAway.check.profitIfCalledAway, 0)} over the break-even of ${calledAway.check.breakEvenAfter.toFixed(2)} after this premium, minimum ${formatSignedDollars(calledAway.check.floor, 0)}`
        : describeCalledAwayShortfall(candidate.strike, contracts, calledAway.check),
  );
  gate("limit_price", limitPrice >= candidate.bid && limitPrice <= candidate.ask && limitPrice > 0, `mid ${limitPrice.toFixed(2)} inside ${candidate.bid.toFixed(2)}–${candidate.ask.toFixed(2)}`);
  const ok = gates.every((entry) => entry.ok);
  return { ok, gates, plan: ok ? { quantity: contracts, limitPrice, notional: 0, fullSizeQuantity: contracts } : null };
}
