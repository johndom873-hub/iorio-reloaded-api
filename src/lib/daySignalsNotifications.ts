import { formatShortDate } from "./formatTradeAlertMessage.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { publishNotification } from "./notificationChannel.js";
import type { SignalCandidate, SignalGrade } from "./signalCandidates.js";

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
