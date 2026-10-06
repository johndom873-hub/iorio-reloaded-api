import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvariantResult } from "./dataInvariants.js";

// The ops monitor against the real job_runs and alert_state tables of the test database. Dates are in March 2031 (standard time,
// UTC-5; market_calendar has no rows that far out, so the weekday fallback decides trading days). 2031-03-03 is a Monday.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the ops monitor tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const recorded = vi.hoisted(() => ({
  directMessages: [] as string[],
  trackedMessages: [] as string[],
  throttledAlerts: [] as { alertKey: string; message: string }[],
  clearedUndeliveredKeys: [] as string[],
  digestDelivered: true,
  undelivered: [] as { alertKey: string; alertedAt: Date; message: string }[],
  invariants: [] as InvariantResult[],
  dataLoadError: null as Error | null,
}));

vi.mock("./notifyTelegram.js", () => ({
  notifyTelegram: async (message: string) => {
    recorded.directMessages.push(message);
    return recorded.digestDelivered;
  },
}));
vi.mock("./undeliveredAlerts.js", () => ({
  notifyTelegramTracked: async (message: string) => void recorded.trackedMessages.push(message),
  loadUndeliveredAlerts: async () => recorded.undelivered,
  clearUndeliveredAlerts: async (keys: string[]) => void recorded.clearedUndeliveredKeys.push(...keys),
}));
vi.mock("./throttledAlert.js", () => ({
  notifyDownThrottled: async (alertKey: string, message: string) => {
    recorded.throttledAlerts.push({ alertKey, message });
    return true;
  },
}));
vi.mock("./dataInvariants.js", () => ({
  loadDataInvariantInputs: async () => {
    if (recorded.dataLoadError) throw recorded.dataLoadError;
    return {};
  },
  evaluateDataInvariants: () => recorded.invariants,
}));
vi.mock("./preOpenReadinessRunner.js", () => ({ pruneOldReadinessState: async () => {}, runPreOpenReadinessIfDue: async () => {} }));

const { db } = await import("../db/connection.js");
const { findDeadlineProblems, loadLatestRunPerExpectedJob, reportJobDeadlines, sendMorningDigestIfDue } = await import("./opsMonitor.js");
const testDb: Knex = db;

const utc = (iso: string) => new Date(iso);
const testDateRange = [utc("2031-02-20T00:00:00Z"), utc("2031-03-20T00:00:00Z")] as const;

async function insertRun(jobName: string, startedAt: string, status: "running" | "success" | "failure", errorMessage: string | null = null) {
  await testDb("job_runs").insert({ job_name: jobName, started_at: utc(startedAt), finished_at: status === "running" ? null : utc(startedAt), status, error_message: errorMessage });
}

async function cleanUp() {
  await testDb("job_runs").whereBetween("started_at", [...testDateRange]).del();
  await testDb("alert_state").where("alert_key", "like", "deadline:%2031-%").del();
  await testDb("alert_state").where("alert_key", "like", "deadline:%:stuck:2031-%").del();
  await testDb("alert_state").where("alert_key", "like", "digest:2031-%").del();
}

beforeEach(async () => {
  await cleanUp();
  recorded.directMessages.length = 0;
  recorded.trackedMessages.length = 0;
  recorded.throttledAlerts.length = 0;
  recorded.clearedUndeliveredKeys.length = 0;
  recorded.digestDelivered = true;
  recorded.undelivered = [];
  recorded.invariants = [{ name: "Day Signals pool", ok: true, detail: "5 expiries seeded" }];
  recorded.dataLoadError = null;
});

afterAll(async () => {
  await cleanUp();
  await testDb.destroy();
});

describe("loadLatestRunPerExpectedJob", () => {
  it("returns the newest run of each expected job with its slot today, and nulls for a job that never ran", async () => {
    await insertRun("daily_pnl_snapshot", "2031-03-01T22:30:05Z", "failure", "8 of 12 positions skipped");
    await insertRun("daily_pnl_snapshot", "2031-03-03T22:30:07Z", "success");
    const lines = await loadLatestRunPerExpectedJob(utc("2031-03-04T14:45:00Z"));
    const pnl = lines.find((line) => line.jobName === "daily_pnl_snapshot")!;
    expect(pnl).toMatchObject({ status: "success", errorMessage: null });
    expect(pnl.lastStartedAt?.toISOString()).toBe("2031-03-03T22:30:07.000Z");
    expect(pnl.scheduledTodayAt?.toISOString()).toBe("2031-03-04T22:30:00.000Z");
    expect(lines.map((line) => line.jobName)).toContain("option_chain_capture");
  });

  it("puts an Eastern-zone job's slot at 10:00 ET of the Eastern day (15:00 UTC in standard time)", async () => {
    const lines = await loadLatestRunPerExpectedJob(utc("2031-03-04T14:45:00Z"));
    expect(lines.find((line) => line.jobName === "option_chain_capture")!.scheduledTodayAt?.toISOString()).toBe("2031-03-04T15:00:00.000Z");
  });

  it("carries a failed run's message", async () => {
    await insertRun("market_calendar_sync", "2031-03-03T19:00:04Z", "failure", "MarketData.app 502");
    const line = (await loadLatestRunPerExpectedJob(utc("2031-03-04T14:45:00Z"))).find((candidate) => candidate.jobName === "market_calendar_sync")!;
    expect(line).toMatchObject({ status: "failure", errorMessage: "MarketData.app 502" });
  });
});

