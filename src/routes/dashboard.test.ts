import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Knex } from "knex";

// The real dashboardRouter on a small express app, against a private copy of the test database's tables (the account cards read
// global tables and CURRENT_DATE windows, so they need exact table contents). The IBKR / exposure boundaries are mocked, the
// strategy-attribution engine delegates to the real one unless a test overrides it.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
const fetchAccountSummaryMock = vi.fn();
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: (...args: unknown[]) => fetchAccountSummaryMock(...args) }));
const computeCashLockedInCspsMock = vi.fn();
const computePositionExposuresMock = vi.fn();
const streamPositionExposuresMock = vi.fn();
vi.mock("../lib/positionExposure.js", () => ({
  computeCashLockedInCsps: (...args: unknown[]) => computeCashLockedInCspsMock(...args),
  computePositionExposures: (...args: unknown[]) => computePositionExposuresMock(...args),
  streamPositionExposures: (...args: unknown[]) => streamPositionExposuresMock(...args),
}));
const computeStrategyDailyPnlSeriesMock = vi.fn();
vi.mock("../lib/strategyPeriodPnl.js", () => ({ computeStrategyDailyPnlSeries: (...args: unknown[]) => computeStrategyDailyPnlSeriesMock(...args) }));
const fetchPositionEventsMock = vi.fn();
vi.mock("../lib/positionEvents.js", () => ({ fetchPositionEvents: (...args: unknown[]) => fetchPositionEventsMock(...args) }));
const computeCyclePeriodPnlMock = vi.fn();
vi.mock("../lib/cyclePeriodPnl.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/cyclePeriodPnl.js")>("../lib/cyclePeriodPnl.js");
  computeCyclePeriodPnlMock.mockImplementation(actual.computeCyclePeriodPnl);
  return { ...actual, computeCyclePeriodPnl: (...args: unknown[]) => computeCyclePeriodPnlMock(...args) };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { dashboardRouter } = await import("./dashboard.js");
const actualCyclePeriodPnl = await vi.importActual<typeof import("../lib/cyclePeriodPnl.js")>("../lib/cyclePeriodPnl.js");

const testDb: Knex = db;
const millisecondsPerDay = 86_400_000;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.stubEnv("PASSKEY_LOGIN", "off");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/dashboard", dashboardRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await dropIsolatedTestDatabase(testDb);
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  for (const mock of [fetchAccountSummaryMock, computeCashLockedInCspsMock, computePositionExposuresMock, streamPositionExposuresMock, computeStrategyDailyPnlSeriesMock, fetchPositionEventsMock]) mock.mockReset();
  computeCyclePeriodPnlMock.mockReset();
  computeCyclePeriodPnlMock.mockImplementation(actualCyclePeriodPnl.computeCyclePeriodPnl);
  await testDb("account_pnl_snapshots").del();
  await testDb("market_calendar").del();
});

async function get(path: string, options: { authenticated?: boolean } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers: options.authenticated === false ? {} : { "x-test-user-id": "test-user" } });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (error pages, event streams)
  }
  return { status: response.status, json, text, headers: response.headers };
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * millisecondsPerDay).toISOString().slice(0, 10);
}

