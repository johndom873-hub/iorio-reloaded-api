import { tradingSessionsByExpiry } from "../lib/volatilityEdge.js";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import type { PlutoGateResult } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";
import { describeOptionContract } from "../lib/optionContractLabel.js";

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
  /** Uncovered shares of the symbol Pluto may write calls against without buying any. */
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
  /** Net edge (fraction) the model saw when it decided. */
  netEdgeAtDecision: number;
  settings: PlutoSettings;
  book: PostModelBookInput;
  sector: string | null;
  /** What the stress cap needs about the ticker today (fresh re-score). */
  stress: StressCapInput;
}

export interface StressCapInput {
  /** Annualised Yang-Zhang forecast (decimal); null means the cap cannot be sized and the order is refused. */
  forecastVolatility: number | null;
  elevatedVolatility: boolean;
  /** Today's move in normal days (day change ÷ forecast daily move); null when either is unknown. */
  dayMoveSigmas: number | null;
  todayEasternIso: string;
  /** Open sessions after todayEasternIso (the scoring inputs' list, which reaches every fitted expiry). */
  openSessionDatesIso: string[];
}

export interface PlutoOrderPlan {
  quantity: number;
  limitPrice: number;
  /** Cash this order commits (0 for a covered call on held shares). */
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
  const parts = [`order size $${room.orderCap.toFixed(0)}`, `budget left $${room.budgetRoom.toFixed(0)}`, `ticker room $${room.tickerRoom.toFixed(0)}`, `cash room $${room.cashRoom.toFixed(0)}`];
  if (Number.isFinite(room.sectorRoom)) parts.push(`sector room $${room.sectorRoom.toFixed(0)}`);
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

// Stress cap (Marcelo, 2026-10-08): the risk an order adds is sized so that an adverse move of k forecast standard deviations
// by expiry loses at most stressRiskBudgetPct of the account.
//   σ_T = forecast volatility × √(trading days to expiry ÷ 252)          (weekdays, holidays not excluded)
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

export function computeStressCap(settings: PlutoSettings, stress: StressCapInput, contract: Pick<SignalCandidate, "strategyKey" | "strike" | "expiry" | "bid" | "ask">, spotPrice: number | null, netLiquidationValue: number): StressCap {
  if (settings.stressRiskBudgetPct <= 0) return { contracts: Number.POSITIVE_INFINITY, detail: "stress cap off" };
  if (stress.forecastVolatility === null || !(stress.forecastVolatility > 0) || spotPrice === null || !(spotPrice > 0)) return { contracts: 0, detail: "stress cap: no volatility forecast or live spot to size it" };
  const tradingDays = Math.max(1, tradingSessionsByExpiry([contract.expiry], stress.openSessionDatesIso, stress.todayEasternIso).get(contract.expiry) ?? 0);
  const sigmaToExpiry = stress.forecastVolatility * Math.sqrt(tradingDays / 252);
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
    detail: `stress cap: a ${sigmas}σ${why ? ` (${why})` : ""} move to expiry (−${(Math.min(1, sigmas * sigmaToExpiry) * 100).toFixed(1)}% in ${tradingDays} trading day(s)) loses $${lossPerContract.toFixed(0)}/contract → ${Number.isFinite(contracts) ? contracts : "no limit"} within $${budgetDollars.toFixed(0)} (${settings.stressRiskBudgetPct}% of account)`,
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
  const netEdgeNow = isRoll ? input.roll!.netRollEdge : candidate.netEdge;
  const driftVp = Math.abs(netEdgeNow - input.netEdgeAtDecision) * 100;
  gate("edge_drift", driftVp <= settings.maxEdgeDriftVp, `${driftVp.toFixed(2)} vp since the decision, max ${settings.maxEdgeDriftVp}`);
  gate("working_order", !book.workingOrderOnSymbol, book.workingOrderOnSymbol ? "a Pluto order on this symbol is already working" : "no working Pluto order on the symbol");
  const cooldown = tickerCooldownStatus(book.lastFilledActionAt, book.nowMs, settings.tickerCooldownMinutes);
  gate("ticker_cooldown", cooldown.cooledDown, cooldown.detail);
  if (!isRoll) gate("open_positions_cap", book.openPositionCount < settings.maxOpenPositions, `${book.openPositionCount} of ${settings.maxOpenPositions} managed positions`);
  gate("same_contract", book.sameContractConflict === null, book.sameContractConflict ?? `no open position or working order on ${describeOptionContract({ strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P", expiry: candidate.expiry, dte: candidate.dte })}`);

  // Sizing in dollars: the standard order size, less only where a tighter limit binds; contracts follow from it.
  const room = computeSizingRoom(settings, book, input.sector !== null);
  const liquidityCap = volumeCap(candidate.volume, settings);
  let fullSizeQuantity: number;
  let unitNotional: number;
  if (isRoll) {
    const roll = input.roll!;
    fullSizeQuantity = roll.quantity; // rolls keep the held leg's quantity (design item 64)
    // A roll re-uses the closed leg's collateral; only a cash-secured put moving UP in strike adds cash (per contract).
    unitNotional = roll.strategyKey === "cash_secured_put" ? Math.max(0, roll.dollarRiskChange) : 0;
    gate("sizing", fullSizeQuantity >= 1, `roll keeps the held quantity of ${fullSizeQuantity}`);
  } else if (candidate.strategyKey === "cash_secured_put") {
    unitNotional = candidate.strike * 100;
    const roomDollars = Math.min(room.budgetRoom, room.orderCap, room.tickerRoom, room.sectorRoom, room.cashRoom);
    const byRoom = Math.floor(Math.max(0, roomDollars) / unitNotional);
    const stressCap = computeStressCap(settings, input.stress, candidate, book.spotPrice, book.netLiquidationValue);
    fullSizeQuantity = Math.min(byRoom, liquidityCap, stressCap.contracts);
    gate("sizing", fullSizeQuantity >= 1, `${describeRoom(room)} → ${byRoom} contract(s) at $${unitNotional.toFixed(0)} each; volume share allows ${liquidityCap}; ${stressCap.detail} → $${(fullSizeQuantity * unitNotional).toFixed(0)}`);
  } else {
    // Covered calls (Marcelo, 2026-09-28): contracts already covered by free shares cost nothing; every further
    // contract is a buy-write that buys 100 shares at the live spot, sized from the same room as a put.
    const coveredByShares = Math.floor(book.freeShares / 100);
    if (book.spotPrice === null || !(book.spotPrice > 0)) {
      unitNotional = 0;
      fullSizeQuantity = Math.min(coveredByShares, liquidityCap);
      gate("sizing", fullSizeQuantity >= 1, `no live spot to price the shares to buy; ${book.freeShares} free shares cover ${coveredByShares} contract(s), volume share allows ${liquidityCap}`);
    } else {
      unitNotional = book.spotPrice * 100;
      const roomDollars = Math.min(room.budgetRoom, room.orderCap, room.tickerRoom, room.sectorRoom, room.cashRoom);
      // Only the contracts that buy shares add risk, so only they are stress-capped.
      const stressCap = computeStressCap(settings, input.stress, candidate, book.spotPrice, book.netLiquidationValue);
      const buyWriteContracts = Math.min(Math.floor(Math.max(0, roomDollars) / unitNotional), stressCap.contracts);
      fullSizeQuantity = Math.min(coveredByShares + buyWriteContracts, liquidityCap);
      gate("sizing", fullSizeQuantity >= 1, `${book.freeShares} free shares cover ${coveredByShares} contract(s), room allows ${buyWriteContracts} more contract(s) buying 100 shares each at ${book.spotPrice.toFixed(2)} (${describeRoom(room)}; ${stressCap.detail}), volume share allows ${liquidityCap}`);
    }
    // Only the shares actually bought count as notional: the free-share contracts commit no new cash.
    unitNotional = fullSizeQuantity > 0 ? (Math.max(0, fullSizeQuantity - coveredByShares) * unitNotional) / fullSizeQuantity : 0;
  }
  const quantity = fullSizeQuantity;

  const limitPrice = midLimitPrice(candidate.bid, candidate.ask);
  gate("limit_price", limitPrice >= candidate.bid && limitPrice <= candidate.ask && limitPrice > 0, `mid ${limitPrice.toFixed(2)} inside ${candidate.bid.toFixed(2)}–${candidate.ask.toFixed(2)}`);

  const ok = gates.every((entry) => entry.ok);
  return { ok, gates, plan: ok ? { quantity, limitPrice, notional: unitNotional * quantity, fullSizeQuantity } : null };
}
