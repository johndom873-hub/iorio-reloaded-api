import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// runJob against the real job_runs table of the test database. Telegram, the throttled-alert state and the live-events
// channel are recorded instead of used, so each test can assert exactly what would have been sent.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the runJob tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const recorded = vi.hoisted(() => ({
  trackedMessages: [] as string[],
  directMessages: [] as string[],
  throttledAlerts: [] as { alertKey: string; message: string; reminderIntervalMs: number }[],
  clearedDownStates: [] as string[],
  publishedNotifications: [] as unknown[],
  throttledShouldThrow: false,
  publishShouldReject: false,
}));

vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: async (message: string) => void recorded.directMessages.push(message) }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: async (message: string) => void recorded.trackedMessages.push(message) }));
vi.mock("./throttledAlert.js", () => ({
  notifyDownThrottled: async (alertKey: string, message: string, reminderIntervalMs: number) => {
    if (recorded.throttledShouldThrow) throw new Error("alert_state is unavailable");
    recorded.throttledAlerts.push({ alertKey, message, reminderIntervalMs });
    return true;
  },
  clearDownState: async (alertKey: string) => void recorded.clearedDownStates.push(alertKey),
}));
vi.mock("./notificationChannel.js", () => ({
  publishNotification: async (notification: unknown) => {
    if (recorded.publishShouldReject) throw new Error("notification channel is down");
    recorded.publishedNotifications.push(notification);
  },
}));

const { db } = await import("../db/connection.js");
const { runJob, wasErrorAlerted, JobAlreadyRunningError, findPrecedingFailureStreak, telegramFailureSummary } = await import("./runJob.js");
const testDb: Knex = db;