function isoWeekday(isoDate: string): number {
  return ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

async function databaseToday(): Promise<string> {
  return (await testDb.raw("SELECT CURRENT_DATE::text AS today")).rows[0].today;
}

interface SnapshotInput {
  snapshot_date: string;
  daily_pnl?: number | null;
  unrealized_pnl?: number | null;
  net_liquidation_value?: number | null;
  net_cash_flow?: number | null;
}

async function insertSnapshots(rows: SnapshotInput[]): Promise<void> {
  await testDb("account_pnl_snapshots").insert(rows);
}

// The money columns are numeric(_, 4), so pg returns them as text with four decimals ("250.5000").
// Dates in 2020 sit outside every CURRENT_DATE window (week / month / year), so only the Day card sees them.
const outsideWindowsDates = { friday: "2020-03-13", monday: "2020-03-16", tuesday: "2020-03-17" };

describe("authentication", () => {
  it.each([
    "/dashboard/summary",
    "/dashboard/performance",
    "/dashboard/account-value",
    "/dashboard/available-cash",
    "/dashboard/portfolio",
    "/dashboard/portfolio/stream",
    "/dashboard/period-pnl-by-strategy",
    "/dashboard/events",
    "/dashboard/history",
  ])("refuses %s without a session", async (path) => {
    const response = await get(path, { authenticated: false });
    expect(response.status).toBe(401);
    expect(response.json).toEqual({ error: "Not logged in." });
  });
});

describe("GET /dashboard/account-value", () => {
  it("answers nulls while no snapshot exists", async () => {
    expect((await get("/dashboard/account-value")).json).toEqual({ netLiquidationValue: null, asOf: null });
  });

  it("reads the latest snapshot's net liquidation value (numeric text) and date", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, net_liquidation_value: 90000 },
      { snapshot_date: outsideWindowsDates.tuesday, net_liquidation_value: 91234.56 },
    ]);
    const response = await get("/dashboard/account-value");
    expect(response.status).toBe(200);
    expect(response.json.netLiquidationValue).toBe("91234.5600");
    expect(new Date(response.json.asOf).getTime()).toBe(new Date(2020, 2, 17).getTime());
  });

  it("passes a null net liquidation value on the latest row through as null", async () => {
    await insertSnapshots([{ snapshot_date: outsideWindowsDates.tuesday, net_liquidation_value: null }]);
    expect((await get("/dashboard/account-value")).json.netLiquidationValue).toBeNull();
  });
});

describe("GET /dashboard/available-cash", () => {
  it("is total cash minus the cash locked in cash-secured puts", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 50_000, netLiquidationValue: 120_000 });
    computeCashLockedInCspsMock.mockResolvedValue(30_000);
    expect((await get("/dashboard/available-cash")).json).toEqual({ totalCashValue: 50_000, cashLockedInCsps: 30_000, availableCashToTrade: 20_000, netLiquidationValue: 120_000 });
  });

  it("can go negative when more cash is locked than the account holds", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 10_000, netLiquidationValue: 1 });
    computeCashLockedInCspsMock.mockResolvedValue(25_000);
    expect((await get("/dashboard/available-cash")).json.availableCashToTrade).toBe(-15_000);
  });

  it("answers null available cash (not NaN) when IBKR reports no cash value, and null net liquidation when absent", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: null });
    computeCashLockedInCspsMock.mockResolvedValue(30_000);
    expect((await get("/dashboard/available-cash")).json).toEqual({ totalCashValue: null, cashLockedInCsps: 30_000, availableCashToTrade: null, netLiquidationValue: null });
  });

  it("answers 500 when the live account lookup fails (no fallback on this route)", async () => {
    fetchAccountSummaryMock.mockRejectedValue(new Error("gateway down"));
    computeCashLockedInCspsMock.mockResolvedValue(0);
    expect((await get("/dashboard/available-cash")).status).toBe(500);
  });
});

describe("GET /dashboard/portfolio", () => {
  const exposures = [
    { strategyKey: "covered_call", exposure: 1000 },
    { strategyKey: "covered_call", exposure: 500.5 },
    { strategyKey: "cash_secured_put", exposure: 2000 },
    { strategyKey: "unstructured", exposure: 25 },
    { strategyKey: "hedge", exposure: 10 },
    { strategyKey: "something_else", exposure: 999_999 },
  ];

  it("sums exposure per known strategy, ignores unknown strategies, and subtracts cash locked in CSPs from cash", async () => {
    computePositionExposuresMock.mockResolvedValue(exposures);
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 8000 });
    computeCashLockedInCspsMock.mockResolvedValue(2000);
    expect((await get("/dashboard/portfolio")).json).toEqual({ coveredCalls: 1500.5, cashSecuredPuts: 2000, unstructured: 25, hedge: 10, availableCash: 6000 });
  });

  it("answers zeros for an empty book", async () => {
    computePositionExposuresMock.mockResolvedValue([]);
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 100 });
    computeCashLockedInCspsMock.mockResolvedValue(0);
    expect((await get("/dashboard/portfolio")).json).toEqual({ coveredCalls: 0, cashSecuredPuts: 0, unstructured: 0, hedge: 0, availableCash: 100 });
  });

  it("still answers (available cash null) when the account lookup fails", async () => {
    computePositionExposuresMock.mockResolvedValue(exposures);
    fetchAccountSummaryMock.mockRejectedValue(new Error("gateway down"));
    computeCashLockedInCspsMock.mockResolvedValue(2000);
    const response = await get("/dashboard/portfolio");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ coveredCalls: 1500.5, availableCash: null });
  });
});

