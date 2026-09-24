import { formatShortDate } from "./formatTradeAlertMessage.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { publishNotification } from "./notificationChannel.js";
import type { SignalCandidate, SignalGrade } from "./signalCandidates.js";
import type { RollSignalCandidate } from "./rollSignalCandidates.js";

// Upward grade transitions only, from any tier including Avoid, one message
// per contract per transition, no cooldown (Marcelo 2026-09-24: a refresh
// cycle takes minutes, so flapping is not a concern). Delivered three ways
// from one call: Telegram, the persisted notification event (Pulse's Latest
// Events) and — through the same event — the in-app toast.

const gradeRank: Record<SignalGrade, number> = { avoid: 0, weak: 1, good: 2, strong: 3 };
const gradeLabel: Record<SignalGrade, string> = { avoid: "Avoid", weak: "Weak", good: "Good", strong: "Strong" };

/** A transition counts only against a previously recorded grade: the first score after a seed or restart is a baseline. */
export function isGradeUpgrade(previousGrade: SignalGrade | null, grade: SignalGrade): boolean {
  return previousGrade !== null && gradeRank[grade] > gradeRank[previousGrade];
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
    await notifyTelegram(formatSignalUpgradeMessage(upgrade));
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
    await notifyTelegram(formatRollSignalUpgradeMessage(upgrade));
    await publishNotification({
      type: "roll_signal_upgraded",
      symbol: upgrade.symbol,
      strategyKey: roll.strategyKey,
      legId: roll.legId,
      heldStrike: upgrade.held.strike,
      heldExpiry: upgrade.held.expiry,
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
