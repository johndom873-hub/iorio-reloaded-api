import { db } from "../db/connection.js";
import { formatShortDate } from "./formatShortDate.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { publishNotification } from "./notificationChannel.js";

// Assignment-risk alerts on held short legs (moved out of Day Signals 2026-10-27; the market quote loop quotes the legs).
// A leg whose |delta| reaches assignmentRiskAlertAbsoluteDelta alerts once, then stays quiet until |delta| falls below
// assignmentRiskRearmAbsoluteDelta (re-armed), and never alerts more than once per Eastern trading day. State lives on
// position_legs.

/** |delta| at which a held short leg is at risk of assignment. */
export const assignmentRiskAlertAbsoluteDelta = 0.5;
/** |delta| a flagged leg must fall below before it can alert again. */
export const assignmentRiskRearmAbsoluteDelta = 0.45;

export interface AssignmentRiskAlertState {
  /** Set while the leg is flagged (alerted and not yet re-armed); null = armed. */
  notifiedAt: string | null;
  /** Eastern trading date (YYYY-MM-DD) of the last alert, for the once-per-day rule. */
  lastAlertTradingDateIso: string | null;
}

export type AssignmentRiskAlertDecision = "alert" | "rearm" | "none";

/** Pure: what to do with one held leg's fresh delta, given its stored alert state and today's Eastern trading date. */
export function decideAssignmentRiskAlert(delta: number, state: AssignmentRiskAlertState, tradingDateIso: string): AssignmentRiskAlertDecision {
  const absoluteDelta = Math.abs(delta);
  const flagged = state.notifiedAt !== null;
  if (flagged) return absoluteDelta < assignmentRiskRearmAbsoluteDelta ? "rearm" : "none";
  if (absoluteDelta < assignmentRiskAlertAbsoluteDelta) return "none";
  return state.lastAlertTradingDateIso === tradingDateIso ? "none" : "alert";
}

/** An open short option leg on a covered-call or cash-secured-put position. */
export interface HeldShortLeg {
  legId: string;
  positionId: string;
  tickerId: string;
  symbol: string;
  strategyKey: "covered_call" | "cash_secured_put";
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface AssignmentRiskAlert {
  symbol: string;
  leg: HeldShortLeg & { delta: number; dte: number };
  spotPrice: number | null;
}

export function formatAssignmentRiskMessage(alert: AssignmentRiskAlert): string {
  const { leg } = alert;
  const direction = leg.right === "C" ? "above" : "below";
  const spot = alert.spotPrice === null ? "" : ` · spot $${alert.spotPrice.toFixed(2)}`;
  return [
    `⚠️ ${alert.symbol} — Assignment risk (spot ${direction} strike)`,
    `$${leg.strike.toFixed(2)}${leg.right} exp ${formatShortDate(leg.expiry)} (${leg.dte} DTE) · Δ${leg.delta.toFixed(2)}${spot}`,
    `Open: Positions → ${alert.symbol}`,
  ].join("\n");
}

/** Telegram plus the persisted app notification (Latest Events + toast). Never throws: a notification failure must not stop the loop. */
export async function notifyAssignmentRisk(alert: AssignmentRiskAlert): Promise<void> {
  const { leg } = alert;
  await notifyTelegram(formatAssignmentRiskMessage(alert));
  try {
    await publishNotification({
      type: "assignment_risk",
      symbol: alert.symbol,
      strategyKey: leg.strategyKey,
      positionId: leg.positionId,
      legId: leg.legId,
      right: leg.right,
      strike: leg.strike,
      expiry: leg.expiry,
      dte: leg.dte,
      delta: leg.delta,
      spotPrice: alert.spotPrice,
    });
  } catch (error) {
    console.error(`assignment risk: could not publish the ${alert.symbol} notification: ${error instanceof Error ? error.message : error}`);
  }
}

export async function loadHeldShortLegs(): Promise<HeldShortLeg[]> {
  const rows: { legId: string; positionId: string; tickerId: string; symbol: string; strategyKey: HeldShortLeg["strategyKey"]; expiry: string; strike: string; optionType: "call" | "put" }[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where({ "p.status": "open", "pl.leg_type": "option", "pl.side": "short" })
    .whereIn("p.strategy_key", ["covered_call", "cash_secured_put"])
    .whereNull("pl.exit_at")
    .select("pl.id as legId", "p.id as positionId", "t.id as tickerId", "t.symbol", "p.strategy_key as strategyKey", db.raw("pl.expiry_date::text as expiry"), "pl.strike_price as strike", "pl.option_type as optionType")
    .orderBy(["t.symbol", "pl.expiry_date", "pl.strike_price"]);
  return rows.map((row) => ({ ...row, strike: Number(row.strike), right: row.optionType === "call" ? "C" : "P" }));
}

export async function loadAssignmentRiskAlertStates(legIds: string[]): Promise<Map<string, AssignmentRiskAlertState>> {
  if (legIds.length === 0) return new Map();
  const rows: { id: string; notifiedAt: Date | null; lastAlertTradingDateIso: string | null }[] = await db("position_legs")
    .whereIn("id", legIds)
    .whereNull("exit_at")
    .select("id", "assignment_risk_notified_at as notifiedAt", db.raw('assignment_risk_last_alert_trading_date::text as "lastAlertTradingDateIso"'));
  return new Map(rows.map((row) => [row.id, { notifiedAt: row.notifiedAt ? new Date(row.notifiedAt).toISOString() : null, lastAlertTradingDateIso: row.lastAlertTradingDateIso }]));
}

export async function recordAssignmentRiskAlert(legId: string, tradingDateIso: string): Promise<void> {
  await db("position_legs").where({ id: legId }).update({ assignment_risk_notified_at: db.fn.now(), assignment_risk_last_alert_trading_date: tradingDateIso });
}

export async function rearmAssignmentRiskAlert(legId: string): Promise<void> {
  await db("position_legs").where({ id: legId }).update({ assignment_risk_notified_at: null });
}