describe("findDeadlineProblems", () => {
  it("returns the recent runs it judged and the overdue jobs among them", async () => {
    await insertRun("ibkr_health_check", "2031-03-03T09:06:00Z", "success");
    const { runs, problems } = await findDeadlineProblems(utc("2031-03-03T09:11:00Z"));
    expect(runs.map((run) => run.jobName)).toEqual(["ibkr_health_check"]);
    expect(problems.map((problem) => problem.alertKey)).toEqual(["deadline:option_chain_structure_refresh:2031-03-03", "deadline:session_close_read:2031-03-03"]);
  });

  it("does not expect market-day jobs on a weekend", async () => {
    await insertRun("ibkr_health_check", "2031-03-01T23:10:00Z", "success");
    const { problems } = await findDeadlineProblems(utc("2031-03-01T23:11:00Z"));
    // Only the three jobs that also run on weekends are expected on Saturday 2031-03-01.
    expect(problems.map((problem) => problem.alertKey)).toEqual(["deadline:market_calendar_sync:2031-03-01", "deadline:daily_calendar_capture:2031-03-01", "deadline:expiry_settlement_audit:2031-03-01"]);
  });
});

describe("reportJobDeadlines", () => {
  it("raises one throttled alert per overdue job, with the slot in Eastern time", async () => {
    await insertRun("ibkr_health_check", "2031-03-03T09:06:00Z", "success");
    await reportJobDeadlines(utc("2031-03-03T09:11:00Z"));
    expect(recorded.throttledAlerts).toEqual([
      {
        alertKey: "deadline:option_chain_structure_refresh:2031-03-03",
        message: "⏰ option_chain_structure_refresh has not started for 2031-03-03 (was due 04:00 ET, deadline passed at 04:10 ET). Check the Heroku Scheduler entry and the job's clock guard.",
      },
      {
        alertKey: "deadline:session_close_read:2031-03-03",
        message: "⏰ session_close_read has not started for 2031-03-03 (was due 04:00 ET, deadline passed at 04:10 ET). Check the Heroku Scheduler entry and the job's clock guard.",
      },
    ]);
  });

  it("announces once that an alerted job has now run, and forgets the alert", async () => {
    const alertKey = "deadline:option_chain_structure_refresh:2031-03-03";
    await testDb("alert_state").insert({ alert_key: alertKey, first_alerted_at: utc("2031-03-03T09:11:00Z"), last_alerted_at: utc("2031-03-03T09:11:00Z"), last_message: "x" });
    await insertRun("ibkr_health_check", "2031-03-03T09:20:00Z", "success");
    await insertRun("option_chain_structure_refresh", "2031-03-03T09:15:00Z", "success");
    await reportJobDeadlines(utc("2031-03-03T09:25:00Z"));
    expect(recorded.trackedMessages).toEqual(["✅ option_chain_structure_refresh has now run (its deadline alert is cleared)."]);
    expect(await testDb("alert_state").where({ alert_key: alertKey })).toEqual([]);
    await reportJobDeadlines(utc("2031-03-03T09:26:00Z"));
    expect(recorded.trackedMessages).toHaveLength(1);
  });

  it("does not take the NEXT day's normal run for the missed one catching up", async () => {
    const alertKey = "deadline:option_chain_structure_refresh:2031-03-03";
    await testDb("alert_state").insert({ alert_key: alertKey, first_alerted_at: utc("2031-03-03T09:11:00Z"), last_alerted_at: utc("2031-03-03T09:11:00Z"), last_message: "x" });
    await insertRun("ibkr_health_check", "2031-03-04T09:00:00Z", "success");
    await insertRun("option_chain_structure_refresh", "2031-03-04T09:00:03Z", "success");
    await reportJobDeadlines(utc("2031-03-04T09:05:00Z"));
    expect(recorded.trackedMessages).toEqual([]);
    expect(await testDb("alert_state").where({ alert_key: alertKey })).toHaveLength(1);
  });

  it("clears a stuck-run alert once that run has ended", async () => {
    const startedAt = "2031-03-03T22:00:05.000Z";
    const alertKey = `deadline:daily_market_data_capture:stuck:${startedAt}`;
    await testDb("alert_state").insert({ alert_key: alertKey, first_alerted_at: utc("2031-03-03T23:10:00Z"), last_alerted_at: utc("2031-03-03T23:10:00Z"), last_message: "x" });
    await insertRun("ibkr_health_check", "2031-03-03T23:20:00Z", "success");
    await insertRun("daily_market_data_capture", startedAt, "failure", "gave up");
    await reportJobDeadlines(utc("2031-03-03T23:25:00Z"));
    expect(recorded.trackedMessages).toEqual(["✅ daily_market_data_capture has now run (its deadline alert is cleared)."]);
  });

  it("silently drops an old alert that never caught up, after three days", async () => {
    const alertKey = "deadline:daily_screener_scan:2031-02-27";
    await testDb("alert_state").insert({ alert_key: alertKey, first_alerted_at: utc("2031-02-27T18:10:00Z"), last_alerted_at: utc("2031-02-27T18:10:00Z"), last_message: "x" });
    await insertRun("ibkr_health_check", "2031-03-03T09:06:00Z", "success");
    await reportJobDeadlines(utc("2031-03-03T09:08:00Z"));
    expect(recorded.trackedMessages).toEqual([]);
    expect(await testDb("alert_state").where({ alert_key: alertKey })).toEqual([]);
  });
});

