import { easternInstant } from "../lib/marketSessionStatus.js";
import { readinessSchedule } from "../lib/preOpenReadiness.js";

// Pluto's pre-open readiness check (Marcelo, 2026-10-06), on the platform readiness timetable: first run at 6:00 ET (a
// failure alerts at once), re-run every 10 minutes while anything fails (announced only when the set of failures changes),
// and a final run at 9:20 ET that pauses Pluto if anything still fails. It proves the three things only Pluto's own process
// can: its IBKR connection, its sign-in to the API, and its OpenRouter key with enough credit.

export type PlutoReadinessTestName = "IBKR" | "API sign-in" | "OpenRouter";
export const plutoReadinessTestNames: PlutoReadinessTestName[] = ["IBKR", "API sign-in", "OpenRouter"];

export interface PlutoReadinessResult {
  name: PlutoReadinessTestName;
  ok: boolean;
  detail: string;
}

export type PlutoReadinessRunKind = "first" | "recheck" | "final";

/** Today's latest run, stored on pluto_state.readiness. */
export interface PlutoReadinessRecord {
  dateIso: string;
  lastRunAt: string;
  lastRunKind: PlutoReadinessRunKind;
  /** The failing tests' names joined, "" when every test passed. */
  signature: string;
  finalDone: boolean;
  results: PlutoReadinessResult[];
}

/** Pure: which run, if any, is due this minute on an open market day. Each stage is also a catch-up after a restart. */
export function decidePlutoReadinessRun(now: Date, dateIso: string, record: PlutoReadinessRecord | null): PlutoReadinessRunKind | null {
  const at = (time: { hour: number; minute: number }) => easternInstant(dateIso, time.hour, time.minute);
  const today = record && record.dateIso === dateIso ? record : null;
  if (now < at(readinessSchedule.preOpenStart)) return null;
  if (now < at(readinessSchedule.finalCheck)) {
    if (!today) return "first";
    const minutesSinceLastRun = (now.getTime() - new Date(today.lastRunAt).getTime()) / 60_000;
    return today.signature !== "" && minutesSinceLastRun >= readinessSchedule.preOpenRecheckMinutes ? "recheck" : null;
  }
  if (now < at(readinessSchedule.openConfirmationEnd) && !today?.finalDone) return "final";
  return null;
}

export function plutoReadinessSignature(results: PlutoReadinessResult[]): string {
  return results
    .filter((result) => !result.ok)
    .map((result) => result.name)
    .join("|");
}

const finalCheckEt = `${readinessSchedule.finalCheck.hour}:${String(readinessSchedule.finalCheck.minute).padStart(2, "0")} ET`;

/**
 * Pure: what a run means. A first run alerts only on failure; a re-run only when the set of failing tests changed (including
 * back to all-passing); the final run pauses Pluto when anything still fails.
 */
export function describePlutoReadinessOutcome(kind: PlutoReadinessRunKind, previousSignature: string | null, results: PlutoReadinessResult[]): { signature: string; message: string | null; pause: boolean } {
  const signature = plutoReadinessSignature(results);
  const failingLines = results.filter((result) => !result.ok).map((result) => `❌ ${result.name}: ${result.detail}`).join("\n");
  const failedMessage = `⚠️ Pluto pre-open check failed:\n${failingLines}\nRe-checking every ${readinessSchedule.preOpenRecheckMinutes} minutes. Pluto pauses at ${finalCheckEt} if it still fails.`;
  const passesAgainMessage = "✅ Pluto pre-open check passes again: IBKR, API sign-in and OpenRouter are all fine.";
  const hadFailures = previousSignature !== null && previousSignature !== "";

  if (kind === "final") {
    if (signature !== "") return { signature, message: `🛑 Pluto pre-open check still failing at ${finalCheckEt}:\n${failingLines}\nPluto is paused. Press Resume on the Pluto screen once it is fixed.`, pause: true };
    return { signature, message: hadFailures ? passesAgainMessage : null, pause: false };
  }
  if (kind === "first") return { signature, message: signature === "" ? null : failedMessage, pause: false };
  if (signature === (previousSignature ?? "")) return { signature, message: null, pause: false };
  return { signature, message: signature === "" ? passesAgainMessage : failedMessage, pause: false };
}

export type PlutoReadinessProbe = () => Promise<string>;

export interface PlutoReadinessProbes {
  ibkr: PlutoReadinessProbe;
  apiSignIn: PlutoReadinessProbe;
  openRouter: PlutoReadinessProbe;
}

/** Whole-test limits: each probe also has its own tighter limit on the request that matters. */
export const plutoReadinessTestTimeoutMs: Record<PlutoReadinessTestName, number> = { IBKR: 60_000, "API sign-in": 15_000, OpenRouter: 15_000 };

async function runProbe(name: PlutoReadinessTestName, probe: PlutoReadinessProbe): Promise<PlutoReadinessResult> {
  const timeoutMs = plutoReadinessTestTimeoutMs[name];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    });
    const detail = await Promise.race([probe(), timeout]);
    return { name, ok: true, detail };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the three tests side by side; never throws. */
export async function runPlutoReadinessTests(probes: PlutoReadinessProbes): Promise<PlutoReadinessResult[]> {
  return Promise.all([runProbe("IBKR", probes.ibkr), runProbe("API sign-in", probes.apiSignIn), runProbe("OpenRouter", probes.openRouter)]);
}