describe("GET /dashboard/portfolio/stream", () => {
  it("sends event-stream headers, streams a frame per exposure update with the available cash computed once up front, then ends", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 8000 });
    computeCashLockedInCspsMock.mockResolvedValue(2000);
    streamPositionExposuresMock.mockImplementation(async (onUpdate: (rows: unknown[]) => void) => {
      onUpdate([{ strategyKey: "covered_call", exposure: 100 }, { strategyKey: "hedge", exposure: 5 }]);
      onUpdate([{ strategyKey: "cash_secured_put", exposure: 300 }, { strategyKey: "bogus", exposure: 1 }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const response = await get("/dashboard/portfolio/stream");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const frames = response.text.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)));
    expect(frames).toEqual([
      { coveredCalls: 100, cashSecuredPuts: 0, unstructured: 0, hedge: 5, availableCash: 6000 },
      { coveredCalls: 0, cashSecuredPuts: 300, unstructured: 0, hedge: 0, availableCash: 6000 },
    ]);
  });

  it("streams available cash as null when the account lookup fails", async () => {
    fetchAccountSummaryMock.mockRejectedValue(new Error("gateway down"));
    computeCashLockedInCspsMock.mockResolvedValue(2000);
    streamPositionExposuresMock.mockImplementation(async (onUpdate: (rows: unknown[]) => void) => onUpdate([]));
    const response = await get("/dashboard/portfolio/stream");
    expect(response.text).toContain('"availableCash":null');
  });

  it("ends the response quietly when the exposure producer fails", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 1 });
    computeCashLockedInCspsMock.mockResolvedValue(0);
    streamPositionExposuresMock.mockRejectedValue(new Error("producer failed"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await get("/dashboard/portfolio/stream");
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(consoleErrorSpy).toHaveBeenCalledWith("dashboard/portfolio/stream: streamPositionExposures failed", expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it("aborts the producer's signal when the client disconnects", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ totalCashValue: 1 });
    computeCashLockedInCspsMock.mockResolvedValue(0);
    let producerSignal: AbortSignal | undefined;
    streamPositionExposuresMock.mockImplementation(async (_onUpdate: unknown, signal: AbortSignal) => {
      producerSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    const abortController = new AbortController();
    const responsePromise = fetch(`${baseUrl}/dashboard/portfolio/stream`, { headers: { "x-test-user-id": "test-user" }, signal: abortController.signal });
    await vi.waitFor(() => expect(producerSignal).toBeDefined());
    expect(producerSignal!.aborted).toBe(false);
    abortController.abort();
    await responsePromise.catch(() => {});
    await vi.waitFor(() => expect(producerSignal!.aborted).toBe(true));
  });
});

describe("GET /dashboard/events", () => {
  it("passes the position events feed through, defaulting the limit to 40", async () => {
    fetchPositionEventsMock.mockResolvedValue([{ id: "e1" }]);
    const response = await get("/dashboard/events");
    expect(response.json).toEqual([{ id: "e1" }]);
    expect(fetchPositionEventsMock).toHaveBeenCalledWith(40);
  });

  it.each([
    ["25", 25],
    ["500", 200],
    ["200", 200],
    ["abc", 40],
    ["0", 40],
    ["", 40],
    ["-3", 1],
    ["1", 1],
  ])("limit=%s is passed to the feed as %d", async (limit, expectedLimit) => {
    fetchPositionEventsMock.mockResolvedValue([]);
    await get(`/dashboard/events?limit=${limit}`);
    expect(fetchPositionEventsMock).toHaveBeenCalledWith(expectedLimit);
  });
});

