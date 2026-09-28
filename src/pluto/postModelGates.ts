import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import type { PlutoGateResult } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";

// Post-model validation (design round 3, item 21, approved 2026-09-28). Nothing the model said
// is trusted: the chosen candidate is re-scored on fresh quotes and re-filtered by the caller,
// and this module re-derives everything else — confidence, drift, capacity, the quantity (code
// sizes; the model only picked a tier) and the limit price. Pure, so every rule is unit-tested.
// The existing route gates (halt, delta band, Signals limits, close gate) run again at build and
// confirm, on top of this.

export interface PostModelBookInput {
  netLiquidationValue: number;
  freeCash: number;
  /** Capital Pluto's own open positions already commit. */
  committedDollars: number;
  openPositionCount: number;
  /** Every open position's exposure on this symbol and sector, humans' included (computePositionExposures). */
  existingTickerExposure: number;
  existingSectorExposure: number;
  /** Uncovered shares of the symbol Pluto may write calls against. */
  freeShares: number;
  workingOrderOnSymbol: boolean;
  lastActionDateIso: string | null;
  todayEasternIso: string;
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
  orderCap: number;
  tickerRoom: number;
  sectorRoom: number;
  cashRoom: number;
}

export function computeSizingRoom(settings: PlutoSettings, book: PostModelBookInput, sectorKnown: boolean): SizingRoom {
  const nlv = book.netLiquidationValue;
  return {
    budgetRoom: (nlv * settings.capitalBudgetPct) / 100 - book.committedDollars,
    orderCap: (nlv * settings.maxOrderNotionalPct) / 100,
    tickerRoom: (nlv * settings.maxTickerExposurePct) / 100 - book.existingTickerExposure,
    sectorRoom: sectorKnown && settings.maxSectorExposurePct < 100 ? (nlv * settings.maxSectorExposurePct) / 100 - book.existingSectorExposure : Number.POSITIVE_INFINITY,
    cashRoom: book.freeCash - (nlv * settings.minCashReservePct) / 100,
  };
}

function describeRoom(room: SizingRoom): string {
  const parts = [`budget ${room.budgetRoom.toFixed(0)}`, `order cap ${room.orderCap.toFixed(0)}`, `ticker ${room.tickerRoom.toFixed(0)}`, `cash ${room.cashRoom.toFixed(0)}`];
  if (Number.isFinite(room.sectorRoom)) parts.push(`sector ${room.sectorRoom.toFixed(0)}`);
  return parts.join(", ");
}

function volumeCap(volume: number | null, settings: PlutoSettings): number {
  return volume === null ? 0 : Math.floor((volume * settings.maxContractsVolumeSharePct) / 100);
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
  const cooledDown = settings.tickerCooldownSessions === 0 || book.lastActionDateIso === null || book.lastActionDateIso < book.todayEasternIso;
  gate("ticker_cooldown", cooledDown, cooledDown ? "no Pluto action on this symbol this session" : `last Pluto action on this symbol was ${book.lastActionDateIso}`);
  if (!isRoll) gate("open_positions_cap", book.openPositionCount < settings.maxOpenPositions, `${book.openPositionCount} of ${settings.maxOpenPositions} open Pluto positions`);

  // Sizing — code sizes (design item 4); the model only picked full or half.
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
    fullSizeQuantity = Math.min(byRoom, liquidityCap);
    gate("sizing", fullSizeQuantity >= 1, `room allows ${byRoom} contract(s) (${describeRoom(room)}), volume share allows ${liquidityCap}`);
  } else {
    // Covered calls only against shares Pluto already has free; Pluto never buys shares to write calls.
    unitNotional = 0;
    const byShares = Math.floor(book.freeShares / 100);
    fullSizeQuantity = Math.min(byShares, liquidityCap);
    gate("sizing", fullSizeQuantity >= 1, `${book.freeShares} free shares cover ${byShares} contract(s), volume share allows ${liquidityCap}`);
  }
  const quantity = decision.sizeTier === "half" && !isRoll ? Math.floor(fullSizeQuantity / 2) : fullSizeQuantity;
  if (fullSizeQuantity >= 1) gate("size_tier", quantity >= 1, quantity >= 1 ? `${decision.sizeTier} size = ${quantity} contract(s)` : "half size rounds down to zero contracts");

  const limitPrice = midLimitPrice(candidate.bid, candidate.ask);
  gate("limit_price", limitPrice >= candidate.bid && limitPrice <= candidate.ask && limitPrice > 0, `mid ${limitPrice.toFixed(2)} inside ${candidate.bid.toFixed(2)}–${candidate.ask.toFixed(2)}`);

  const ok = gates.every((entry) => entry.ok);
  return { ok, gates, plan: ok ? { quantity, limitPrice, notional: unitNotional * quantity, fullSizeQuantity } : null };
}