const jobNamePrefix = "runjob_test_";
let jobCounter = 0;
const newJobName = () => `${jobNamePrefix}${Date.now()}_${jobCounter++}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const latestRow = (jobName: string) => testDb("job_runs").where({ job_name: jobName }).orderBy("started_at", "desc").first();

async function insertRun(jobName: string, status: "running" | "success" | "failure", startedAt: Date, errorMessage: string | null = null) {
  const [row] = await testDb("job_runs").insert({ job_name: jobName, started_at: startedAt, finished_at: status === "running" ? null : startedAt, status, error_message: errorMessage }).returning("*");
  return row as { id: string };
}

beforeEach(async () => {
  await testDb("job_runs").where("job_name", "like", `${jobNamePrefix}%`).del();
  recorded.trackedMessages.length = 0;
  recorded.directMessages.length = 0;
  recorded.throttledAlerts.length = 0;
  recorded.clearedDownStates.length = 0;
  recorded.publishedNotifications.length = 0;
  recorded.throttledShouldThrow = false;
  recorded.publishShouldReject = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await testDb("job_runs").where("job_name", "like", `${jobNamePrefix}%`).del();
  await testDb.destroy();
});

describe("runJob: a clean run", () => {
  it("records a success row with its details and stays quiet", async () => {
    const jobName = newJobName();
    await runJob(jobName, async () => ({ details: { tickers: 3 } }));
    const row = await latestRow(jobName);
    expect(row).toMatchObject({ status: "success", details: { tickers: 3 }, triggered_by: "scheduler", error_message: null });
    expect(row.finished_at).not.toBeNull();
    expect(recorded.trackedMessages).toEqual([]);
    expect(recorded.publishedNotifications).toEqual([
      { type: "job_started", jobName },
      { type: "job_completed", jobName, status: "success" },
    ]);
  });

  it("sends the job's own summary when it asks for one", async () => {
    await runJob(newJobName(), async () => ({ notify: "Captured 21 tickers" }));
    expect(recorded.trackedMessages).toEqual(["Captured 21 tickers"]);
  });

  it("records who triggered a manual run", async () => {
    const jobName = newJobName();
    await runJob(jobName, async () => ({}), { triggeredBy: "manual" });
    expect((await latestRow(jobName)).triggered_by).toBe("manual");
  });

  it("is not stopped by the live-events channel being down", async () => {
    recorded.publishShouldReject = true;
    const jobName = newJobName();
    await runJob(jobName, async () => ({}));
    expect((await latestRow(jobName)).status).toBe("success");
  });
});

describe("runJob: a thrown error", () => {
  it("records the failure, alerts once with the message, rethrows, and marks the error as already alerted", async () => {
    const jobName = newJobName();
    const boom = new Error("IBKR timed out");
    await expect(runJob(jobName, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await latestRow(jobName)).toMatchObject({ status: "failure", error_message: "IBKR timed out" });
    expect((await latestRow(jobName)).finished_at).not.toBeNull();
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: IBKR timed out`]);
    expect(wasErrorAlerted(boom)).toBe(true);
    expect(recorded.publishedNotifications).toContainEqual({ type: "job_completed", jobName, status: "failure" });
  });

  it("cuts the Telegram text at the first '): ' but keeps the full text in job_runs", async () => {
    const jobName = newJobName();
    const message = "Gateway restart failed (exit 1): docker log line 1\ndocker log line 2";
    await expect(runJob(jobName, async () => Promise.reject(new Error(message)))).rejects.toThrow();
    expect((await latestRow(jobName)).error_message).toBe(message);
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: Gateway restart failed (exit 1) (see job_runs for full output)`]);
  });

  it("falls back to the error code, then the name, when the message is empty", async () => {
    const withCode = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    await expect(runJob(newJobName(), async () => Promise.reject(withCode))).rejects.toBe(withCode);
    const withoutCode = new Error("");
    withoutCode.name = "AggregateError";
    await expect(runJob(newJobName(), async () => Promise.reject(withoutCode))).rejects.toBe(withoutCode);
    expect(recorded.trackedMessages.map((message) => message.split(": ").slice(1).join(": "))).toEqual(["ECONNREFUSED", "AggregateError"]);
  });

  it("normalises a thrown string or message-carrying object into an Error that is still marked alerted", async () => {
    const stringJob = newJobName();
    const stringFailure = await runJob(stringJob, async () => Promise.reject("plain string")).catch((error: unknown) => error);
    expect(stringFailure).toBeInstanceOf(Error);
    expect((stringFailure as Error).message).toBe("plain string");
    expect(wasErrorAlerted(stringFailure)).toBe(true);

    const objectFailure = await runJob(newJobName(), async () => Promise.reject({ message: "object message" })).catch((error: unknown) => error);
    expect((objectFailure as Error).message).toBe("object message");
  });

  it("uses the throttled alert, keyed by job, when a reminder interval is set", async () => {
    const jobName = newJobName();
    await expect(runJob(jobName, async () => Promise.reject(new Error("down")), { failureAlertReminderIntervalMs: 3_600_000 })).rejects.toThrow("down");
    expect(recorded.throttledAlerts).toEqual([{ alertKey: `job_failure:${jobName}`, message: `⚠️ ${jobName} failed: down`, reminderIntervalMs: 3_600_000 }]);
    expect(recorded.trackedMessages).toEqual([]);
  });

  it("still sends the alert directly when the throttled-alert store itself fails", async () => {
    recorded.throttledShouldThrow = true;
    const jobName = newJobName();
    await expect(runJob(jobName, async () => Promise.reject(new Error("down")), { failureAlertReminderIntervalMs: 3_600_000 })).rejects.toThrow("down");
    expect(recorded.directMessages).toEqual([`⚠️ ${jobName} failed: down`]);
  });

  it("alerts even when the failure cannot be written to job_runs", async () => {
    const jobName = newJobName();
    const failure = await runJob(jobName, async () => {
      await testDb("job_runs").where({ job_name: jobName }).del();
      throw new Error("died after its row vanished");
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("died after its row vanished");
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: died after its row vanished`]);
  });
});