describe("GET /dashboard/performance", () => {
  it("answers an all-null summary with no snapshots", async () => {
    expect((await get("/dashboard/performance")).json).toEqual({
      trackingSince: null,
      asOf: null,
      trackingSpanDays: null,
      monthToDate: null,
      months: [],
      years: [],
      sinceInceptionPercent: null,
      compoundAnnualGrowthRatePercent: null,
    });
  });

  it("chains the daily returns with deposits removed: 100000 -> 101000 -> 111000 after a 5000 deposit is +6.000%", async () => {
    await insertSnapshots([
      { snapshot_date: "2020-03-02", net_liquidation_value: 100000, net_cash_flow: null },
      { snapshot_date: "2020-03-03", net_liquidation_value: 101000, net_cash_flow: 0 },
      { snapshot_date: "2020-03-04", net_liquidation_value: 111000, net_cash_flow: 5000 },
    ]);
    const { json } = await get("/dashboard/performance");
    // Day 2: 1000 / 100000 = 1%. Day 3: (111000 - 101000 - 5000) / 101000 = 4.95%. Chained: 1.01 x 1.0495 = 1.06.
    expect(json.trackingSince).toBe("2020-03-02");
    expect(json.asOf).toBe("2020-03-04");
    expect(json.trackingSpanDays).toBe(2);
    expect(json.sinceInceptionPercent).toBeCloseTo(6, 9);
    expect(json.years).toHaveLength(1);
    expect(json.years[0]).toMatchObject({ year: 2020 });
    expect(json.years[0].percent).toBeCloseTo(6, 9);
    expect(json.years[0].profitDollars).toBeCloseTo(6000, 9);
    expect(json.months).toHaveLength(1);
    expect(json.months[0]).toMatchObject({ year: 2020, month: 3 });
    expect(json.monthToDate).toBeNull();
  });

  it("skips a snapshot without net liquidation value and carries its cash flow into the next usable day", async () => {
    await insertSnapshots([
      { snapshot_date: "2020-03-02", net_liquidation_value: 100000 },
      { snapshot_date: "2020-03-03", net_liquidation_value: null, net_cash_flow: 4000 },
      { snapshot_date: "2020-03-04", net_liquidation_value: 106000, net_cash_flow: 1000 },
    ]);
    const { json } = await get("/dashboard/performance");
    // Profit = 106000 - 100000 - (4000 + 1000) = 1000 over a 100000 base.
    expect(json.sinceInceptionPercent).toBeCloseTo(1, 9);
    expect(json.years[0].profitDollars).toBeCloseTo(1000, 9);
  });
});

describe("GET /dashboard/summary and /dashboard/period-pnl-by-strategy: the account Day card", () => {
  async function dayFromSummary(): Promise<unknown> {
    return (await get("/dashboard/summary")).json.periods.day;
  }

  it("shows the latest snapshot's daily P&L when the snapshot before it is the previous open session", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 10, net_liquidation_value: 100000 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 250.5, net_liquidation_value: 100250.5 },
    ]);
    expect(await dayFromSummary()).toBe("250.5000");
    expect((await get("/dashboard/period-pnl-by-strategy")).json.total.day).toBe(250.5);
  });

  it("skips the weekend: a Monday snapshot after a Friday one is a one-session figure", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.friday, daily_pnl: 10, net_liquidation_value: 100000 },
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: -75, net_liquidation_value: 99925 },
    ]);
    expect(await dayFromSummary()).toBe("-75.0000");
  });

  it("shows nothing after a missed night (previous snapshot is two sessions back), though the sums still count it", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.friday, daily_pnl: 10, net_liquidation_value: 100000 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 300, net_liquidation_value: 100300 },
    ]);
    const response = await get("/dashboard/summary");
    expect(response.json.periods.day).toBeNull();
    expect(response.json.dayPnlPercent).toBeNull();
    expect((await get("/dashboard/period-pnl-by-strategy")).json.total.day).toBe(0);
  });

  it("shows nothing when the latest snapshot has no daily P&L", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 10 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: null },
    ]);
    expect(await dayFromSummary()).toBeNull();
  });

  it("shows nothing with a single snapshot (no previous row to prove the gap)", async () => {
    await insertSnapshots([{ snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 300 }]);
    expect(await dayFromSummary()).toBeNull();
  });

  it("treats a market holiday in market_calendar as no session: the snapshot before it is the previous open session", async () => {
    await testDb("market_calendar").insert({ calendar_date: outsideWindowsDates.monday, is_open: false });
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.friday, daily_pnl: 10 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 300 },
    ]);
    expect(await dayFromSummary()).toBe("300.0000");
  });

  it("does not treat a weekday snapshot as consecutive when the calendar says the day between was open", async () => {
    await testDb("market_calendar").insert({ calendar_date: outsideWindowsDates.monday, is_open: true });
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.friday, daily_pnl: 10 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 300 },
    ]);
    expect(await dayFromSummary()).toBeNull();
  });
});

