import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessCheck } from "./preOpenReadiness.js";

// The runner against the real alert_state table of the test database: what is sent, what is remembered, and that two dynos cannot double up.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the readiness runner tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const state = { appEnvironment: "production", openDay: true, checks: [] as ReadinessCheck[], stages: [] as string[] };
const sentMessages: string[] = [];

vi.mock("./appEnvironment.js", () => ({ readAppEnvironment: () => state.appEnvironment }));
vi.mock("./marketSessionStatus.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./marketSessionStatus.js")>()), resolveIsOpenDay: async () => state.openDay }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: async (message: string) => void sentMessages.push(message) }));
vi.mock("./preOpenReadinessCollectors.js", () => ({
  collectReadinessChecks: async (stage: string) => {
    state.stages.push(stage);
    return state.checks;
  },
  createDefaultReadinessDependencies: () => ({ appEnvironment: state.appEnvironment }),
}));

const { db } = await import("../db/connection.js");
const { loadReadinessState, pruneOldReadinessState, runPreOpenReadinessIfDue } = await import("./preOpenReadinessRunner.js");
const testDb: Knex = db;

// 2031-03-03 is a Monday in standard time: 6:00 ET = 11:00 UTC, 9:20 = 14:20, 9:35 = 14:35, 10:15 = 15:15.
const dateIso = "2031-03-03";
const at = (time: string) => new Date(`${dateIso}T${time}:00Z`);
const ok = (name: string): ReadinessCheck => ({ name, status: "ok", detail: "fine" });
const fail = (name: string): ReadinessCheck => ({ name, status: "fail", detail: `${name} is down` });

async function cleanUp() {
  await testDb("alert_state").where("alert_key", "like", `readiness%${dateIso}%`).del();
}

beforeEach(async () => {
  await cleanUp();
  sentMessages.length = 0;
  state.appEnvironment = "production";
  state.openDay = true;
  state.checks = [ok("Worker"), ok("Account")];
  state.stages = [];
});

afterAll(async () => {
  await cleanUp();
  await testDb.destroy();
});

