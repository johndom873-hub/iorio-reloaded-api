import { easternInstant } from "../lib/marketSessionStatus.js";
import { readinessSchedule } from "../lib/preOpenReadiness.js";

// Pluto's pre-open readiness check (Marcelo, 2026-10-06), on the platform readiness timetable: first run at 6:00 ET (a
// failure alerts at once), re-run every 10 minutes while anything fails (announced only when the set of failures changes),
// and a final run at 9:20 ET that pauses Pluto if anything still fails. It proves the two things only Pluto's own process
// can: its IBKR connection and its sign-in to the API. A third test, "Pluto running"
// (Marcelo, 2026-10-07), is not a probe: a Pluto that will not act today is announced at 6:00 and 9:20 ET instead of being
// reported "ready". The check runs whether Pluto is on, paused or off. A failure is an error only when Pluto is meant to trade
// today (Marcelo, 2026-10-12): switched off, Pluto itself and any failed probe are warnings; on but paused is an error.

export type PlutoProbeTestName = "IBKR" | "API sign-in";
export type PlutoReadinessTestName = PlutoProbeTestName | "Pluto running";
export const plutoReadinessTestNames: PlutoReadinessTestName[] = ["IBKR", "API sign-in", "Pluto running"];
const plutoRunningTestName: PlutoReadinessTestName = "Pluto running";

export type PlutoReadinessStatus = "ok" | "warn" | "fail";

export interface PlutoReadinessResult {
  name: PlutoReadinessTestName;
  /** The test passed. */
  ok: boolean;
  /** What a failed test means today: "fail" only when Pluto is meant to trade. Runs stored before 2026-10-12 have none. */
  status: PlutoReadinessStatus;
  detail: string;
}

export type PlutoReadinessRunKind = "first" | "recheck" | "final";