describe("GET /dashboard/summary", () => {
  it("answers an empty account: nulls for the snapshot figures, zero YTD figures, and one zero row per strategy", async () => {
    const response = await get("/dashboard/summary");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      asOf: null,
      netLiquidationValue: null,
      accountRealizedYtd: 0,
      accountUnrealizedYtd: 0,
      dayPnlPercent: null,
      periods: { day: null, week: null, month: null, year: null },
      strategyBreakdown: [
        { strategyKey: "covered_call", realizedPnl: 0, unrealizedPnl: 0 },
        { strategyKey: "cash_secured_put", realizedPnl: 0, unrealizedPnl: 0 },
        { strategyKey: "unstructured", realizedPnl: 0, unrealizedPnl: 0 },
        { strategyKey: "hedge", realizedPnl: 0, unrealizedPnl: 0 },
      ],
    });
  });

  it("day % is the day's P&L over the PRIOR day's net liquidation value (today's minus today's delta)", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 0, net_liquidation_value: 10000 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 250, net_liquidation_value: 10250 },
    ]);
    // 250 / (10250 - 250) = 2.5%
    expect((await get("/dashboard/summary")).json.dayPnlPercent).toBe(2.5);
  });

  it("a losing day: -250 on 9750 net liquidation is -250 / 10000 = -2.5%", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 0, net_liquidation_value: 10000 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: -250, net_liquidation_value: 9750 },
    ]);
    expect((await get("/dashboard/summary")).json.dayPnlPercent).toBe(-2.5);
  });

  it("day % is null (no division by zero) when the prior day's net liquidation value would be zero", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 0, net_liquidation_value: 0 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 250, net_liquidation_value: 250 },
    ]);
    expect((await get("/dashboard/summary")).json.dayPnlPercent).toBeNull();
  });

  it("day % is null when the latest snapshot has no net liquidation value", async () => {
    await insertSnapshots([
      { snapshot_date: outsideWindowsDates.monday, daily_pnl: 0, net_liquidation_value: 10000 },
      { snapshot_date: outsideWindowsDates.tuesday, daily_pnl: 250, net_liquidation_value: null },
    ]);
    expect((await get("/dashboard/summary")).json.dayPnlPercent).toBeNull();
  });

  it("week / month / year sums include exactly the snapshots on or after this Monday / the 1st / Jan 1, and the as-of fields come from the latest row", async () => {
    const today = await databaseToday();
    const weekStart = addDays(today, -(isoWeekday(today) - 1));
    const monthStart = `${today.slice(0, 7)}-01`;
    const yearStart = `${today.slice(0, 4)}-01-01`;
    // Four rows, each placed one day before a window starts (and today's row inside all of them).
    const rows = [
      { snapshot_date: addDays(yearStart, -1), daily_pnl: 1 },
      { snapshot_date: addDays(monthStart, -1), daily_pnl: 10 },
      { snapshot_date: addDays(weekStart, -1), daily_pnl: 100 },
      { snapshot_date: today, daily_pnl: 1000, net_liquidation_value: 50000 },
    ];
    await insertSnapshots(rows);
    const sumFrom = (windowStart: string) => rows.filter((row) => row.snapshot_date >= windowStart).reduce((sum, row) => sum + row.daily_pnl, 0);

    const { json } = await get("/dashboard/summary");

    expect(Number(json.periods.week)).toBe(sumFrom(weekStart));
    expect(Number(json.periods.month)).toBe(sumFrom(monthStart));
    expect(Number(json.periods.year)).toBe(sumFrom(yearStart));
    expect(json.netLiquidationValue).toBe("50000.0000");
    expect(new Date(json.asOf).getTime()).toBe(new Date(`${today}T00:00:00`).getTime());
    // Today's own row is always in the week, the month and the year.
    expect(Number(json.periods.week)).toBeGreaterThanOrEqual(1000);
  });

  it("account YTD unrealized is the latest unrealized minus the last snapshot before Jan 1; realized is the plug so that realized + unrealized = year", async () => {
    const today = await databaseToday();
    const yearStart = `${today.slice(0, 4)}-01-01`;
    await insertSnapshots([
      { snapshot_date: addDays(yearStart, -10), daily_pnl: 77, unrealized_pnl: 1000 },
      { snapshot_date: addDays(yearStart, -1), daily_pnl: 77, unrealized_pnl: 3000 },
      { snapshot_date: today, daily_pnl: 500, unrealized_pnl: 5000, net_liquidation_value: 60000 },
    ]);
    const { json } = await get("/dashboard/summary");
    // Unrealized YTD = 5000 - 3000 (the LAST row before Jan 1, not the earlier one) = 2000; the year's snapshot P&L is 500 only
    // when today is the sole row of the year, which it is here, so realized = 500 - 2000 = -1500.
    expect(json.accountUnrealizedYtd).toBe(2000);
    expect(Number(json.periods.year)).toBe(500);
    expect(json.accountRealizedYtd).toBe(-1500);
  });

  it("with no snapshot before Jan 1 the YTD unrealized baseline is zero", async () => {
    const today = await databaseToday();
    await insertSnapshots([{ snapshot_date: today, daily_pnl: 500, unrealized_pnl: 5000 }]);
    const { json } = await get("/dashboard/summary");
    expect(json.accountUnrealizedYtd).toBe(5000);
    expect(json.accountRealizedYtd).toBe(-4500);
  });

  it("with a null latest unrealized figure it counts as zero", async () => {
    const today = await databaseToday();
    await insertSnapshots([{ snapshot_date: today, daily_pnl: 500, unrealized_pnl: null }]);
    const { json } = await get("/dashboard/summary");
    expect(json.accountUnrealizedYtd).toBe(0);
    expect(json.accountRealizedYtd).toBe(500);
  });

  it("maps the cycle buckets onto the strategy rows (covered call = cc, cash-secured put = csp) with their YTD realized and unrealized", async () => {
    const bucket = (realizedYear: number, unrealizedYear: number) => ({ day: 0, week: 0, month: 0, year: realizedYear + unrealizedYear, realizedYear, unrealizedYear });
    computeCyclePeriodPnlMock.mockResolvedValue({
      buckets: { cc: bucket(1, 2), csp: bucket(3, 4), unstructured: bucket(5, 6), hedge: bucket(7, 8) },
      excludedByPeriod: { day: [], week: [], month: [], year: [] },
    });
    expect((await get("/dashboard/summary")).json.strategyBreakdown).toEqual([
      { strategyKey: "covered_call", realizedPnl: 1, unrealizedPnl: 2 },
      { strategyKey: "cash_secured_put", realizedPnl: 3, unrealizedPnl: 4 },
      { strategyKey: "unstructured", realizedPnl: 5, unrealizedPnl: 6 },
      { strategyKey: "hedge", realizedPnl: 7, unrealizedPnl: 8 },
    ]);
  });
});

