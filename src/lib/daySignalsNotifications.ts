import { formatSignedDollars } from "./formatSignedDollars.js";
import type { AssignmentRiskAlertState } from "./daySignalsStore.js";
import { formatEasternTime } from "./easternIsoDate.js";
import { formatShortDate } from "./formatShortDate.js";
import { publishNotification } from "./notificationChannel.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { gradeMarginCutPoints } from "./contractValuation.js";
import type { SignalCandidate, SignalGrade } from "./signalCandidates.js";
import { assignmentRiskDeltaThreshold, type HeldLegScore, type RollSignalCandidate } from "./rollSignalCandidates.js";

// Upward transitions of the valuation model's grade only, from any tier including Avoid, one message per contract per
// transition. Two guards against alert flooding (approved 2026-09-24; on the model's Edge margin since 2026-10-20):
// clearsNotificationHysteresis requires the new grade's cut be cleared by a margin, not just barely crossed (quote noise
// moves a contract sitting on a cut back and forth within seconds), and the loop (daySignalsLoop.ts) also holds a
// per-contract cooldown so the same contract can't re-notify within notificationCooldownMs regardless of further grade
// movement. Delivered via
// the persisted notification event (Pulse's Latest Events) and — through the
// same event — the in-app toast. Telegram delivery is suspended;
// formatSignalUpgradeMessage/formatRollSignalUpgradeMessage are unused but
// kept for that path if it's re-enabled.

const gradeRank: Record<SignalGrade, number> = { avoid: 0, weak: 1, good: 2, strong: 3 };
const gradeLabel: Record<SignalGrade, string> = { avoid: "Avoid", weak: "Weak", good: "Good", strong: "Strong" };

/** A transition counts only against a previously recorded grade: the first score after a seed or restart is a baseline. */
export function isGradeUpgrade(previousGrade: SignalGrade | null, grade: SignalGrade): boolean {
  return previousGrade !== null && gradeRank[grade] > gradeRank[previousGrade];
}

/**
 * Margin (a fraction of the price: 0.02 = 2 points) an Edge margin must clear above its grade's cut before an upward
 * transition into it notifies (Marcelo 2026-10-20): Strong alerts from 22%, Good from 12%, Weak from 2%. The grade shown
 * on screen is unaffected: gradeForEdgeMargin still grades at the bare cuts; this only gates the notification.
 */
export const notificationHysteresisEdgeMargin = 0.02;

/** True when `grade`'s Edge margin clears its own cut by notificationHysteresisEdgeMargin. Never true for "avoid" (nothing notifies into it). */
export function clearsNotificationHysteresis(grade: SignalGrade, edgeMargin: number): boolean {
  if (grade === "avoid") return false;
  // Rounded to a basis point: 0.1 + 0.02 is 0.12000000000000001 in floating point, which a 12% margin would miss.
  const alertThreshold = Math.round((gradeMarginCutPoints[grade] + notificationHysteresisEdgeMargin) * 10_000) / 10_000;
  return edgeMargin >= alertThreshold;
}

export interface SignalUpgrade {
  symbol: string;
  candidate: SignalCandidate;
  previousGrade: SignalGrade;
  spotPrice: number;
  quotedAt: string | null;
}

export function formatSignalUpgradeMessage(upgrade: SignalUpgrade): string {
  const { candidate } = upgrade;
  const contract = `${candidate.strategyKey === "covered_call" ? "Call" : "Put"} $${candidate.strike} · ${formatShortDate(candidate.expiry)} (${candidate.dte} DTE)`;
  const quoteTime = upgrade.quotedAt ? formatEasternTime(new Date(upgrade.quotedAt)) : "n/a";
  return [
    `▲ Signal upgraded — ${upgrade.symbol}`,
    contract,
    `${gradeLabel[upgrade.previousGrade]} → ${gradeLabel[candidate.model.grade]}`,
    `Edge margin ${(candidate.model.edgeMargin * 100).toFixed(0)}% · Edge Yield ${(candidate.model.expectedAnnualizedReturn * 100).toFixed(0)}% ann. · Edge $ ${candidate.model.expectedPnlDollars.toFixed(0)}`,
    `Spot $${upgrade.spotPrice.toFixed(2)} · quote ${quoteTime} (day quotes)`,
    `Open: Signals → ${upgrade.symbol}`,
  ].join("\n");
}

/** Never throws: a notification failure must not stop the refresh loop. */
export async function notifySignalUpgrade(upgrade: SignalUpgrade): Promise<void> {
  const { candidate } = upgrade;
  try {
    await publishNotification({
      type: "signal_upgraded",
      symbol: upgrade.symbol,
      strategyKey: candidate.strategyKey,
      strike: candidate.strike,
      expiry: candidate.expiry,
      dte: candidate.dte,
      previousGrade: upgrade.previousGrade,
      grade: candidate.model.grade,
      edgeMargin: candidate.model.edgeMargin,
      edgeYield: candidate.model.expectedAnnualizedReturn,
      expectedPnlDollars: candidate.model.expectedPnlDollars,
      exposureDollars: candidate.model.capitalAtRiskDollars,
    });
  } catch (error) {
    console.error(`day signals: could not notify the ${upgrade.symbol} upgrade: ${error instanceof Error ? error.message : error}`);
  }
}

