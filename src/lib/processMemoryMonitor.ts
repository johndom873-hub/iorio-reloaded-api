import fs from "node:fs";
import { db } from "../db/connection.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";

// One memory line per minute for a long-running process, and an ops alert when it nears its dyno's limit
// (Marcelo, 2026-10-07). Heroku only reports a process's memory once it is already over the quota (R14), so
// the agent spent a whole session at 157% unnoticed. The line separates the JS heap from native memory, which
// is what tells a JS leak from native growth. The alert fires at 90% of the container's limit (read from the
// cgroup; none when it cannot be read, e.g. on a laptop), reminds at most once a day, and announces once when
// the process is back under 80% (a lower bar, so a process hovering near 90% does not flap). The reading is resident
// memory plus the process's swap: at the limit the excess is swapped out, so resident memory alone can drop under 80%
// while the process is still over.

export const memoryLogIntervalMs = 60_000;
export const memoryAlertShareOfLimit = 0.9;
export const memoryRecoveryShareOfLimit = 0.8;
export const memoryAlertReminderMs = 24 * 60 * 60_000;

const cgroupLimitFiles = ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory.max"];

/** The process's swapped-out memory in bytes (VmSwap in /proc/self/status), 0 where there is none to read. */
export function readProcessSwapBytes(readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): number {
  try {
    const match = /^VmSwap:\s+(\d+)\s+kB$/m.exec(readFile("/proc/self/status"));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** The container's memory limit in bytes, or null when there is none to read (no cgroup, "max", or an implausible value). */
export function readContainerMemoryLimitBytes(readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): number | null {
  for (const file of cgroupLimitFiles) {
    try {
      const bytes = Number(readFile(file).trim());
      // An unlimited cgroup v1 reports a huge sentinel (~9.2e18); anything above 1 TB is no real limit.
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 40) return bytes;
    } catch {
      // try the next layout
    }
  }
  return null;
}

export type MemoryAlertState = "under" | "over";

/**
 * Pure: "alert" for any reading at or above 90% (the throttled sender decides whether that is the first message, a daily
 * reminder or nothing), "recover" when an episode is open and the reading is under 80%, otherwise null.
 */
export function decideMemoryAlert(state: MemoryAlertState, rssBytes: number, limitBytes: number): "alert" | "recover" | null {
  if (rssBytes >= limitBytes * memoryAlertShareOfLimit) return "alert";
  if (state === "over" && rssBytes < limitBytes * memoryRecoveryShareOfLimit) return "recover";
  return null;
}

const toMb = (bytes: number) => Math.round(bytes / 1_048_576);

/** Pure: the log line, e.g. "memory pluto_agent: rss=805MB swap=0MB heapUsed=… limit=512MB (157%) poolContracts=11"; the percent is of rss + swap. */
export function formatMemoryLine(processName: string, usage: NodeJS.MemoryUsage, limitBytes: number | null, counts: Record<string, number>, swapBytes = 0): string {
  const limit = limitBytes === null ? "" : ` limit=${toMb(limitBytes)}MB (${Math.round(((usage.rss + swapBytes) / limitBytes) * 100)}%)`;
  const extra = Object.entries(counts).map(([name, value]) => ` ${name}=${value}`).join("");
  return `memory ${processName}: rss=${toMb(usage.rss)}MB swap=${toMb(swapBytes)}MB heapUsed=${toMb(usage.heapUsed)}MB heapTotal=${toMb(usage.heapTotal)}MB external=${toMb(usage.external)}MB arrayBuffers=${toMb(usage.arrayBuffers)}MB${limit}${extra}`;
}

/** Starts the minute line and the alert; returns a stop function. `label` names the process in the alert ("Pluto's agent"). */
export function startProcessMemoryMonitor(options: { processName: string; label: string; counts?: () => Record<string, number> }): () => void {
  const limitBytes = readContainerMemoryLimitBytes();
  const alertKey = `memory:${options.processName}`;
  let state: MemoryAlertState = "under";
  // An episode alerted before a restart is still open: the first reading under 80% announces the recovery.
  if (limitBytes !== null) {
    db("alert_state").where({ alert_key: alertKey }).first("alert_key").then((row) => {
      if (row) state = "over";
    }).catch((error) => console.error(`memory monitor: could not read the alert state — ${error instanceof Error ? error.message : error}`));
  }
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    let counts: Record<string, number> = {};
    try {
      counts = options.counts?.() ?? {};
    } catch {
      counts = {};
    }
    const swapBytes = readProcessSwapBytes();
    console.log(formatMemoryLine(options.processName, usage, limitBytes, counts, swapBytes));
    if (limitBytes === null) return;
    const decision = decideMemoryAlert(state, usage.rss + swapBytes, limitBytes);
    if (decision === "alert") {
      state = "over";
      void notifyDownThrottled(alertKey, `⚠️ ${options.label} is using over 90% of its dyno's memory. Heroku starts swapping at 100%, which slows everything down. Check the "memory ${options.processName}" lines in the logs.`, memoryAlertReminderMs).catch((error) => console.error(`memory alert failed: ${error instanceof Error ? error.message : error}`));
    } else if (decision === "recover") {
      state = "under";
      void clearDownState(alertKey)
        .then((downForMs) => (downForMs === null ? undefined : notifyTelegramTracked(`✅ ${options.label} is back under 80% of its dyno's memory.`)))
        .catch((error) => console.error(`memory recovery alert failed: ${error instanceof Error ? error.message : error}`));
    }
  }, memoryLogIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
