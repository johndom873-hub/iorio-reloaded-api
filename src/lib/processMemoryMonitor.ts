import fs from "node:fs";
import v8 from "node:v8";
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

// Diagnostic detail on the same line (Marcelo, 2026-10-10): the staging web process held ~137 MB of resident 256 KB
// heap pages beyond what V8 reported as heapTotal, which an isolated Node 24 run did not reproduce. V8's own physical,
// malloced and per-space figures next to what the kernel sees tell V8-held pages from native (malloc) memory.

/** V8 allocates its heap in 256 KB pages, one mapping each, so resident 256 KB anonymous rw mappings are heap pages. */
const v8PageBytes = 256 * 1024;

export interface ProcessMemoryBreakdown {
  anonymousBytes: number;
  fileBackedBytes: number;
  v8PageMappings: number;
  v8PageResidentBytes: number;
}

/** Pure: totals from /proc/self/smaps text. File-backed is the resident part of mappings of a file (the node binary, libraries). */
export function parseSmapsBreakdown(smaps: string): ProcessMemoryBreakdown {
  const breakdown: ProcessMemoryBreakdown = { anonymousBytes: 0, fileBackedBytes: 0, v8PageMappings: 0, v8PageResidentBytes: 0 };
  let mapping: { sizeBytes: number; permissions: string; name: string } | null = null;
  for (const line of smaps.split("\n")) {
    const header = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (header) {
      const [, start = "0", end = "0", permissions = "", name = ""] = header;
      mapping = { sizeBytes: parseInt(end, 16) - parseInt(start, 16), permissions, name };
      continue;
    }
    if (!mapping) continue;
    const rss = /^Rss:\s+(\d+) kB$/.exec(line);
    if (rss) {
      const residentBytes = Number(rss[1]) * 1024;
      if (mapping.name.startsWith("/")) breakdown.fileBackedBytes += residentBytes;
      if (mapping.name === "" && mapping.sizeBytes === v8PageBytes && mapping.permissions === "rw-p" && residentBytes > 0) {
        breakdown.v8PageMappings += 1;
        breakdown.v8PageResidentBytes += residentBytes;
      }
      continue;
    }
    const anonymous = /^Anonymous:\s+(\d+) kB$/.exec(line);
    if (anonymous) breakdown.anonymousBytes += Number(anonymous[1]) * 1024;
  }
  return breakdown;
}

/** The breakdown of this process, or null where /proc is not there to read (a laptop). */
export function readProcessMemoryBreakdown(readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): ProcessMemoryBreakdown | null {
  try {
    return parseSmapsBreakdown(readFile("/proc/self/smaps"));
  } catch {
    return null;
  }
}

export interface V8MemoryDetail {
  physicalBytes: number;
  mallocedBytes: number;
  peakMallocedBytes: number;
  nativeContexts: number;
  detachedContexts: number;
  /** Committed bytes per group of heap spaces: new, old, code, lo (large objects), other. */
  spaceCommittedBytes: Record<"new" | "old" | "code" | "lo" | "other", number>;
}

/** Pure: committed size per space group from v8.getHeapSpaceStatistics(). */
export function summarizeHeapSpaces(spaces: { space_name: string; space_size: number }[]): V8MemoryDetail["spaceCommittedBytes"] {
  const groups: V8MemoryDetail["spaceCommittedBytes"] = { new: 0, old: 0, code: 0, lo: 0, other: 0 };
  for (const space of spaces) {
    const group = space.space_name === "new_space" || space.space_name === "new_large_object_space" ? "new" : space.space_name === "old_space" ? "old" : space.space_name.startsWith("code_") ? "code" : space.space_name === "large_object_space" ? "lo" : "other";
    groups[group] += space.space_size;
  }
  return groups;
}

export function readV8MemoryDetail(): V8MemoryDetail {
  const heap = v8.getHeapStatistics();
  return {
    physicalBytes: heap.total_physical_size,
    mallocedBytes: heap.malloced_memory,
    peakMallocedBytes: heap.peak_malloced_memory,
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
    spaceCommittedBytes: summarizeHeapSpaces(v8.getHeapSpaceStatistics()),
  };
}

/** Pure: the detail appended to the memory line, e.g. " v8Physical=44MB malloced=3MB … anon=249MB fileBacked=65MB v8Pages=731 (183MB)". */
export function formatMemoryDetail(detail: V8MemoryDetail, breakdown: ProcessMemoryBreakdown | null): string {
  const spaces = Object.entries(detail.spaceCommittedBytes).map(([name, bytes]) => `${name}:${toMb(bytes)}`).join(",");
  const v8Part = ` v8Physical=${toMb(detail.physicalBytes)}MB malloced=${toMb(detail.mallocedBytes)}MB peakMalloced=${toMb(detail.peakMallocedBytes)}MB contexts=${detail.nativeContexts} detached=${detail.detachedContexts} spaces=${spaces}`;
  if (!breakdown) return v8Part;
  return `${v8Part} anon=${toMb(breakdown.anonymousBytes)}MB fileBacked=${toMb(breakdown.fileBackedBytes)}MB v8Pages=${breakdown.v8PageMappings} (${toMb(breakdown.v8PageResidentBytes)}MB)`;
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
    let detail = "";
    try {
      detail = formatMemoryDetail(readV8MemoryDetail(), readProcessMemoryBreakdown());
    } catch {
      detail = "";
    }
    console.log(formatMemoryLine(options.processName, usage, limitBytes, counts, swapBytes) + detail);
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