describe("sendMorningDigestIfDue", () => {
  it("does nothing before 10:45 ET, after 16:00 ET, or on a closed day", async () => {
    expect(await sendMorningDigestIfDue(utc("2031-03-03T15:44:00Z"))).toBe(false); // 10:44 ET
    expect(await sendMorningDigestIfDue(utc("2031-03-03T21:00:00Z"))).toBe(false); // 16:00 ET
    expect(await sendMorningDigestIfDue(utc("2031-03-01T16:00:00Z"))).toBe(false); // Saturday
    expect(recorded.directMessages).toEqual([]);
    expect(await testDb("alert_state").where("alert_key", "like", "digest:2031-%")).toEqual([]);
  });

  it("sends the digest once per open day, in Eastern time, and a second call the same day does nothing", async () => {
    await insertRun("option_chain_structure_refresh", "2031-03-03T09:00:04Z", "success");
    expect(await sendMorningDigestIfDue(utc("2031-03-03T15:50:00Z"))).toBe(true);
    expect(await sendMorningDigestIfDue(utc("2031-03-03T16:30:00Z"))).toBe(false);
    expect(recorded.directMessages).toHaveLength(1);
    expect(recorded.directMessages[0]!.split("\n")[0]).toContain("Iorio morning check Mon 2031-03-03");
    expect(recorded.directMessages[0]).toContain("option_chain_structure_refresh 04:00 ET");
    expect(recorded.directMessages[0]).not.toContain("UTC");
  });

  it("lists undelivered alerts and clears them once the digest was delivered", async () => {
    recorded.undelivered = [{ alertKey: "undelivered:1", alertedAt: utc("2031-03-02T14:00:00Z"), message: "⚠️ something failed\nmore" }];
    await sendMorningDigestIfDue(utc("2031-03-03T15:50:00Z"));
    expect(recorded.directMessages[0]).toContain("Alerts Telegram could not deliver\n• Sun 03-02 09:00 ET — ⚠️ something failed");
    expect(recorded.clearedUndeliveredKeys).toEqual(["undelivered:1"]);
  });

  it("lists at most ten undelivered alerts and clears only those it listed", async () => {
    recorded.undelivered = Array.from({ length: 12 }, (_, index) => ({ alertKey: `undelivered:${index}`, alertedAt: utc("2031-03-02T14:00:00Z"), message: `alert ${index}` }));
    await sendMorningDigestIfDue(utc("2031-03-03T15:50:00Z"));
    expect(recorded.clearedUndeliveredKeys).toEqual(Array.from({ length: 10 }, (_, index) => `undelivered:${index}`));
  });

  it("keeps the undelivered alerts for tomorrow when the digest is cut by Telegram's length limit", async () => {
    recorded.invariants = [{ name: "Long check", ok: false, detail: "x".repeat(4100) }];
    recorded.undelivered = [{ alertKey: "undelivered:1", alertedAt: utc("2031-03-02T14:00:00Z"), message: "m" }];
    await sendMorningDigestIfDue(utc("2031-03-03T15:50:00Z"));
    expect(recorded.clearedUndeliveredKeys).toEqual([]);
  });

  it("releases the day's claim and rethrows when building the digest fails, so the next tick retries", async () => {
    recorded.dataLoadError = new Error("snapshot query failed");
    await expect(sendMorningDigestIfDue(utc("2031-03-03T15:50:00Z"))).rejects.toThrow("snapshot query failed");
    expect(await testDb("alert_state").where({ alert_key: "digest:2031-03-03" })).toEqual([]);
    recorded.dataLoadError = null;
    expect(await sendMorningDigestIfDue(utc("2031-03-03T15:51:00Z"))).toBe(true);
  });

  it("releases the claim when Telegram does not deliver, pauses five minutes, then retries", async () => {
    recorded.digestDelivered = false;
    expect(await sendMorningDigestIfDue(utc("2031-03-04T15:50:00Z"))).toBe(false);
    expect(await testDb("alert_state").where({ alert_key: "digest:2031-03-04" })).toEqual([]);
    expect(recorded.clearedUndeliveredKeys).toEqual([]);

    recorded.digestDelivered = true;
    expect(await sendMorningDigestIfDue(utc("2031-03-04T15:53:00Z"))).toBe(false);
    expect(recorded.directMessages).toHaveLength(1);
    expect(await sendMorningDigestIfDue(utc("2031-03-04T15:56:00Z"))).toBe(true);
    expect(recorded.directMessages).toHaveLength(2);
  });
});
