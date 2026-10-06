import { describe, expect, it } from "vitest";
import { buildMorningDigest, type DigestJobLine } from "./opsMonitor.js";
import { evaluateOpsMonitorLiveness } from "./opsMonitorLiveness.js";

const utc = (iso: string) => new Date(iso);
const now = utc("2026-10-05T14:45:00Z"); // Monday 10:45 ET
const job = (jobName: string, lastStartedAt: string | null, status: DigestJobLine["status"], scheduledTodayAt: string | null, errorMessage: string | null = null): DigestJobLine => ({
  jobName,
  lastStartedAt: lastStartedAt ? utc(lastStartedAt) : null,
  status,
  errorMessage,
  scheduledTodayAt: scheduledTodayAt ? utc(scheduledTodayAt) : null,
});
const okCheck = (name: string, detail = "fine") => ({ name, ok: true, detail });
const base = { dateIso: "2026-10-05", now, undelivered: [], deadlineProblems: [] };

describe("buildMorningDigest", () => {
  it("renders the 2026-10-05 staging case: problems first and labelled, ran-today and due-later jobs separated, ET times", () => {
    const text = buildMorningDigest({
      ...base,
      jobs: [
        job("option_chain_structure_refresh", "2026-10-05T09:00:05Z", "success", "2026-10-05T09:00:00Z"),
        job("option_chain_capture", "2026-10-05T14:00:20Z", "failure", "2026-10-05T14:00:00Z", "weak snapshots: BSBR: two-sided quotes 11% (min 75%)"),
        job("option_surface_fit", "2026-10-05T14:06:00Z", "success", "2026-10-05T14:00:00Z"),
        job("daily_screener_scan", "2026-10-02T18:00:10Z", "success", "2026-10-05T18:00:00Z"),
        job("market_calendar_sync", "2026-10-04T19:00:10Z", "success", "2026-10-05T19:00:00Z"),
        job("daily_market_data_capture", "2026-10-02T22:00:10Z", "success", "2026-10-05T22:00:00Z"),
        job("daily_pnl_snapshot", "2026-10-02T22:30:10Z", "failure", "2026-10-05T22:30:00Z", "8 of 12 positions skipped for a missing price: COIN, INTC\nstack"),
      ],
      invariants: [okCheck("Risk-free rate on snapshots"), { name: "Two-sided quote coverage", ok: false, detail: "below 75%: BSBR 11%" }, { name: "Surface fits", ok: false, detail: "no fitted expiry for: BSBR" }],
    });
    expect(text.split("\n")[0]).toBe("⚠️ Iorio morning check Mon 2026-10-05: 4 problem(s)");
    expect(text).toContain("Problems\n❌ Job option_chain_capture: failed 10:00 ET — weak snapshots: BSBR: two-sided quotes 11% (min 75%)\n❌ Job daily_pnl_snapshot: failed Fri 10-02 18:30 ET — 8 of 12 positions skipped for a missing price: COIN, INTC · next run today 18:30 ET\n❌ Data check, Two-sided quote coverage: below 75%: BSBR 11%\n❌ Data check, Surface fits: no fitted expiry for: BSBR");
    expect(text).toContain("Jobs that ran today\n✅ option_chain_structure_refresh 05:00 ET\n✅ option_surface_fit 10:06 ET");
    expect(text).toContain("Jobs due later today\n⏳ daily_screener_scan 14:00 ET (last run Fri 10-02 14:00 ET ✅)\n⏳ market_calendar_sync 15:00 ET (last run Sun 10-04 15:00 ET ✅)\n⏳ daily_market_data_capture 18:00 ET (last run Fri 10-02 18:00 ET ✅)");
    expect(text).toContain("Data checks: 1 of 3 passing (the failing ones are under Problems)");
    expect(text).not.toContain("UTC");
    expect(text).not.toContain("stack");
  });

  it("says nothing is wrong so far, not all clear, while jobs are still due later today", () => {
    const text = buildMorningDigest({ ...base, jobs: [job("a", "2026-10-05T09:00:00Z", "success", "2026-10-05T09:00:00Z"), job("b", "2026-10-04T23:00:10Z", "success", "2026-10-05T23:00:00Z")], invariants: [okCheck("Day Signals pool", "5 expiries seeded")] });
    expect(text.split("\n")[0]).toBe("✅ Iorio morning check Mon 2026-10-05: nothing wrong so far, 1 job(s) still due later today");
    expect(text).toContain("⏳ b 19:00 ET (last run Sun 10-04 19:00 ET ✅)");
    expect(text).toContain("✅ Data checks: 1 of 1 passing");
  });

  it("lists jobs in time order whatever order they are given in", () => {
    const text = buildMorningDigest({ ...base, jobs: [job("late", "2026-10-04T23:00:00Z", "success", "2026-10-05T23:00:00Z"), job("early", "2026-10-04T18:00:00Z", "success", "2026-10-05T18:00:00Z")], invariants: [] });
    expect(text.indexOf("⏳ early")).toBeLessThan(text.indexOf("⏳ late"));
  });

  it("is all clear once every job has run today and every check passes", () => {
    const text = buildMorningDigest({ ...base, jobs: [job("a", "2026-10-05T09:00:00Z", "success", "2026-10-05T09:00:00Z")], invariants: [okCheck("Day Signals pool")] });
    expect(text.split("\n")[0]).toBe("✅ Iorio morning check Mon 2026-10-05: all clear (1 jobs, 1 data checks)");
  });

  it("counts and lists every kind of problem", () => {
    const text = buildMorningDigest({
      ...base,
      jobs: [job("c", null, null, "2026-10-05T14:00:00Z"), job("d", "2026-10-05T13:30:00Z", "running", "2026-10-05T14:00:00Z")],
      invariants: [{ name: "Risk-free rate on snapshots", ok: false, detail: "missing on: AAA" }],
      undelivered: [{ alertedAt: utc("2026-10-04T13:30:17Z"), message: "⚠️ something failed\nmore" }],
      deadlineProblems: ["⏰ option_chain_capture has not started for 2026-10-05 (was due 10:00 ET, deadline passed at 10:35 ET)"],
    });
    expect(text.split("\n")[0]).toBe("⚠️ Iorio morning check Mon 2026-10-05: 5 problem(s)");
    expect(text).toContain("Problems\n⏰ option_chain_capture has not started for 2026-10-05");
    expect(text).toContain("❌ Job c: never run");
    expect(text).toContain("⏳ Job d: still running (started 09:30 ET)");
    expect(text).toContain("❌ Data check, Risk-free rate on snapshots: missing on: AAA");
    expect(text).toContain("Alerts Telegram could not deliver\n• Sun 10-04 09:30 ET — ⚠️ something failed");
  });

  it("shows a job whose slot has begun but has not started as due, with its slot time", () => {
    const text = buildMorningDigest({ ...base, jobs: [job("option_surface_fit", "2026-10-04T14:06:00Z", "success", "2026-10-05T14:00:00Z")], pendingJobs: ["option_surface_fit"], invariants: [okCheck("x")] });
    expect(text).toContain("⏳ option_surface_fit was due 10:00 ET, not started yet (last run Sun 10-04 10:06 ET ✅)");
    expect(text.split("\n")[0]).toContain("nothing wrong so far, 1 job(s) still due later today");
  });

  it("a real problem still wins over pending", () => {
    const text = buildMorningDigest({ ...base, jobs: [job("a", "2026-10-04T14:06:00Z", "success", "2026-10-05T14:00:00Z")], pendingJobs: ["a"], invariants: [{ name: "Risk-free rate", ok: false, detail: "no rate stored" }] });
    expect(text.split("\n")[0]).toBe("⚠️ Iorio morning check Mon 2026-10-05: 1 problem(s)");
  });

  it("files a last run after ET midnight under its ET day, not the UTC one", () => {
    // 2026-10-05 03:00 UTC is still Sunday 23:00 ET: not "ran today" on Monday.
    const text = buildMorningDigest({ ...base, jobs: [job("a", "2026-10-05T03:00:00Z", "success", "2026-10-05T22:00:00Z")], invariants: [] });
    expect(text).toContain("⏳ a 18:00 ET (last run Sun 10-04 23:00 ET ✅)");
    expect(text).not.toContain("Jobs that ran today");
  });
});

describe("evaluateOpsMonitorLiveness", () => {
  const now = new Date("2026-10-01T14:00:00Z");
  it("passes on a fresh heartbeat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: new Date("2026-10-01T13:58:00Z") })).toBeNull());
  it("flags a stale heartbeat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: new Date("2026-10-01T13:50:00Z") })).toContain("over 5 min old"));
  it("flags a monitor that never beat", () => expect(evaluateOpsMonitorLiveness({ now, heartbeatAt: null })).toContain("never reported"));
});
