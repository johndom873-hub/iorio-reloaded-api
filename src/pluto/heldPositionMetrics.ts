import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { eventStressNormalDaysByWeight, type MacroEventBeforeExpiry } from "../lib/macroEventTiming.js";
import { expectedDailyMovePct } from "./moveContext.js";
import { tradingSessionsPerYear } from "../lib/volatilityEdge.js";

// What Pluto sees about each held short leg, whatever Signals thinks of it (Formulas F2 and the covered-call variant,
// approved 2026-10-08). d is the stock's normal daily move (forecast volatility ÷ √252), k the event's stress move in
// normal days (eventStressNormalDaysByWeight), S* = spot × (1 − k·d) the stressed spot.
//
//   captured %              (entry credit − ask) ÷ entry credit × 100
//   max remaining gain $    put: mid × 100 × qty
//                           covered call: (strike − spot + call mid) × 100 × qty  (the most it still adds, finishing at or above the strike)
//   close cost $            put: ((ask − mid) × 100 + commission) × qty
//                           covered call: ((call ask − call mid) × 100 + commission) × qty + (stock mid − stock bid) × shares
//   strike distance (days)  put: (spot − strike) ÷ spot ÷ d;  call: (strike − spot) ÷ spot ÷ d
//   event stress loss $     put: (BS put(S*) − mid) × 100 × qty
//                           covered call: (spot − S*) × shares − (call mid − BS call(S*)) × 100 × qty
//                           BS at forecast volatility with the trading sessions left after the event's session ÷ 252, the
//                           forecast's own clock (2026-10-09; was calendar days ÷ 365); the event premium is gone once it is
//                           out; intrinsic value when the event lands on expiry day.
//   cycle P&L after costs $ covered call: the close gate's live cycle P&L (at mids) − close cost
// No stock commission estimate exists on the platform, so the covered call's close cost carries the option's only.

export interface HeldPositionEvent extends MacroEventBeforeExpiry {
  /** k: the adverse move it is stressed with, in normal days. */
  stressNormalDays: number;
}

export interface HeldPositionEntry {
  legId: string;
  positionId: string;
  strategy: "cash_secured_put" | "covered_call";
  strike: number;
  expiry: string;
  dte: number | null;
  delta: number | null;
  quantity: number;
  /** Shares held against a covered call (100 per contract); absent for a put. */
  shares?: number;
  entryCredit: number;
  bid: number | null;
  ask: number | null;
  capturedPct: number | null;
  maxRemainingGainDollars: number | null;
  closeCostDollars: number | null;
  strikeDistanceDays: number | null;
  event: HeldPositionEvent | null;
  eventStressLossDollars: number | null;
  /** Covered call only, and only when the close gate was read (an event close is in its window). */
  cyclePnlAfterCostsDollars?: number | null;
}

export function capturedPct(entryCredit: number, ask: number | null): number | null {
  if (ask === null || !(entryCredit > 0)) return null;
  return ((entryCredit - ask) / entryCredit) * 100;
}

/** The normal daily move as a decimal (0.02 = 2%), or null without a usable forecast. */
export function normalDailyMove(forecastVolatility: number | null): number | null {
  const pct = expectedDailyMovePct(forecastVolatility);
  return pct === null ? null : pct / 100;
}

export function withStressMove(event: MacroEventBeforeExpiry | null): HeldPositionEvent | null {
  return event ? { ...event, stressNormalDays: eventStressNormalDaysByWeight[event.weight] } : null;
}

/** The option's value right after the event at the stressed spot: Black-Scholes at forecast volatility, intrinsic when it lands on expiry day. */
export function optionValueAfterEvent(input: { stressedSpot: number; strike: number; isCall: boolean; sessionsLeftAfterEvent: number; forecastVolatility: number }): number {
  const yearsLeft = input.sessionsLeftAfterEvent / tradingSessionsPerYear;
  if (!(yearsLeft > 0)) return Math.max(0, input.isCall ? input.stressedSpot - input.strike : input.strike - input.stressedSpot);
  return blackScholesPriceOnForward(input.stressedSpot, input.strike, yearsLeft, 0, input.forecastVolatility, input.isCall);
}

interface QuotedLeg {
  legId: string;
  positionId: string;
  strike: number;
  expiry: string;
  dte: number | null;
  delta: number | null;
  quantity: number;
  bid: number | null;
  ask: number | null;
}

function twoSidedMid(bid: number | null, ask: number | null): number | null {
  return bid !== null && ask !== null && bid >= 0 && ask >= bid && ask > 0 ? (bid + ask) / 2 : null;
}

export interface HeldPutInput {
  leg: QuotedLeg;
  entryCredit: number;
  spot: number | null;
  forecastVolatility: number | null;
  event: MacroEventBeforeExpiry | null;
  /** Estimated commission per contract to buy the leg back. */
  commissionPerContract: number;
}