describe("runPreOpenReadinessIfDue", () => {
  it("does nothing in development and on a closed day", async () => {
    state.appEnvironment = "development";
    expect(await runPreOpenReadinessIfDue(at("11:00"))).toEqual([]);
    state.appEnvironment = "production";
    state.openDay = false;
    expect(await runPreOpenReadinessIfDue(at("11:00"))).toEqual([]);
    expect(sentMessages).toEqual([]);
  });

  it("does nothing before 6:00 ET", async () => {
    expect(await runPreOpenReadinessIfDue(at("10:59"))).toEqual([]);
    expect(sentMessages).toEqual([]);
  });

  it("sends the first pre-open verdict at 6:00 ET exactly once, even when the minute is processed twice", async () => {
    await runPreOpenReadinessIfDue(at("11:00"));
    await runPreOpenReadinessIfDue(at("11:00"));
    await runPreOpenReadinessIfDue(at("11:01"));
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("✅ Pre-open check: READY to trade");
    expect(state.stages).toEqual(["pre_open"]);
  });

  it("lets only one of two simultaneous dynos run and announce", async () => {
    await Promise.all([runPreOpenReadinessIfDue(at("11:00")), runPreOpenReadinessIfDue(at("11:00"))]);
    expect(sentMessages).toHaveLength(1);
    expect(state.stages).toHaveLength(1);
  });

  it("remembers the run and its problems, then re-checks a red result every 10 minutes", async () => {
    state.checks = [fail("Trading worker"), ok("Account")];
    await runPreOpenReadinessIfDue(at("11:00"));
    expect(sentMessages[0]).toContain("🚫 Pre-open check: NOT READY");
    expect(sentMessages[0]).toContain("❌ Trading worker: Trading worker is down");
    const saved = await loadReadinessState(dateIso);
    expect(saved.preOpenSignature).toBe("Trading worker");
    expect(saved.preOpenLastRunAtMs).not.toBeNull();

    await runPreOpenReadinessIfDue(at("11:05"));
    expect(state.stages).toHaveLength(1);
    await runPreOpenReadinessIfDue(at("11:10"));
    expect(state.stages).toHaveLength(2);
  });

  it("stays quiet when a re-check finds the same problems, speaks when the set changes and when it turns green", async () => {
    state.checks = [fail("Trading worker")];
    await runPreOpenReadinessIfDue(at("11:00"));
    await runPreOpenReadinessIfDue(at("11:10"));
    expect(sentMessages).toHaveLength(1);

    state.checks = [fail("Trading worker"), fail("Order path")];
    await runPreOpenReadinessIfDue(at("11:20"));
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain("still NOT READY");

    state.checks = [ok("Trading worker"), ok("Order path")];
    await runPreOpenReadinessIfDue(at("11:30"));
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[2]).toContain("now READY to trade");

    await runPreOpenReadinessIfDue(at("12:30"));
    expect(state.stages).toHaveLength(4);
    expect(sentMessages).toHaveLength(3);
  });

  it("sends one FINAL verdict at 9:20 ET and never repeats it", async () => {
    await runPreOpenReadinessIfDue(at("11:00"));
    await runPreOpenReadinessIfDue(at("14:20"));
    await runPreOpenReadinessIfDue(at("14:21"));
    await runPreOpenReadinessIfDue(at("14:30"));
    const finals = sentMessages.filter((message) => message.includes("FINAL pre-open check"));
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("GO");
    expect((await loadReadinessState(dateIso)).finalSent).toBe(true);
  });

  it("confirms the market open at 9:35 ET against live data, and keeps re-checking only while red", async () => {
    await runPreOpenReadinessIfDue(at("11:00"));
    await runPreOpenReadinessIfDue(at("14:20"));
    sentMessages.length = 0;
    state.stages = [];

    state.checks = [fail("Live option quote")];
    await runPreOpenReadinessIfDue(at("14:35"));
    expect(state.stages).toEqual(["open"]);
    expect(sentMessages[0]).toContain("🛑 Market-open confirmation: NOT READY");

    await runPreOpenReadinessIfDue(at("14:36"));
    expect(state.stages).toEqual(["open"]);
    await runPreOpenReadinessIfDue(at("14:37"));
    expect(state.stages).toEqual(["open", "open"]);
    expect(sentMessages).toHaveLength(1);

    state.checks = [ok("Live option quote")];
    await runPreOpenReadinessIfDue(at("14:39"));
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain("✅ Market-open confirmation: live data is flowing, GO");

    await runPreOpenReadinessIfDue(at("15:00"));
    expect(state.stages).toEqual(["open", "open", "open"]);
  });

  it("gives up for the day at 10:15 ET: nothing runs and nothing is sent", async () => {
    expect(await runPreOpenReadinessIfDue(at("15:15"))).toEqual([]);
    expect(await runPreOpenReadinessIfDue(at("18:00"))).toEqual([]);
    expect(sentMessages).toEqual([]);
    expect(state.stages).toEqual([]);
  });
});

describe("loadReadinessState and pruneOldReadinessState", () => {
  it("is empty for a day nothing ran", async () => {
    expect(await loadReadinessState(dateIso)).toEqual({ preOpenLastRunAtMs: null, preOpenSignature: null, finalSent: false, openLastRunAtMs: null, openSignature: null });
  });

  it("prunes readiness rows older than three days and keeps recent ones and other alert rows", async () => {
    const old = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    await testDb("alert_state").insert([
      { alert_key: `readiness:pre_open:${dateIso}`, first_alerted_at: old, last_alerted_at: old, last_message: "ok" },
      { alert_key: `readiness-run:pre_open:${dateIso}:1`, first_alerted_at: old, last_alerted_at: old, last_message: "readiness run" },
      { alert_key: `readiness:final:${dateIso}`, first_alerted_at: new Date(), last_alerted_at: new Date(), last_message: "ok" },
    ]);
    await pruneOldReadinessState(new Date());
    const remaining = await testDb("alert_state").where("alert_key", "like", `readiness%${dateIso}%`).pluck("alert_key");
    expect(remaining).toEqual([`readiness:final:${dateIso}`]);
  });
});