export interface RollSignalUpgrade {
  symbol: string;
  roll: RollSignalCandidate;
  held: { strike: number; expiry: string; dte: number | null };
  previousGrade: SignalGrade;
  spotPrice: number;
  quotedAt: string | null;
}

export function formatRollSignalUpgradeMessage(upgrade: RollSignalUpgrade): string {
  const { roll } = upgrade;
  const right = roll.strategyKey === "covered_call" ? "Call" : "Put";
  const quoteTime = upgrade.quotedAt ? formatEasternTime(new Date(upgrade.quotedAt)) : "n/a";
  return [
    `▲ Roll signal upgraded — ${upgrade.symbol}`,
    `${right} $${upgrade.held.strike}${upgrade.held.dte === null ? "" : ` (${upgrade.held.dte} DTE)`} → ${right} $${roll.replacement.strike} · ${formatShortDate(roll.replacement.expiry)} (${roll.replacement.dte} DTE)`,
    `${gradeLabel[upgrade.previousGrade]} → ${gradeLabel[roll.model.grade]}`,
    `Edge margin ${(roll.model.edgeMargin * 100).toFixed(0)}% · ${formatSignedDollars(roll.model.netExpectedPnl, 0, true)} for ${roll.quantity} contract${roll.quantity === 1 ? "" : "s"} · net credit ${formatSignedDollars(roll.netCreditPerShare, 2)}/sh`,
    `Spot $${upgrade.spotPrice.toFixed(2)} · quote ${quoteTime} (day quotes)`,
    `Open: Signals → ${upgrade.symbol} → Your positions`,
  ].join("\n");
}

/** Never throws: a notification failure must not stop the refresh loop. */
export async function notifyRollSignalUpgrade(upgrade: RollSignalUpgrade): Promise<void> {
  const { roll } = upgrade;
  try {
    await publishNotification({
      type: "roll_signal_upgraded",
      symbol: upgrade.symbol,
      strategyKey: roll.strategyKey,
      legId: roll.legId,
      heldStrike: upgrade.held.strike,
      heldExpiry: upgrade.held.expiry,
      heldDte: upgrade.held.dte,
      strike: roll.replacement.strike,
      expiry: roll.replacement.expiry,
      dte: roll.replacement.dte,
      previousGrade: upgrade.previousGrade,
      grade: roll.model.grade,
      edgeMargin: roll.model.edgeMargin,
      netExpectedPnl: roll.model.netExpectedPnl,
      netCreditPerShare: roll.netCreditPerShare,
    });
  } catch (error) {
    console.error(`day signals: could not notify the ${upgrade.symbol} roll upgrade: ${error instanceof Error ? error.message : error}`);
  }
}

// Assignment-risk alert (approved 2026-09-29, replacing the old once-a-day
// check): after the loop re-scores a ticker, every held short leg whose
// |delta| has reached assignmentRiskAlertAbsoluteDelta alerts once, then stays
// quiet until |delta| falls below assignmentRiskRearmAbsoluteDelta (re-armed),
// and never alerts more than once per Eastern trading day. State lives on
// position_legs (daySignalsStore.ts's AssignmentRiskAlertState).

/** |delta| at which a held short leg is at risk of assignment — the same threshold as the Roll Signals assignment_risk flag. */
export const assignmentRiskAlertAbsoluteDelta = assignmentRiskDeltaThreshold;
/** |delta| a flagged leg must fall below before it can alert again. */
export const assignmentRiskRearmAbsoluteDelta = 0.45;

export type AssignmentRiskAlertDecision = "alert" | "rearm" | "none";

/** Pure: what to do with one held leg's freshly scored delta, given its stored alert state and today's Eastern trading date. */
export function decideAssignmentRiskAlert(delta: number, state: AssignmentRiskAlertState, tradingDateIso: string): AssignmentRiskAlertDecision {
  const absoluteDelta = Math.abs(delta);
  const flagged = state.notifiedAt !== null;
  if (flagged) return absoluteDelta < assignmentRiskRearmAbsoluteDelta ? "rearm" : "none";
  if (absoluteDelta < assignmentRiskAlertAbsoluteDelta) return "none";
  return state.lastAlertTradingDateIso === tradingDateIso ? "none" : "alert";
}

export interface AssignmentRiskAlert {
  symbol: string;
  leg: HeldLegScore & { delta: number };
  spotPrice: number | null;
}

export function formatAssignmentRiskMessage(alert: AssignmentRiskAlert): string {
  const { leg } = alert;
  const direction = leg.right === "C" ? "above" : "below";
  const dte = leg.dte === null ? "" : ` (${leg.dte} DTE)`;
  const spot = alert.spotPrice === null ? "" : ` · spot $${alert.spotPrice.toFixed(2)}`;
  return [
    `⚠️ ${alert.symbol} — Assignment risk (spot ${direction} strike)`,
    `$${leg.strike.toFixed(2)}${leg.right} exp ${formatShortDate(leg.expiry)}${dte} · Δ${leg.delta.toFixed(2)}${spot}`,
    `Open: Signals → ${alert.symbol} → Your positions`,
  ].join("\n");
}

/** Telegram plus the persisted app notification (Latest Events + toast). Never throws: a notification failure must not stop the refresh loop. */
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
    console.error(`day signals: could not publish the ${alert.symbol} assignment-risk notification: ${error instanceof Error ? error.message : error}`);
  }
}