describe("GET /dashboard/period-pnl-by-strategy", () => {
  it("answers all zeros with no snapshots and no ledger", async () => {
    const zeros = { day: 0, week: 0, month: 0, year: 0 };
    expect((await get("/dashboard/period-pnl-by-strategy")).json).toEqual({
      coveredCalls: zeros,
      cashSecuredPuts: zeros,
      unstructured: zeros,
      hedge: zeros,
      residual: zeros,
      total: zeros,
    });
  });

  it("residual = account total - the four strategy buckets, per period; total is the account total", async () => {
    const period = (day: number, week: number, month: number, year: number) => ({ day, week, month, year, realizedYear: 0, unrealizedYear: 0 });
    computeCyclePeriodPnlMock.mockResolvedValue({
      buckets: { csp: period(10, 20, 30, 40), cc: period(1, 2, 3, 4), unstructured: period(5, 6, 7, 8), hedge: period(100, 200, 300, 400) },
      excludedByPeriod: { day: [], week: [], month: [], year: [] },
    });
    // The Day card needs two consecutive sessions; today's row is in the week, month and year windows.
    const today = await databaseToday();
    const weekday = isoWeekday(today);
    const previousSession = addDays(today, weekday === 1 ? -3 : weekday === 7 ? -2 : -1);
    await insertSnapshots([
      { snapshot_date: previousSession, daily_pnl: 0 },
      { snapshot_date: today, daily_pnl: 1000 },
    ]);

    const { json } = await get("/dashboard/period-pnl-by-strategy");

    expect(json.coveredCalls).toEqual({ day: 1, week: 2, month: 3, year: 4 });
    expect(json.cashSecuredPuts).toEqual({ day: 10, week: 20, month: 30, year: 40 });
    expect(json.unstructured).toEqual({ day: 5, week: 6, month: 7, year: 8 });
    expect(json.hedge).toEqual({ day: 100, week: 200, month: 300, year: 400 });
    // Account: day 1000 (previous row is the previous session), week/month/year contain today's 1000 (the previous row's daily P&L is 0).
    expect(json.total).toEqual({ day: 1000, week: 1000, month: 1000, year: 1000 });
    // Buckets add up to 116 / 228 / 340 / 452.
    expect(json.residual).toEqual({ day: 1000 - 116, week: 1000 - 228, month: 1000 - 340, year: 1000 - 452 });
  });

  it("a negative residual (buckets exceed the account total) is reported as is", async () => {
    const period = (value: number) => ({ day: value, week: value, month: value, year: value, realizedYear: 0, unrealizedYear: 0 });
    computeCyclePeriodPnlMock.mockResolvedValue({
      buckets: { csp: period(50), cc: period(0), unstructured: period(0), hedge: period(0) },
      excludedByPeriod: { day: [], week: [], month: [], year: [] },
    });
    const today = await databaseToday();
    await insertSnapshots([{ snapshot_date: today, daily_pnl: 20 }]);
    expect((await get("/dashboard/period-pnl-by-strategy")).json.residual).toMatchObject({ week: -30, month: -30, year: -30 });
  });

  it("end to end on real ledger rows: a CSP open since last year lands in the CSP row, the rest of the account total is residual", async () => {
    const today = await databaseToday();
    const weekday = isoWeekday(today);
    const previousSession = addDays(today, weekday === 1 ? -3 : weekday === 7 ? -2 : -1);
    await insertSnapshots([
      { snapshot_date: previousSession, daily_pnl: 0 },
      { snapshot_date: today, daily_pnl: 1000 },
    ]);
    const baselines = (await actualCyclePeriodPnl.loadBaselineDates())!;
    expect(baselines.day).toBe(previousSession);

    const [ticker] = await testDb("tickers").insert({ symbol: "DASHE2E", company_name: "Dashboard End To End" }).returning("id");
    const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "open" }).returning("id");
    await testDb("position_legs").insert({
      position_id: position.id,
      leg_type: "option",
      side: "short",
      quantity: 1,
      option_type: "put",
      strike_price: 100,
      expiry_date: "2099-01-15",
      multiplier: 100,
      entry_price: 2,
      entry_at: new Date(`${addDays(baselines.year, -20)}T15:00:00Z`),
    });
    // Premium P&L of the short put on each baseline day, and now: it gained 1 per day since each baseline.
    const markNow = 400;
    for (const baselineDate of new Set(Object.values(baselines))) {
      const daysAgo = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${baselineDate}T00:00:00Z`)) / millisecondsPerDay);
      await testDb("position_pnl_snapshots").insert({ position_id: position.id, snapshot_date: baselineDate, premium_pnl: markNow - daysAgo, unrealized_pnl: markNow - daysAgo });
    }
    await testDb("position_pnl_snapshots").insert({ position_id: position.id, snapshot_date: today, premium_pnl: markNow, unrealized_pnl: markNow });

    const { json } = await get("/dashboard/period-pnl-by-strategy");

    const daysSince = (baselineDate: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${baselineDate}T00:00:00Z`)) / millisecondsPerDay);
    expect(json.cashSecuredPuts.day).toBe(daysSince(baselines.day));
    expect(json.cashSecuredPuts.week).toBe(daysSince(baselines.week));
    expect(json.cashSecuredPuts.month).toBe(daysSince(baselines.month));
    expect(json.cashSecuredPuts.year).toBe(daysSince(baselines.year));
    // The open leg's own credit never leaves the mark: with the leg open before every baseline, nothing is realized.
    expect(json.residual.day).toBe(1000 - daysSince(baselines.day));
    expect(json.coveredCalls).toEqual({ day: 0, week: 0, month: 0, year: 0 });

    // The same rows feed the YTD card: all of the CSP's YTD gain is unrealized.
    const summary = (await get("/dashboard/summary")).json;
    expect(summary.strategyBreakdown[1]).toEqual({ strategyKey: "cash_secured_put", realizedPnl: 0, unrealizedPnl: daysSince(baselines.year) });

    await testDb("position_pnl_snapshots").where({ position_id: position.id }).del();
    await testDb("position_legs").where({ position_id: position.id }).del();
    await testDb("positions").where({ id: position.id }).del();
    await testDb("tickers").where({ id: ticker.id }).del();
  });
});

