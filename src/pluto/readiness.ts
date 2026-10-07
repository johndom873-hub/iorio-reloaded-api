import { easternInstant } from "../lib/marketSessionStatus.js";
import { readinessSchedule } from "../lib/preOpenReadiness.js";

// Pluto's pre-open readiness check (Marcelo, 2026-10-06), on the platform readiness timetable: first run at 6:00 ET (a
// failure alerts at once), re-run every 10 minutes while anything fails (announced only when the set of failures changes),
// and a final run at 9:20 ET that pauses Pluto if anything still fails. It proves the three things only Pluto's own process
// can: its IBKR connection, its sign-in to the API, and its OpenRouter key with enough credit. A fourth test, "Pluto running"
// (Marcelo, 2026-10-07), is not a probe: it fails when Pluto is switched off or paused, so a Pluto that will not act today is
// announced at 6:00 and 9:20 ET instead of being reported "ready". The check therefore runs whether Pluto is on, paused or off.

export type PlutoProbeTestName = "IBKR" | "API sign-in" | "OpenRouter";
export type PlutoReadinessTestName = PlutoProbeTestName | "Pluto running";
export const plutoReadinessTestNames: PlutoReadinessTestName[] = ["IBKR", "API sign-in", "OpenRouter", "Pluto running"];
const plutoRunningTestName: PlutoReadinessTestName = "Pluto running";

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

const pauseReasonDescriptions: Record<string, string> = {
  manual: "paused by a person",
  deploy: "paused after a deploy",
  crash_loop: "paused after repeated restarts",
  readiness: "paused by an earlier pre-open check",
};

/** Pure: the "Pluto running" test. Passes only when the mode is on and Pluto is not paused. */
export function evaluatePlutoRunning(state: { mode: string; paused: boolean; pauseReason: string | null }): PlutoReadinessResult {
  const problems: string[] = [];
  if (state.mode !== "on") problems.push("switched off");
  if (state.paused) {
    const reason = state.pauseReason ?? "";
    problems.push(reason.startsWith("breaker:") ? `paused, the ${reason.slice("breaker:".length).replace(/_/g, " ")} breaker is tripped` : (pauseReasonDescriptions[reason] ?? "paused"));
  }
  return problems.length === 0 ? { name: plutoRunningTestName, ok: true, detail: "on and not paused" } : { name: plutoRunningTestName, ok: false, detail: problems.join(" and ") };
}

export function plutoReadinessSignature(results: PlutoReadinessResult[]): string {
  return results
    .filter((result) => !result.ok)
    .map((result) => result.name)
    .join("|");
}

const finalCheckEt = `${readinessSchedule.finalCheck.hour}:${String(readinessSchedule.finalCheck.minute).padStart(2, "0")} ET`;

/**
 * Pure: what a run means, announced like the platform readiness check: the 6:00 ET first run and the 9:20 ET final run always
 * post (passing or not); a re-run posts only when the set of failing tests changed (including back to all-passing). The final
 * run pauses Pluto when a probe still fails, but only a Pluto that is running: "Pluto running" failing means it is already off
 * or paused, so it never causes a pause itself.
 */
export function describePlutoReadinessOutcome(kind: PlutoReadinessRunKind, previousSignature: string | null, results: PlutoReadinessResult[]): { signature: string; message: string | null; pause: boolean } {
  const signature = plutoReadinessSignature(results);
  const resultLines = [...results.filter((result) => !result.ok).map((result) => `❌ ${result.name}: ${result.detail}`), ...results.filter((result) => result.ok).map((result) => `✅ ${result.name}: ${result.detail}`)].join("\n");
  const failing = signature !== "";
  const failingNames = results.filter((result) => !result.ok).map((result) => result.name);
  const notRunning = failingNames.includes(plutoRunningTestName);
  const probeFailing = failingNames.some((name) => name !== plutoRunningTestName);
  const recheckNote = probeFailing && !notRunning ? `Re-checking every ${readinessSchedule.preOpenRecheckMinutes} minutes. Pluto pauses at ${finalCheckEt} if it still fails.` : `Re-checking every ${readinessSchedule.preOpenRecheckMinutes} minutes.`;

  if (kind === "final") {
    if (!failing) return { signature, message: `✅ Pluto ready for today (${finalCheckEt} check).\n${resultLines}`, pause: false };
    if (!probeFailing) return { signature, message: `🛑 Pluto is not running at the ${finalCheckEt} check.\n${resultLines}\nResume it (or switch it on) on the Pluto screen to let it act today.`, pause: false };
    if (notRunning) return { signature, message: `🛑 Pluto not ready: the ${finalCheckEt} check still fails, and Pluto is not running.\n${resultLines}\nFix what failed, then resume it (or switch it on) on the Pluto screen.`, pause: false };
    return { signature, message: `🛑 Pluto not ready: the ${finalCheckEt} check still fails, so Pluto is paused.\n${resultLines}\nPress Resume on the Pluto screen once it is fixed.`, pause: true };
  }
  if (kind === "first") {
    return { signature, message: failing ? `⚠️ Pluto pre-open check failed.\n${resultLines}\n${recheckNote}` : `✅ Pluto pre-open check passed.\n${resultLines}`, pause: false };
  }
  if (signature === (previousSignature ?? "")) return { signature, message: null, pause: false };
  return { signature, message: failing ? `⚠️ Pluto pre-open check changed.\n${resultLines}\n${recheckNote}` : `✅ Pluto pre-open check passes again.\n${resultLines}`, pause: false };
}

export type PlutoReadinessProbe = () => Promise<string>;

export interface PlutoReadinessProbes {
  ibkr: PlutoReadinessProbe;
  apiSignIn: PlutoReadinessProbe;
  openRouter: PlutoReadinessProbe;
}

/** Whole-test limits: each probe also has its own tighter limit on the request that matters. */
export const plutoReadinessTestTimeoutMs: Record<PlutoProbeTestName, number> = { IBKR: 60_000, "API sign-in": 15_000, OpenRouter: 15_000 };

async function runProbe(name: PlutoProbeTestName, probe: PlutoReadinessProbe): Promise<PlutoReadinessResult> {
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
