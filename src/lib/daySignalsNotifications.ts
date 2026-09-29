import type { AssignmentRiskAlertState } from "./daySignalsStore.js";
import { formatShortDate } from "./formatShortDate.js";
import { publishNotification } from "./notificationChannel.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { goodCutVolatilityPoints, strongCutVolatilityPoints, type SignalCandidate, type SignalGrade } from "./signalCandidates.js";
import { assignmentRiskDeltaThreshold, type HeldLegScore, type RollSignalCandidate } from "./rollSignalCandidates.js";

// Upward grade transitions only, from any tier including Avoid, one message per
// contract per transition. Two guards against alert flooding, both approved
// 2026-09-24 after a contract sitting right on a grade boundary re-notified 8
// times in 11 minutes on staging (net Edge oscillating 5.0-7.5vp across the
// weak/good line on quote noise, each upward wobble notified since the old
// "no cooldown" design assumed a refresh cycle took minutes to move a grade,
// not seconds): clearsNotificationHysteresis requires the new grade be cleared
// by a margin, not just barely crossed, and the loop (daySignalsLoop.ts) also
// holds a per-contract cooldown so the same contract can't re-notify within
// notificationCooldownMs regardless of further grade movement. Delivered via
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

/** Margin (in volatility points) a net Edge must clear above the grade's own cut point (Formula 3j) before an
 * upward transition into it is convincing enough to notify. The grade shown on screen is unaffected by this —
 * gradeForNetEdge still grades at the bare cut points; this only gates the notification trigger. */
export const notificationHysteresisVolatilityPoints = 2;

/** True when `grade`'s net Edge clears its own cut point by notificationHysteresisVolatilityPoints. Never true for "avoid" (nothing notifies into it). */
export function clearsNotificationHysteresis(grade: SignalGrade, netEdge: number): boolean {
  if (grade === "avoid") return false;
  const entryCutVolatilityPoints = grade === "strong" ? strongCutVolatilityPoints : grade === "good" ? goodCutVolatilityPoints : 0;
  return netEdge * 100 >= entryCutVolatilityPoints + notificationHysteresisVolatilityPoints;
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
  const quoteTime = upgrade.quotedAt ? new Date(upgrade.quotedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : "n/a";
  return [
    `▲ Signal upgraded — ${upgrade.symbol}`,
    contract,
    `${gradeLabel[upgrade.previousGrade]} → ${gradeLabel[candidate.grade]}`,
    `Net Edge ${(candidate.netEdge * 100).toFixed(1)}vp · Edge $ ${candidate.edgeDollars.toFixed(0)} · yield ${(candidate.annualizedYield * 100).toFixed(0)}% ann.`,
    `Spot $${upgrade.spotPrice.toFixed(2)} · quote ${quoteTime} ET (day quotes)`,
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
      grade: candidate.grade,
      netEdge: candidate.netEdge,
      edgeDollars: candidate.edgeDollars,
      annualizedYield: candidate.annualizedYield,
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
  const quoteTime = upgrade.quotedAt ? new Date(upgrade.quotedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : "n/a";
  return [
    `▲ Roll signal upgraded — ${upgrade.symbol}`,
    `${right} $${upgrade.held.strike}${upgrade.held.dte === null ? "" : ` (${upgrade.held.dte} DTE)`} → ${right} $${roll.replacement.strike} · ${formatShortDate(roll.replacement.expiry)} (${roll.replacement.dte} DTE)`,
    `${gradeLabel[upgrade.previousGrade]} → ${gradeLabel[roll.grade]}`,
    `Net roll Edge ${(roll.netRollEdge * 100).toFixed(1)}vp · ${roll.netRollEdgeDollars >= 0 ? "+" : "−"}$${Math.abs(roll.netRollEdgeDollars).toFixed(0)} for ${roll.quantity} contract${roll.quantity === 1 ? "" : "s"} · net credit $${roll.netCreditPerShare.toFixed(2)}/sh`,
    `Spot $${upgrade.spotPrice.toFixed(2)} · quote ${quoteTime} ET (day quotes)`,
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
      grade: roll.grade,
      netRollEdge: roll.netRollEdge,
      netRollEdgeDollars: roll.netRollEdgeDollars,
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