describe("GET /dashboard/history", () => {
  const dateAt = (day: number) => new Date(2020, 2, day);

  beforeEach(() => {
    computeStrategyDailyPnlSeriesMock.mockResolvedValue([]);
  });

  it("answers an empty list with no snapshots, asking the strategy series for 90 days by default", async () => {
    const response = await get("/dashboard/history");
    expect(response.json).toEqual([]);
    expect(computeStrategyDailyPnlSeriesMock).toHaveBeenCalledWith(90);
  });

  it.each([
    ["30", 30],
    ["365", 365],
    ["1000", 365],
    ["abc", 90],
    ["0", 90],
  ])("days=%s asks the series for %d days", async (days, expectedDays) => {
    await get(`/dashboard/history?days=${days}`);
    expect(computeStrategyDailyPnlSeriesMock).toHaveBeenCalledWith(expectedDays);
  });

  it("returns the latest N snapshots oldest-first, each with its strategy split and the residual plug", async () => {
    await insertSnapshots([
      { snapshot_date: "2020-03-13", daily_pnl: 1, net_liquidation_value: 1000 },
      { snapshot_date: "2020-03-16", daily_pnl: 100, net_liquidation_value: 1100 },
      { snapshot_date: "2020-03-17", daily_pnl: 50, net_liquidation_value: 1150 },
      { snapshot_date: "2020-03-18", daily_pnl: null, net_liquidation_value: null },
    ]);
    computeStrategyDailyPnlSeriesMock.mockResolvedValue([
      { snapshotDate: dateAt(16), strategyKey: "covered_call", dailyPnl: 30 },
      { snapshotDate: dateAt(16), strategyKey: "cash_secured_put", dailyPnl: 20 },
      { snapshotDate: dateAt(16), strategyKey: "unstructured", dailyPnl: 5 },
      { snapshotDate: dateAt(16), strategyKey: "hedge", dailyPnl: -10 },
      { snapshotDate: dateAt(18), strategyKey: "covered_call", dailyPnl: 7 },
    ]);

    const response = await get("/dashboard/history?days=3");

    expect(response.json).toHaveLength(3);
    expect(response.json.map((row: { dailyPnl: string | null }) => row.dailyPnl)).toEqual(["100.0000", "50.0000", null]);
    // 16 March: 100 - 30 - 20 - 5 - (-10) = 55
    expect(response.json[0]).toMatchObject({ netLiquidationValue: "1100.0000", coveredCalls: 30, cashSecuredPuts: 20, unstructured: 5, hedge: -10, residual: 55 });
    // 17 March: no strategy data that day: everything is residual
    expect(response.json[1]).toMatchObject({ coveredCalls: 0, cashSecuredPuts: 0, unstructured: 0, hedge: 0, residual: 50 });
    // 18 March: no daily P&L: residual is null, strategy data still shown
    expect(response.json[2]).toMatchObject({ coveredCalls: 7, residual: null, netLiquidationValue: null });
  });

  it("a negative days value is raised to one day instead of reaching the database as a negative LIMIT", async () => {
    const response = await get("/dashboard/history?days=-5");
    expect(response.status).toBe(200);
  });
});
