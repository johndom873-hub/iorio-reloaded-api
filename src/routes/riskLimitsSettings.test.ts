import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real riskLimitsRouter's settings routes on a small express app against the test database. The IBKR / exposure imports the
// router carries for its other routes are mocked so nothing network-bound loads.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run risk limit settings route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computeCashLockedInCsps: vi.fn(), computePositionExposures: vi.fn(), streamPositionExposures: vi.fn() }));

const { db } = await import("../db/connection.js");
const { riskLimitsRouter } = await import("./riskLimits.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
let originalRow: Record<string, unknown>;

const knownRow = {
  max_position_pct_of_portfolio: 10,
  max_concentration_per_ticker_pct: 20,
  min_cash_reserve_pct: 5,
  delta_target_min: 0.2,
  delta_target_max: 0.3,
  recovery_dte_min: 30,
  recovery_dte_max: 45,
  min_annualized_yield_pct: 50,
  commission_warn_share_of_premium_pct: 5,
  price_check_max_deviation_pct: 10,
  price_check_min_tolerance_dollars: 0.05,
  spread_cost_charged_pct: 50,
  updated_by_user_id: null,
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

const validPayload = {
  maxPositionPctOfPortfolio: 12,
  maxConcentrationPerTickerPct: 25,
  minCashReservePct: 8,
  deltaTargetMin: 0.1,
  deltaTargetMax: 0.4,
  recoveryDteMin: 7,
  recoveryDteMax: 60,
  minAnnualizedYieldPct: 35,
  commissionWarnSharePctOfPremium: 6,
  priceCheckMaxDeviationPct: 15,
  priceCheckMinToleranceDollars: 0.1,
  spreadCostChargedPct: 40,
};

const fieldNames = Object.keys(validPayload) as (keyof typeof validPayload)[];
const percentageFieldNames = ["maxPositionPctOfPortfolio", "maxConcentrationPerTickerPct", "minCashReservePct", "minAnnualizedYieldPct", "commissionWarnSharePctOfPremium", "priceCheckMaxDeviationPct", "spreadCostChargedPct"] as const;

beforeAll(async () => {
  originalRow = await testDb("trading_settings").first();
  const [user] = await testDb("users").insert({ username: `risk-settings-${Date.now()}`, display_name: "Risk Settings Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/risk-limits", riskLimitsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await testDb("trading_settings").update(knownRow);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("trading_settings").update(originalRow);
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function call(method: "GET" | "PUT", path: string, body?: unknown, options: { asUser?: string | null; rawBody?: string } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined || options.rawBody !== undefined ? { "content-type": "application/json" } : {}), ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

const readRow = () => testDb("trading_settings").first();

describe("GET /risk-limits/settings", () => {
  it("returns the singleton as numbers, with the saver and an ISO updatedAt", async () => {
    const response = await call("GET", "/risk-limits/settings");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ...validPayloadFromRow(knownRow), updatedAt: "2026-01-01T00:00:00.000Z", updatedByDisplayName: null });
    for (const field of fieldNames) expect(typeof response.json[field]).toBe("number");
  });

  it("is an object, not a list of per-strategy rows", async () => {
    const response = await call("GET", "/risk-limits/settings");
    expect(Array.isArray(response.json)).toBe(false);
    expect(Object.keys(response.json).sort()).toEqual([...fieldNames, "updatedAt", "updatedByDisplayName"].sort());
  });

  it("is refused without a session", async () => {
    expect((await call("GET", "/risk-limits/settings", undefined, { asUser: null })).status).toBe(401);
  });
});

function validPayloadFromRow(row: typeof knownRow) {
  return {
    maxPositionPctOfPortfolio: row.max_position_pct_of_portfolio,
    maxConcentrationPerTickerPct: row.max_concentration_per_ticker_pct,
    minCashReservePct: row.min_cash_reserve_pct,
    deltaTargetMin: row.delta_target_min,
    deltaTargetMax: row.delta_target_max,
    recoveryDteMin: row.recovery_dte_min,
    recoveryDteMax: row.recovery_dte_max,
    minAnnualizedYieldPct: row.min_annualized_yield_pct,
    commissionWarnSharePctOfPremium: row.commission_warn_share_of_premium_pct,
    priceCheckMaxDeviationPct: row.price_check_max_deviation_pct,
    priceCheckMinToleranceDollars: row.price_check_min_tolerance_dollars,
    spreadCostChargedPct: row.spread_cost_charged_pct,
  };
}

describe("PUT /risk-limits/settings: a valid save", () => {
  it("persists every field, stamps the saver, and returns the saved object with the saver's display name", async () => {
    const response = await call("PUT", "/risk-limits/settings", validPayload);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ ...validPayload, updatedByDisplayName: "Risk Settings Tester" });
    expect(new Date(response.json.updatedAt).toISOString()).toBe(response.json.updatedAt);
    expect(new Date(response.json.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const row = await readRow();
    expect(Number(row.max_position_pct_of_portfolio)).toBe(12);
    expect(Number(row.max_concentration_per_ticker_pct)).toBe(25);
    expect(Number(row.min_cash_reserve_pct)).toBe(8);
    expect(Number(row.delta_target_min)).toBe(0.1);
    expect(Number(row.delta_target_max)).toBe(0.4);
    expect(row.recovery_dte_min).toBe(7);
    expect(row.recovery_dte_max).toBe(60);
    expect(Number(row.min_annualized_yield_pct)).toBe(35);
    expect(Number(row.commission_warn_share_of_premium_pct)).toBe(6);
    expect(Number(row.price_check_max_deviation_pct)).toBe(15);
    expect(Number(row.price_check_min_tolerance_dollars)).toBe(0.1);
    expect(Number(row.spread_cost_charged_pct)).toBe(40);
    expect(row.updated_by_user_id).toBe(userId);
    // And a fresh GET agrees with what the PUT returned.
    expect((await call("GET", "/risk-limits/settings")).json).toEqual(response.json);
    expect(Number((await testDb("trading_settings").count({ count: "*" }).first())!.count)).toBe(1);
  });

  it("accepts the whole GET object back (updatedAt and updatedByDisplayName are ignored), as the form sends it", async () => {
    const current = (await call("GET", "/risk-limits/settings")).json;
    const response = await call("PUT", "/risk-limits/settings", { ...current, minCashReservePct: 9 });
    expect(response.status).toBe(200);
    expect(response.json.minCashReservePct).toBe(9);
    expect(response.json.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("ignores unknown fields, including an attempt to set the saver or the row id", async () => {
    const response = await call("PUT", "/risk-limits/settings", { ...validPayload, unknownField: 5, updated_by_user_id: "00000000-0000-4000-8000-000000000000", id: false, covered_call: { x: 1 } });
    expect(response.status).toBe(200);
    expect(response.json.unknownField).toBeUndefined();
    const row = await readRow();
    expect(row.id).toBe(true);
    expect(row.updated_by_user_id).toBe(userId);
  });

  it("accepts every boundary: 0% and 100%, the full 0 to 1 delta band, min equal to max, a one-day window starting at 0", async () => {
    const boundary = {
      maxPositionPctOfPortfolio: 0,
      maxConcentrationPerTickerPct: 100,
      minCashReservePct: 0,
      deltaTargetMin: 0,
      deltaTargetMax: 1,
      recoveryDteMin: 0,
      recoveryDteMax: 0,
      minAnnualizedYieldPct: 100,
      commissionWarnSharePctOfPremium: 0,
      priceCheckMaxDeviationPct: 100,
      priceCheckMinToleranceDollars: 1000,
      spreadCostChargedPct: 0,
    };
    const response = await call("PUT", "/risk-limits/settings", boundary);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject(boundary);
    const equalBand = await call("PUT", "/risk-limits/settings", { ...validPayload, deltaTargetMin: 0.3, deltaTargetMax: 0.3 });
    expect(equalBand.status).toBe(200);
    expect(equalBand.json).toMatchObject({ deltaTargetMin: 0.3, deltaTargetMax: 0.3 });
  });

  it("two quick saves one after the other keep the last", async () => {
    await call("PUT", "/risk-limits/settings", { ...validPayload, maxPositionPctOfPortfolio: 11 });
    await call("PUT", "/risk-limits/settings", { ...validPayload, maxPositionPctOfPortfolio: 13, deltaTargetMax: 0.45 });
    const row = await readRow();
    expect(Number(row.max_position_pct_of_portfolio)).toBe(13);
    expect(Number(row.delta_target_max)).toBe(0.45);
  });

  it("two saves at the same time leave one complete payload, never a mixture of the two", async () => {
    const first = { ...validPayload, maxPositionPctOfPortfolio: 11, deltaTargetMin: 0.11, recoveryDteMax: 61, minAnnualizedYieldPct: 31 };
    const second = { ...validPayload, maxPositionPctOfPortfolio: 14, deltaTargetMin: 0.14, recoveryDteMax: 64, minAnnualizedYieldPct: 34 };
    const [firstResponse, secondResponse] = await Promise.all([call("PUT", "/risk-limits/settings", first), call("PUT", "/risk-limits/settings", second)]);
    expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
    const { updatedAt: _a, updatedByDisplayName: _b, ...stored } = (await call("GET", "/risk-limits/settings")).json;
    expect([first, second]).toContainEqual(stored);
    expect(Number((await testDb("trading_settings").count({ count: "*" }).first())!.count)).toBe(1);
  });

  it("stores more decimals than the columns hold by rounding, and returns the rounded figure", async () => {
    const response = await call("PUT", "/risk-limits/settings", { ...validPayload, minCashReservePct: 8.126, deltaTargetMin: 0.12344 });
    expect(response.status).toBe(200);
    expect(response.json.minCashReservePct).toBe(8.13);
    expect(response.json.deltaTargetMin).toBe(0.1234);
  });
});

describe("PUT /risk-limits/settings: every validation failure is a 400 with the exact message and changes nothing", () => {
  async function expectRejected(body: unknown, message: string, options: { rawBody?: string } = {}) {
    const before = await readRow();
    const response = await call("PUT", "/risk-limits/settings", body, options);
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: message });
    expect(await readRow()).toEqual(before);
  }

  for (const field of fieldNames) {
    it(`names ${field} when it is missing, a string, or null`, async () => {
      const { [field]: _omitted, ...without } = validPayload;
      await expectRejected(without, `${field} must be a number.`);
      await expectRejected({ ...validPayload, [field]: "10" }, `${field} must be a number.`);
      await expectRejected({ ...validPayload, [field]: null }, `${field} must be a number.`);
    });
  }

  it("treats a NaN sent as JSON (which arrives as null) as not a number", async () => {
    await expectRejected(undefined, "minCashReservePct must be a number.", { rawBody: JSON.stringify({ ...validPayload, minCashReservePct: Number.NaN }) });
  });

  it("an empty body, no body at all and an array are all reported as the first missing field", async () => {
    await expectRejected({}, "maxPositionPctOfPortfolio must be a number.");
    await expectRejected([], "maxPositionPctOfPortfolio must be a number.");
    const before = await readRow();
    const noBody = await fetch(`${baseUrl}/risk-limits/settings`, { method: "PUT", headers: { "x-test-user-id": userId } });
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toEqual({ error: "maxPositionPctOfPortfolio must be a number." });
    expect(await readRow()).toEqual(before);
  });

  it("rejects a percentage of 101 or -1 for each of the six percentage fields", async () => {
    for (const field of percentageFieldNames) {
      await expectRejected({ ...validPayload, [field]: 101 }, `${field} must be between 0 and 100.`);
      await expectRejected({ ...validPayload, [field]: -1 }, `${field} must be between 0 and 100.`);
      await expectRejected({ ...validPayload, [field]: 100.01 }, `${field} must be between 0 and 100.`);
      await expectRejected({ ...validPayload, [field]: -0.01 }, `${field} must be between 0 and 100.`);
    }
  });

  it("rejects a limit-price dollar floor below 0 or above 1000", async () => {
    await expectRejected({ ...validPayload, priceCheckMinToleranceDollars: -0.01 }, "priceCheckMinToleranceDollars must be between 0 and 1000.");
    await expectRejected({ ...validPayload, priceCheckMinToleranceDollars: 1000.01 }, "priceCheckMinToleranceDollars must be between 0 and 1000.");
  });

  it("rejects a number too large for a double (it parses to Infinity) as not a number", async () => {
    const rawBody = JSON.stringify(validPayload).replace('"maxPositionPctOfPortfolio":12', '"maxPositionPctOfPortfolio":1e999');
    expect(rawBody).toContain("1e999");
    await expectRejected(undefined, "maxPositionPctOfPortfolio must be a number.", { rawBody });
  });

  it("rejects a delta min above the delta max", async () => {
    await expectRejected({ ...validPayload, deltaTargetMin: 0.5, deltaTargetMax: 0.4 }, "deltaTargetMin cannot exceed deltaTargetMax.");
    await expectRejected({ ...validPayload, deltaTargetMin: 0.3001, deltaTargetMax: 0.3 }, "deltaTargetMin cannot exceed deltaTargetMax.");
  });

  it("rejects a delta max of 1.01 and a negative delta min with the band-range message", async () => {
    await expectRejected({ ...validPayload, deltaTargetMax: 1.01 }, "The delta band must be between 0 and 1.");
    await expectRejected({ ...validPayload, deltaTargetMin: -0.01 }, "The delta band must be between 0 and 1.");
  });

  it("rejects a fractional DTE, a negative DTE min, and an inverted DTE window", async () => {
    await expectRejected({ ...validPayload, recoveryDteMin: 7.5 }, "The Recovery Path DTE window must be whole days.");
    await expectRejected({ ...validPayload, recoveryDteMax: 60.1 }, "The Recovery Path DTE window must be whole days.");
    await expectRejected({ ...validPayload, recoveryDteMin: -1 }, "recoveryDteMin cannot be negative.");
    await expectRejected({ ...validPayload, recoveryDteMin: 61, recoveryDteMax: 60 }, "recoveryDteMin cannot exceed recoveryDteMax.");
  });

  // The column is a 32-bit integer: a larger whole number must be refused with a message, not by the database as a server error.
  it("a DTE window larger than the 32-bit integer column is a 400 with a message, not a 500", async () => {
    const response = await call("PUT", "/risk-limits/settings", { ...validPayload, recoveryDteMax: 3_000_000_000 });
    expect(response.status).toBe(400);
  });

  it("a rejected save does not stamp the saver or move updatedAt", async () => {
    await call("PUT", "/risk-limits/settings", { ...validPayload, deltaTargetMax: 1.5 });
    const row = await readRow();
    expect(row.updated_by_user_id).toBeNull();
    expect((row.updated_at as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is refused without a session and changes nothing", async () => {
    const before = await readRow();
    expect((await call("PUT", "/risk-limits/settings", validPayload, { asUser: null })).status).toBe(401);
    expect(await readRow()).toEqual(before);
  });
});

describe("the old settings routes are gone", () => {
  it("has no per-strategy settings route", async () => {
    expect((await call("PUT", "/risk-limits/settings/covered_call", validPayload)).status).toBe(404);
    expect((await call("PUT", "/risk-limits/settings/cash_secured_put", validPayload)).status).toBe(404);
    expect((await call("GET", "/risk-limits/settings/covered_call")).status).toBe(404);
  });

  it("the old per-strategy body shape ({covered_call, cash_secured_put}) is not accepted on the single route", async () => {
    const before = await readRow();
    const response = await call("PUT", "/risk-limits/settings", { covered_call: { delta_target_min: 0.2 }, cash_secured_put: { delta_target_min: 0.2 } });
    expect(response.status).toBe(400);
    expect(await readRow()).toEqual(before);
  });

  it("app.ts no longer mounts /signal-settings, and the old modules are deleted", () => {
    const appSource = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(appSource).not.toContain("signal-settings");
    expect(appSource).not.toContain("signalSettingsRouter");
    expect(appSource).toContain('app.use("/order-checks", orderChecksRouter)');
    for (const removed of ["../routes/signalSettings.ts", "../lib/signalSettingsStore.ts", "../lib/strategySettings.ts", "../lib/signalOrderLimits.ts"]) {
      expect(existsSync(new URL(removed, import.meta.url)), removed).toBe(false);
    }
  });
});