/** Pure F2 for a cash-secured put. */
export function heldPutEntry(input: HeldPutInput): HeldPositionEntry {
  const { leg } = input;
  const mid = twoSidedMid(leg.bid, leg.ask);
  const d = normalDailyMove(input.forecastVolatility);
  const event = withStressMove(input.event);
  const spot = input.spot !== null && input.spot > 0 ? input.spot : null;
  let eventStressLossDollars: number | null = null;
  if (event && mid !== null && spot !== null && d !== null && input.forecastVolatility !== null) {
    const stressedSpot = Math.max(0, spot * (1 - event.stressNormalDays * d));
    const putAfter = optionValueAfterEvent({ stressedSpot, strike: leg.strike, isCall: false, sessionsLeftAfterEvent: event.sessionsAfter - 1, forecastVolatility: input.forecastVolatility });
    eventStressLossDollars = (putAfter - mid) * 100 * leg.quantity;
  }
  return {
    legId: leg.legId,
    positionId: leg.positionId,
    strategy: "cash_secured_put",
    strike: leg.strike,
    expiry: leg.expiry,
    dte: leg.dte,
    delta: leg.delta,
    quantity: leg.quantity,
    entryCredit: input.entryCredit,
    bid: leg.bid,
    ask: leg.ask,
    capturedPct: mid === null ? null : capturedPct(input.entryCredit, leg.ask),
    maxRemainingGainDollars: mid === null ? null : mid * 100 * leg.quantity,
    closeCostDollars: mid === null || leg.ask === null ? null : ((leg.ask - mid) * 100 + input.commissionPerContract) * leg.quantity,
    strikeDistanceDays: spot !== null && d !== null ? (spot - leg.strike) / spot / d : null,
    event,
    eventStressLossDollars,
  };
}

export interface HeldCoveredCallInput {
  callLeg: QuotedLeg;
  shares: number;
  entryCredit: number;
  spot: number | null;
  stockBid: number | null;
  stockAsk: number | null;
  forecastVolatility: number | null;
  event: MacroEventBeforeExpiry | null;
  commissionPerContract: number;
  /** The close gate's live cycle P&L at mids when it was read; undefined when it was not. */
  cycleTotal?: number | null;
}

/** Pure: the covered-call variant, judged on the whole position (shares and call). */
export function heldCoveredCallEntry(input: HeldCoveredCallInput): HeldPositionEntry {
  const { callLeg, shares } = input;
  const callMid = twoSidedMid(callLeg.bid, callLeg.ask);
  const stockMid = twoSidedMid(input.stockBid, input.stockAsk);
  const d = normalDailyMove(input.forecastVolatility);
  const event = withStressMove(input.event);
  const spot = input.spot !== null && input.spot > 0 ? input.spot : null;
  let eventStressLossDollars: number | null = null;
  if (event && callMid !== null && spot !== null && d !== null && input.forecastVolatility !== null) {
    const stressedSpot = Math.max(0, spot * (1 - event.stressNormalDays * d));
    const callAfter = optionValueAfterEvent({ stressedSpot, strike: callLeg.strike, isCall: true, sessionsLeftAfterEvent: event.sessionsAfter - 1, forecastVolatility: input.forecastVolatility });
    eventStressLossDollars = (spot - stressedSpot) * shares - (callMid - callAfter) * 100 * callLeg.quantity;
  }
  const closeCostDollars =
    callMid === null || callLeg.ask === null || stockMid === null || input.stockBid === null
      ? null
      : ((callLeg.ask - callMid) * 100 + input.commissionPerContract) * callLeg.quantity + (stockMid - input.stockBid) * shares;
  const entry: HeldPositionEntry = {
    legId: callLeg.legId,
    positionId: callLeg.positionId,
    strategy: "covered_call",
    strike: callLeg.strike,
    expiry: callLeg.expiry,
    dte: callLeg.dte,
    delta: callLeg.delta,
    quantity: callLeg.quantity,
    shares,
    entryCredit: input.entryCredit,
    bid: callLeg.bid,
    ask: callLeg.ask,
    capturedPct: callMid === null ? null : capturedPct(input.entryCredit, callLeg.ask),
    maxRemainingGainDollars: callMid !== null && spot !== null ? (callLeg.strike - spot + callMid) * 100 * callLeg.quantity : null,
    closeCostDollars,
    strikeDistanceDays: spot !== null && d !== null ? (callLeg.strike - spot) / spot / d : null,
    event,
    eventStressLossDollars,
  };
  if (input.cycleTotal !== undefined) entry.cyclePnlAfterCostsDollars = input.cycleTotal === null || closeCostDollars === null ? null : input.cycleTotal - closeCostDollars;
  return entry;
}

/** The step a review is re-asked on (F4): captured % rounded down to 10 points, and the sessions left before the event. */
export function eventReviewKey(entry: Pick<HeldPositionEntry, "capturedPct" | "event">): string {
  const captured = entry.capturedPct === null ? "?" : String(Math.floor(entry.capturedPct / 10) * 10);
  return `c${captured}s${entry.event?.sessionsUntil ?? "?"}`;
}