describe("runJob: a run that finishes but reports a failure", () => {
  it("records a failure with its details, sends the whole message (not cut at '): '), and does not throw", async () => {
    const jobName = newJobName();
    const failureMessage = "2 of 5 tickers failed (IBKR said: no data); 1 weak snapshot";
    await runJob(jobName, async () => ({ details: { failed: 2 }, failureMessage }));
    expect(await latestRow(jobName)).toMatchObject({ status: "failure", details: { failed: 2 }, error_message: failureMessage });
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: ${failureMessage}`]);
    expect(recorded.publishedNotifications).toContainEqual({ type: "job_completed", jobName, status: "failure" });
  });

  it("also sends the job's own summary after the failure alert", async () => {
    const jobName = newJobName();
    await runJob(jobName, async () => ({ failureMessage: "partial", notify: "Captured 3 of 5" }));
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: partial`, "Captured 3 of 5"]);
  });

  it("records the failure without details when the details cannot be serialised, instead of leaving the row 'running'", async () => {
    const jobName = newJobName();
    await runJob(jobName, async () => ({ details: { total: 10n }, failureMessage: "partial" }));
    const row = await latestRow(jobName);
    expect(row).toMatchObject({ status: "failure", error_message: "partial", details: null });
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} failed: partial`]);
  });
});

describe("runJob: a success whose result cannot be recorded", () => {
  it("alerts that the row stays running, marks the error alerted and throws", async () => {
    const jobName = newJobName();
    const failure = await runJob(jobName, async () => ({ details: { total: 10n } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(wasErrorAlerted(failure)).toBe(true);
    expect((await latestRow(jobName)).status).toBe("running");
    expect(recorded.trackedMessages).toHaveLength(1);
    expect(recorded.trackedMessages[0]).toContain(`⚠️ ${jobName} finished but its result could not be recorded in job_runs`);
    expect(recorded.trackedMessages[0]).toContain('The row stays "running".');
  });
});

describe("runJob: overlapping runs", () => {
  it("refuses a second run while the first is fresh, and tells you when the scheduled one was skipped", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "running", minutesAgo(2));
    let ran = false;
    const refusal = await runJob(jobName, async () => {
      ran = true;
      return {};
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(JobAlreadyRunningError);
    expect((refusal as Error).message).toBe(`${jobName} is already running.`);
    expect(wasErrorAlerted(refusal)).toBe(true);
    expect(ran).toBe(false);
    expect(recorded.trackedMessages).toEqual([`⚠️ ${jobName} was skipped: its previous run is still marked "running", so this scheduled run did not start.`]);
    expect(await testDb("job_runs").where({ job_name: jobName }).count()).toEqual([{ count: "1" }]);
  });

  it("does not alert for a refused manual run (the person who clicked sees the error)", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "running", minutesAgo(2));
    await expect(runJob(jobName, async () => ({}), { triggeredBy: "manual" })).rejects.toBeInstanceOf(JobAlreadyRunningError);
    expect(recorded.trackedMessages).toEqual([]);
    expect(recorded.throttledAlerts).toEqual([]);
  });

  it("uses the throttled 'skipped' alert for jobs with a reminder interval", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "running", minutesAgo(2));
    await expect(runJob(jobName, async () => ({}), { failureAlertReminderIntervalMs: 600_000 })).rejects.toBeInstanceOf(JobAlreadyRunningError);
    expect(recorded.throttledAlerts.map((alert) => alert.alertKey)).toEqual([`job_skipped:${jobName}`]);
  });

  it("supersedes a stale 'running' row, alerts that the earlier run died, and goes on to run", async () => {
    const jobName = newJobName();
    const staleStartedAt = minutesAgo(20);
    const stale = await insertRun(jobName, "running", staleStartedAt);
    await runJob(jobName, async () => ({ details: { second: true } }));

    const staleRow = await testDb("job_runs").where({ id: stale.id }).first();
    expect(staleRow.status).toBe("failure");
    expect(staleRow.error_message).toMatch(/^Abandoned: still "running" after 12\d\ds with no update/);
    expect(new Date(staleRow.finished_at).getTime()).toBe(staleStartedAt.getTime());
    expect(recorded.trackedMessages[0]).toContain(`${jobName} died mid-run`);
    expect(await latestRow(jobName)).toMatchObject({ status: "success", details: { second: true } });
  });

  it("honours a job's own longer stale threshold", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "running", minutesAgo(20));
    await expect(runJob(jobName, async () => ({}), { staleRunningJobThresholdMs: 60 * 60_000 })).rejects.toBeInstanceOf(JobAlreadyRunningError);
  });
});

describe("runJob: recovery", () => {
  it("announces a recovery after one failed attempt", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "success", minutesAgo(3000));
    await insertRun(jobName, "failure", minutesAgo(1500));
    await runJob(jobName, async () => ({}));
    expect(recorded.trackedMessages).toHaveLength(1);
    expect(recorded.trackedMessages[0]).toMatch(new RegExp(`^✅ ${jobName} recovered after 1 failed attempt \\(was down since .* ET, ~.*\\)\\.$`));
  });

  it("counts the whole trailing streak of failures", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "failure", minutesAgo(3000));
    await insertRun(jobName, "failure", minutesAgo(2000));
    await insertRun(jobName, "failure", minutesAgo(1000));
    await runJob(jobName, async () => ({}));
    expect(recorded.trackedMessages[0]).toContain("recovered after 3 failed attempts");
  });

  it("says nothing when the previous run was a success", async () => {
    const jobName = newJobName();
    await insertRun(jobName, "failure", minutesAgo(3000));
    await insertRun(jobName, "success", minutesAgo(1000));
    await runJob(jobName, async () => ({}));
    expect(recorded.trackedMessages).toEqual([]);
  });

  it("clears the throttled failure and skipped state after a success when the job uses reminders", async () => {
    const jobName = newJobName();
    await runJob(jobName, async () => ({}), { failureAlertReminderIntervalMs: 600_000 });
    expect(recorded.clearedDownStates).toEqual([`job_failure:${jobName}`, `job_skipped:${jobName}`]);
  });

  it("leaves throttled state alone for jobs without reminders", async () => {
    await runJob(newJobName(), async () => ({}));
    expect(recorded.clearedDownStates).toEqual([]);
  });
});

describe("findPrecedingFailureStreak", () => {
  it("returns null when there is no history or the latest prior run succeeded", async () => {
    const jobName = newJobName();
    const current = await insertRun(jobName, "running", new Date());
    expect(await findPrecedingFailureStreak(jobName, current.id, new Date())).toBeNull();
    await insertRun(jobName, "success", minutesAgo(10));
    expect(await findPrecedingFailureStreak(jobName, current.id, new Date())).toBeNull();
  });

  it("counts only the contiguous failures just before the run and reports when the streak began", async () => {
    const jobName = newJobName();
    const firstFailureAt = minutesAgo(300);
    await insertRun(jobName, "success", minutesAgo(900));
    await insertRun(jobName, "failure", minutesAgo(600));
    await insertRun(jobName, "success", minutesAgo(400));
    await insertRun(jobName, "failure", firstFailureAt);
    await insertRun(jobName, "failure", minutesAgo(200));
    const current = await insertRun(jobName, "success", minutesAgo(1));
    const streak = await findPrecedingFailureStreak(jobName, current.id, minutesAgo(1));
    expect(streak?.failureCount).toBe(2);
    expect(streak?.failingSince.getTime()).toBe(firstFailureAt.getTime());
  });

  it("ignores other jobs' failures", async () => {
    const jobName = newJobName();
    await insertRun(newJobName(), "failure", minutesAgo(100));
    const current = await insertRun(jobName, "running", new Date());
    expect(await findPrecedingFailureStreak(jobName, current.id, new Date())).toBeNull();
  });
});

describe("telegramFailureSummary", () => {
  it("returns a message with no '): ' marker unchanged", () => {
    expect(telegramFailureSummary("plain failure")).toBe("plain failure");
  });

  it("keeps the sentence up to and including the first ')' and points at job_runs", () => {
    expect(telegramFailureSummary("could not restart (exit 1): log a (x): log b")).toBe("could not restart (exit 1) (see job_runs for full output)");
  });
});
