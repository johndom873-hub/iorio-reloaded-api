import { describe, expect, it } from "vitest";
import { buildMorningDigest, type DigestJobLine } from "./opsMonitor.js";
import { evaluateOpsMonitorLiveness } from "./opsMonitorLiveness.js";

const okJob = (jobName: string): DigestJobLine => ({ jobName, lastStartedAt: new Date("2026-10-01T13:30:10Z"), status: "success", errorMessage: null });

describe("buildMorningDigest", () => {
  it("is a one-line all-clear header plus the full lists when nothing is wrong", () => {
    const text = buildMorningDigest({ dateIso: "2026-10-01", jobs: [okJob("option_chain_capture")], invariants: [{ name: "Day Signals pool", ok: true, detail: "5 expiries seeded" }], undelivered: [], deadlineProblems: [] });
    expect(text.split("\n")[0]).toBe("✅ Iorio morning check 2026-10-01: all clear (1 jobs, 1 data checks)");
    expect(text).toContain("✅ option_chain_capture: 10-01 13:30 UTC");
    expect(text).toContain("✅ Day Signals pool: 5 expiries seeded");
  });

  it("counts and lists every kind of problem", () => {
    const text = buildMorningDigest({
      dateIso: "2026-10-01",
      jobs: [okJob("a"), { jobName: "b", lastStartedAt: new Date("2026-09-30T22:30:00Z"), status: "failure", errorMessage: "IBKR timed out\nsecond line" }, { jobName: "c", lastStartedAt: null, status: null, errorMessage: null }, { jobName: "d", lastStartedAt: new Date("2026-10-01T13:30:00Z"), status: "running", errorMessage: null }],
      invariants: [{ name: "Risk-free rate on snapshots", ok: false, detail: "missing on: AAA" }],
      undelivered: [{ alertedAt: new Date("2026-09-30T13:30:17Z"), message: "⚠️ something failed\nmore" }],
      deadlineProblems: ["⏰ option_chain_capture has not started for 2026-10-01"],
    });
    expect(text.split("\n")[0]).toBe("⚠️ Iorio morning check 2026-10-01: 6 problem(s)");
    expect(text).toContain("❌ b: failed 09-30 22:30 UTC — IBKR timed out");
    expect(text).not.toContain("second line");
    expect(text).toContain("Overdue or stuck\n⏰ option_chain_capture has not started for 2026-10-01");
    expect(text).toContain("❌ c: never run");
    expect(text).toContain("⏳ d: still running");
    expect(text).toContain("❌ Risk-free rate on snapshots: missing on: AAA");
    expect(text).toContain("Alerts Telegram could not deliver\n• 09-30 13:30 UTC — ⚠️ something failed");
  });
});

describe("buildMorningDigest with pending jobs", () => {
  const base = { dateIso: "2026-10-01", invariants: [{ name: "Day Signals pool", ok: true, detail: "5 expiries seeded" }], undelivered: [], deadlineProblems: [] };

  it("says nothing is wrong SO FAR (not 'all clear') while a job is still due, and shows it as pending instead of yesterday's green line", () => {
    const text = buildMorningDigest({ ...base, jobs: [okJob("option_chain_capture"), okJob("option_surface_fit")], pendingJobs: ["option_surface_fit"] });
    expect(text.split("\n")[0]).toBe("✅ Iorio morning check 2026-10-01: nothing wrong so far, still to run today: option_surface_fit");
    expect(text).toContain("⏳ option_surface_fit: not run yet today (last run 10-01 13:30 UTC)");
    expect(text).toContain("✅ option_chain_capture: 10-01 13:30 UTC");
  });

  it("a real problem still wins over pending", () => {
    const text = buildMorningDigest({ ...base, jobs: [okJob("a")], pendingJobs: ["a"], invariants: [{ name: "Risk-free rate", ok: false, detail: "no rate stored" }] });
    expect(text.split("\n")[0]).toBe("⚠️ Iorio morning check 2026-10-01: 1 problem(s)");
  });
});

describe("evaluateOpsMonitorLiveness", () => {
  const now = new Date("2026-10-01T14:00:00Z");
  it("passes on a fresh heartbeat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: new Date("2026-10-01T13:58:00Z") })).toBeNull());
  it("flags a stale heartbeat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: new Date("2026-10-01T13:50:00Z") })).toContain("over 5 min old"));
  it("flags a monitor that never beat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: null })).toContain("never reported"));
});