/** Today's latest run, stored on pluto_state.readiness. */
export interface PlutoReadinessRecord {
  dateIso: string;
  lastRunAt: string;
  lastRunKind: PlutoReadinessRunKind;
  /** The names of the tests with status "fail" joined, "" when none fails. */
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

/**
 * Pure: a re-check whose last run failed only "Pluto running" (Pluto paused, every probe passing) keeps that run's probe
 * results and re-reads just Pluto's state (Marcelo, 2026-10-07): a paused Pluto would otherwise open an IBKR probe connection
 * every 10 minutes all morning. A switched-off Pluto has no failing test, so it is never re-checked. Null: run the probes.
 */
export function reusableProbeResults(kind: PlutoReadinessRunKind, todaysRecord: PlutoReadinessRecord | null): PlutoReadinessResult[] | null {
  if (kind !== "recheck" || !todaysRecord) return null;
  const probeResults = todaysRecord.results.filter((result) => result.name !== plutoRunningTestName);
  return probeResults.length === plutoReadinessTestNames.length - 1 && probeResults.every((result) => result.ok) ? probeResults : null;
}

const pauseReasonDescriptions: Record<string, string> = {
  manual: "paused by a person",
  deploy: "paused after a deploy",
  crash_loop: "paused after repeated restarts",
  readiness: "paused by an earlier pre-open check",
};

type PlutoStateForReadiness = { mode: string; paused: boolean; pauseReason: string | null };

/** Pure: the "Pluto running" test. Passes when the mode is on and Pluto is not paused; switched off is a warning, on but paused an error. */
export function evaluatePlutoRunning(state: PlutoStateForReadiness): PlutoReadinessResult {
  if (state.mode !== "on") return { name: plutoRunningTestName, ok: false, status: "warn", detail: "switched off, so it will not trade today" };
  if (!state.paused) return { name: plutoRunningTestName, ok: true, status: "ok", detail: "on and not paused" };
  const reason = state.pauseReason ?? "";
  const pause = reason.startsWith("breaker:") ? `paused, the ${reason.slice("breaker:".length).replace(/_/g, " ")} breaker is tripped` : (pauseReasonDescriptions[reason] ?? "paused");
  return { name: plutoRunningTestName, ok: false, status: "fail", detail: pause };
}

/** Pure: the probe results graded for today (a failed probe is an error only when Pluto is on), followed by "Pluto running". */
export function assemblePlutoReadinessResults(probeResults: PlutoReadinessResult[], state: PlutoStateForReadiness): PlutoReadinessResult[] {
  const failedProbeStatus: PlutoReadinessStatus = state.mode === "on" ? "fail" : "warn";
  return [...probeResults.map((result) => ({ ...result, status: result.ok ? ("ok" as const) : failedProbeStatus })), evaluatePlutoRunning(state)];
}

export function plutoReadinessSignature(results: PlutoReadinessResult[]): string {
  return results
    .filter((result) => result.status === "fail")
    .map((result) => result.name)
    .join("|");
}

const finalCheckEt = `${readinessSchedule.finalCheck.hour}:${String(readinessSchedule.finalCheck.minute).padStart(2, "0")} ET`;

/**
 * Pure: what a run means, announced like the platform readiness check: the 6:00 ET first run and the 9:20 ET final run always
 * post (passing or not); a re-run posts only when the set of failing tests changed (including back to none failing). The final
 * run pauses Pluto when a probe still fails, but only a Pluto that is running: "Pluto running" failing means it is already
 * paused, so it never causes a pause itself; a switched-off Pluto has no failing test at all.
 */
export function describePlutoReadinessOutcome(kind: PlutoReadinessRunKind, previousSignature: string | null, results: PlutoReadinessResult[]): { signature: string; message: string | null; pause: boolean } {
  const signature = plutoReadinessSignature(results);
  const icons: Record<PlutoReadinessStatus, string> = { fail: "❌", warn: "⚠️", ok: "✅" };
  const resultLines = (["fail", "warn", "ok"] as const).flatMap((status) => results.filter((result) => result.status === status).map((result) => `${icons[status]} ${result.name}: ${result.detail}`)).join("\n");
  const failing = signature !== "";
  const failingNames = results.filter((result) => result.status === "fail").map((result) => result.name);
  const notRunning = failingNames.includes(plutoRunningTestName);
  const probeFailing = failingNames.some((name) => name !== plutoRunningTestName);
  const switchedOff = results.some((result) => result.name === plutoRunningTestName && result.status === "warn");
  const hasWarnings = results.some((result) => result.status === "warn");
  const recheckNote = probeFailing && !notRunning ? `Re-checking every ${readinessSchedule.preOpenRecheckMinutes} minutes. Pluto pauses at ${finalCheckEt} if it still fails.` : `Re-checking every ${readinessSchedule.preOpenRecheckMinutes} minutes.`;
  const withWarnings = hasWarnings ? ", with warnings" : "";

  if (kind === "final") {
    if (!failing && switchedOff) return { signature, message: `⚠️ Pluto is switched off at the ${finalCheckEt} check, so it will not trade today.\n${resultLines}\nSwitch it on on the Pluto screen to let it act today.`, pause: false };
    if (!failing) return { signature, message: `✅ Pluto ready for today (${finalCheckEt} check)${withWarnings}.\n${resultLines}`, pause: false };
    if (!probeFailing) return { signature, message: `🛑 Pluto is paused at the ${finalCheckEt} check.\n${resultLines}\nResume it on the Pluto screen to let it act today.`, pause: false };
    if (notRunning) return { signature, message: `🛑 Pluto not ready: the ${finalCheckEt} check still fails, and Pluto is paused.\n${resultLines}\nFix what failed, then resume it on the Pluto screen.`, pause: false };
    return { signature, message: `🛑 Pluto not ready: the ${finalCheckEt} check still fails, so Pluto is paused.\n${resultLines}\nPress Resume on the Pluto screen once it is fixed.`, pause: true };
  }
  if (kind === "first") {
    if (failing) return { signature, message: `⚠️ Pluto pre-open check failed.\n${resultLines}\n${recheckNote}`, pause: false };
    return { signature, message: switchedOff ? `⚠️ Pluto is switched off, so it will not trade today.\n${resultLines}` : `✅ Pluto pre-open check passed${withWarnings}.\n${resultLines}`, pause: false };
  }
  if (signature === (previousSignature ?? "")) return { signature, message: null, pause: false };
  return { signature, message: failing ? `⚠️ Pluto pre-open check changed.\n${resultLines}\n${recheckNote}` : `✅ Pluto pre-open check passes again.\n${resultLines}`, pause: false };
}

export type PlutoReadinessProbe = () => Promise<string>;

export interface PlutoReadinessProbes {
  ibkr: PlutoReadinessProbe;
  apiSignIn: PlutoReadinessProbe;
}

/** Whole-test limits: each probe also has its own tighter limit on the request that matters. */
export const plutoReadinessTestTimeoutMs: Record<PlutoProbeTestName, number> = { IBKR: 60_000, "API sign-in": 15_000 };

async function runProbe(name: PlutoProbeTestName, probe: PlutoReadinessProbe): Promise<PlutoReadinessResult> {
  const timeoutMs = plutoReadinessTestTimeoutMs[name];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    });
    const detail = await Promise.race([probe(), timeout]);
    return { name, ok: true, status: "ok", detail };
  } catch (error) {
    // Graded "fail" until assemblePlutoReadinessResults knows whether Pluto is meant to trade today.
    return { name, ok: false, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the two tests side by side; never throws. */
export async function runPlutoReadinessTests(probes: PlutoReadinessProbes): Promise<PlutoReadinessResult[]> {
  return Promise.all([runProbe("IBKR", probes.ibkr), runProbe("API sign-in", probes.apiSignIn)]);
}
