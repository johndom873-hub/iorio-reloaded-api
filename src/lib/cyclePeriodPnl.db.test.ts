import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { CycleInput, CycleOptionLeg, CycleBucket } from "./cycles.js";
import type { CyclePeriod } from "./cyclePeriodPnl.js";

// The real baseline / snapshot-mark SQL runs against a private copy of the test database's tables (the baselines depend on global
// tables and on CURRENT_DATE); only the ledger loader is replaced by hand-built fixtures, so the day / week / month / year
// attribution can be worked out by hand.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
const loadCycleInputsForTickersMock = vi.fn();
vi.mock("./cycleQueries.js", () => ({ loadCycleInputsForTickers: (...args: unknown[]) => loadCycleInputsForTickersMock(...args) }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { computeCyclePeriodPnl, loadBaselineDates, loadSnapshotMarksOn, openMarkTotal } = await import("./cyclePeriodPnl.js");
const { deriveCycles } = await import("./cycles.js");

const testDb: Knex = db;
const cyclePeriods: CyclePeriod[] = ["day", "week", "month", "year"];
const millisecondsPerDay = 86_400_000;

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

beforeEach(async () => {
  loadCycleInputsForTickersMock.mockReset();
  await testDb("account_pnl_snapshots").del();
  await testDb("market_calendar").del();
  await testDb("position_pnl_snapshots").del();
});

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * millisecondsPerDay).toISOString().slice(0, 10);
}

function daysBetween(earlierIsoDate: string, laterIsoDate: string): number {
  return Math.round((Date.parse(`${laterIsoDate}T00:00:00Z`) - Date.parse(`${earlierIsoDate}T00:00:00Z`)) / millisecondsPerDay);
}

// ISO weekday of a date: Monday 1 ... Sunday 7.
function isoWeekday(isoDate: string): number {
  return ((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

// The weekday fallback when the calendar has no earlier open day: the previous day, skipping to Friday from a Monday or Sunday.
function previousWeekdayFallback(isoDate: string): string {
  const weekday = isoWeekday(isoDate);
  return addDays(isoDate, weekday === 1 ? -3 : weekday === 7 ? -2 : -1);
}

async function databaseToday(): Promise<string> {
  return (await testDb.raw("SELECT CURRENT_DATE::text AS today")).rows[0].today;
}

async function insertAccountSnapshot(snapshotDate: string): Promise<void> {
  await testDb("account_pnl_snapshots").insert({ snapshot_date: snapshotDate, daily_pnl: 0, net_liquidation_value: 100000 });
}

async function insertCalendarDay(calendarDate: string, isOpen: boolean): Promise<void> {
  await testDb("market_calendar").insert({ calendar_date: calendarDate, is_open: isOpen });
}

describe("loadBaselineDates", () => {
  it("returns null while there is no account snapshot (nothing to anchor the Day baseline to)", async () => {
    expect(await loadBaselineDates()).toBeNull();
  });

  it.each([
    ["a Tuesday", "2026-03-17", "2026-03-16"],
    ["a Monday (skips the weekend)", "2026-03-16", "2026-03-13"],
    ["a Sunday", "2026-03-15", "2026-03-13"],
    ["a Saturday", "2026-03-14", "2026-03-13"],
  ])("Day baseline with an empty calendar, latest snapshot on %s, falls back to the previous weekday", async (_label, snapshotDate, expectedBaseline) => {
    await insertAccountSnapshot(snapshotDate);
    expect((await loadBaselineDates())!.day).toBe(expectedBaseline);
  });

  it("Day baseline is anchored to the LATEST snapshot, not an earlier one", async () => {
    await insertAccountSnapshot("2026-03-10");
    await insertAccountSnapshot("2026-03-17");
    expect((await loadBaselineDates())!.day).toBe("2026-03-16");
  });

  it("uses the last OPEN calendar day before the boundary, skipping closed days and ignoring days after it", async () => {
    await insertAccountSnapshot("2026-03-17");
    await insertCalendarDay("2026-03-13", true);
    await insertCalendarDay("2026-03-16", false);
    await insertCalendarDay("2026-03-17", true);
    await insertCalendarDay("2026-03-18", true);
    expect((await loadBaselineDates())!.day).toBe("2026-03-13");
  });

  it("falls back to the weekday arithmetic when the calendar has no open day before the boundary", async () => {
    await insertAccountSnapshot("2026-03-17");
    await insertCalendarDay("2026-03-18", true);
    expect((await loadBaselineDates())!.day).toBe("2026-03-16");
  });

  it("a calendar that stops short of the recent days does not pull the baseline back to its last open day", async () => {
    await insertAccountSnapshot("2026-03-17");
    await insertCalendarDay("2026-03-02", true);
    expect((await loadBaselineDates())!.day).toBe("2026-03-16");
  });

  it("Week / Month / Year baselines are the last trading day before this Monday / the 1st / Jan 1 (by the database's CURRENT_DATE)", async () => {
    await insertAccountSnapshot("2026-03-17");
    const today = await databaseToday();
    const weekStart = addDays(today, -(isoWeekday(today) - 1));
    const monthStart = `${today.slice(0, 7)}-01`;
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const baselines = (await loadBaselineDates())!;
    expect(baselines.week).toBe(previousWeekdayFallback(weekStart));
    expect(baselines.month).toBe(previousWeekdayFallback(monthStart));
    expect(baselines.year).toBe(previousWeekdayFallback(yearStart));
  });

  it("takes Week / Month / Year baselines from the calendar when it has open days before each boundary", async () => {
    await insertAccountSnapshot("2026-03-17");
    const today = await databaseToday();
    const weekStart = addDays(today, -(isoWeekday(today) - 1));
    // An open day 4 days before this Monday; the days between it and the Monday are closed holidays.
    await insertCalendarDay(addDays(weekStart, -4), true);
    for (const offset of [-3, -2, -1]) await insertCalendarDay(addDays(weekStart, offset), false);
    expect((await loadBaselineDates())!.week).toBe(addDays(weekStart, -4));
  });
});

describe("loadSnapshotMarksOn", () => {
  it("returns the premium and total unrealized marks of every position snapshotted on exactly that date", async () => {
    const [firstPositionId, secondPositionId, otherDayPositionId] = [randomUUID(), randomUUID(), randomUUID()];
    await testDb("position_pnl_snapshots").insert([
      { position_id: firstPositionId, snapshot_date: "2026-03-13", premium_pnl: 120.5, unrealized_pnl: 130.25 },
      { position_id: secondPositionId, snapshot_date: "2026-03-13", premium_pnl: null, unrealized_pnl: -40 },
      { position_id: otherDayPositionId, snapshot_date: "2026-03-12", premium_pnl: 1, unrealized_pnl: 2 },
    ]);
    const marks = await loadSnapshotMarksOn("2026-03-13");
    expect(marks.size).toBe(2);
    expect(marks.get(firstPositionId)).toEqual({ premiumPnl: 120.5, unrealizedPnl: 130.25 });
    expect(marks.get(secondPositionId)).toEqual({ premiumPnl: null, unrealizedPnl: -40 });
  });

  it("returns an empty map for a date nobody was snapshotted on", async () => {
    expect((await loadSnapshotMarksOn("2026-03-13")).size).toBe(0);
  });
});

function shortPutLeg(positionId: string, overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg {
  return {
    id: randomUUID(), positionId, side: "short", optionType: "put", strike: 100, quantity: 1, multiplier: 100, entryPrice: 2,
    entryAt: new Date("2026-01-02T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
    expiryDate: "2099-01-15", expiryClose: null, ...overrides,
  };
}

function ledgerInput(optionLegs: CycleOptionLeg[], openPositionPremiumPnl: Map<string, number> = new Map()): CycleInput {
  return { optionLegs, stockLegs: [], stockTrades: [], dailyCloses: new Map(), lastPrice: null, openPositionPremiumPnl };
}

// Latest account snapshot = the database's today. The marks of a leg that gains $1 per day are seeded on every baseline day:
// mark(date) = nowMark - (days between that date and today). Period P&L of such a leg then equals the days since the baseline.
async function seedBaselinesAndDailyGainingMarks(positionIds: string[], nowMark: number, skippedPeriods: CyclePeriod[] = []) {
  const today = await databaseToday();
  await insertAccountSnapshot(today);
  const baselines = (await loadBaselineDates())!;
  const daysSinceBaseline = Object.fromEntries(cyclePeriods.map((period) => [period, daysBetween(baselines[period], today)])) as Record<CyclePeriod, number>;
  const skippedDates = new Set(skippedPeriods.map((period) => baselines[period]));
  const datesWithMarks = new Set(cyclePeriods.map((period) => baselines[period]).filter((date) => !skippedDates.has(date)));
  for (const date of datesWithMarks) {
    for (const positionId of positionIds) {
      const mark = nowMark - daysBetween(date, today);
      await testDb("position_pnl_snapshots").insert({ position_id: positionId, snapshot_date: date, premium_pnl: mark, unrealized_pnl: mark });
    }
  }
  return { today, baselines, daysSinceBaseline };
}

function bucketPeriods(result: Awaited<ReturnType<typeof computeCyclePeriodPnl>>, bucket: CycleBucket) {
  const { day, week, month, year, realizedYear, unrealizedYear } = result.buckets[bucket];
  return { day, week, month, year, realizedYear, unrealizedYear };
}

describe("computeCyclePeriodPnl", () => {
  it("returns all-zero buckets without even loading the ledger while there is no account snapshot", async () => {
    const result = await computeCyclePeriodPnl();
    expect(loadCycleInputsForTickersMock).not.toHaveBeenCalled();
    for (const bucket of ["csp", "unstructured", "cc", "hedge"] as CycleBucket[]) {
      expect(result.buckets[bucket]).toEqual({ day: 0, week: 0, month: 0, year: 0, realizedYear: 0, unrealizedYear: 0 });
    }
    expect(result.excludedByPeriod).toEqual({ day: [], week: [], month: [], year: [] });
  });

  it("a short put open since before every baseline: each period is the mark now minus the mark on its baseline day, all of it unrealized", async () => {
    const positionId = randomUUID();
    const { baselines, daysSinceBaseline } = await seedBaselinesAndDailyGainingMarks([positionId], 1000);
    // Sold for 2.00 x 100 = $200 credit, one year-baseline minus 20 days ago; now marked at +$1000 of premium P&L.
    const entryAt = new Date(`${addDays(baselines.year, -20)}T15:00:00Z`);
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "AAA", tickerId: "t", input: ledgerInput([shortPutLeg(positionId, { entryAt })], new Map([[positionId, 1000]])) }]);

    const result = await computeCyclePeriodPnl();

    expect(loadCycleInputsForTickersMock).toHaveBeenCalledWith("all");
    expect(bucketPeriods(result, "csp")).toEqual({
      day: daysSinceBaseline.day,
      week: daysSinceBaseline.week,
      month: daysSinceBaseline.month,
      year: daysSinceBaseline.year,
      realizedYear: 0,
      unrealizedYear: daysSinceBaseline.year,
    });
    expect(bucketPeriods(result, "cc")).toEqual({ day: 0, week: 0, month: 0, year: 0, realizedYear: 0, unrealizedYear: 0 });
    expect(result.excludedByPeriod).toEqual({ day: [], week: [], month: [], year: [] });
  });

  it("a cycle that finished before the Year baseline contributes nothing to any period and is not flagged", async () => {
    const positionId = randomUUID();
    const { baselines } = await seedBaselinesAndDailyGainingMarks([positionId], 1000);
    const closedLeg = shortPutLeg(positionId, {
      entryAt: new Date(`${addDays(baselines.year, -60)}T15:00:00Z`),
      exitAt: new Date(`${addDays(baselines.year, -50)}T15:00:00Z`),
      exitPrice: 1,
      hasClosingTrade: true,
    });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "OLD", tickerId: "t", input: ledgerInput([closedLeg]) }]);

    const result = await computeCyclePeriodPnl();

    for (const bucket of ["csp", "unstructured", "cc", "hedge"] as CycleBucket[]) {
      expect(bucketPeriods(result, bucket)).toEqual({ day: 0, week: 0, month: 0, year: 0, realizedYear: 0, unrealizedYear: 0 });
    }
    expect(result.excludedByPeriod).toEqual({ day: [], week: [], month: [], year: [] });
  });

  it("a put sold and bought back after every baseline: the whole cycle total lands in every period, all realized", async () => {
    const positionId = randomUUID();
    const { today } = await seedBaselinesAndDailyGainingMarks([positionId], 1000);
    // $200 credit, bought back at 0.50 ($50) with a $1 commission: 200 - 50 - 1 = $149.
    const closedLeg = shortPutLeg(positionId, {
      entryAt: new Date(`${addDays(today, 2)}T15:00:00Z`),
      exitAt: new Date(`${addDays(today, 3)}T15:00:00Z`),
      exitPrice: 0.5,
      closingCommission: 1,
      hasClosingTrade: true,
    });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "NEW", tickerId: "t", input: ledgerInput([closedLeg]) }]);

    const result = await computeCyclePeriodPnl();

    expect(bucketPeriods(result, "csp")).toEqual({ day: 149, week: 149, month: 149, year: 149, realizedYear: 149, unrealizedYear: 0 });
  });

  it("a put sold after every baseline and still open: its marked P&L is each period's figure, and the credit counts as realized", async () => {
    const positionId = randomUUID();
    const { today } = await seedBaselinesAndDailyGainingMarks([positionId], 1000);
    const openLeg = shortPutLeg(positionId, { entryAt: new Date(`${addDays(today, 2)}T15:00:00Z`) });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "NEW", tickerId: "t", input: ledgerInput([openLeg], new Map([[positionId, 30]])) }]);

    const result = await computeCyclePeriodPnl();

    // Total = mark = $30. The open-mark part is the mark minus the $200 credit = -$170; so realized = 30 - (-170) = $200, the credit.
    expect(bucketPeriods(result, "csp")).toEqual({ day: 30, week: 30, month: 30, year: 30, realizedYear: 200, unrealizedYear: -170 });
  });

  it("a long option still held (hedge): its whole P&L is unrealized, the premium paid is not a realized loss", async () => {
    const positionId = randomUUID();
    const { baselines, daysSinceBaseline } = await seedBaselinesAndDailyGainingMarks([positionId], -100);
    // Bought at 3.00 x 100 = $300 before every baseline; now marked at -$100 (worth $200).
    const hedgeLeg = shortPutLeg(positionId, { side: "long", optionType: "call", entryPrice: 3, entryAt: new Date(`${addDays(baselines.year, -20)}T15:00:00Z`) });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "HDG", tickerId: "t", input: ledgerInput([hedgeLeg], new Map([[positionId, -100]])) }]);

    const result = await computeCyclePeriodPnl();

    expect(bucketPeriods(result, "hedge")).toEqual({
      day: daysSinceBaseline.day,
      week: daysSinceBaseline.week,
      month: daysSinceBaseline.month,
      year: daysSinceBaseline.year,
      realizedYear: 0,
      unrealizedYear: daysSinceBaseline.year,
    });
    expect(bucketPeriods(result, "csp")).toMatchObject({ day: 0, year: 0 });
  });

  it("a cycle whose open position has no snapshot on a period's baseline day is excluded from that period only, with the reason", async () => {
    const positionId = randomUUID();
    const { baselines, daysSinceBaseline } = await seedBaselinesAndDailyGainingMarks([positionId], 1000, ["year"]);
    const openLeg = shortPutLeg(positionId, { strike: 50, entryAt: new Date(`${addDays(baselines.year, -20)}T15:00:00Z`) });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "FLG", tickerId: "t", input: ledgerInput([openLeg], new Map([[positionId, 1000]])) }]);

    const result = await computeCyclePeriodPnl();

    const unmarkedPeriods = cyclePeriods.filter((period) => baselines[period] === baselines.year);
    for (const period of cyclePeriods) {
      const expectedExclusion = unmarkedPeriods.includes(period) ? [{ symbol: "FLG", reason: "no option mark for the open put $50" }] : [];
      expect(result.excludedByPeriod[period]).toEqual(expectedExclusion);
      expect(result.buckets.csp[period]).toBe(unmarkedPeriods.includes(period) ? 0 : daysSinceBaseline[period]);
    }
    expect(result.buckets.csp.realizedYear).toBe(0);
    expect(result.buckets.csp.unrealizedYear).toBe(0);
  });

  it("a cycle whose ledger is untrusted now (a settled put with no expiry price bar) is excluded from every period", async () => {
    const positionId = randomUUID();
    const { baselines } = await seedBaselinesAndDailyGainingMarks([positionId], 1000);
    const expiredLeg = shortPutLeg(positionId, {
      strike: 75,
      entryAt: new Date(`${addDays(baselines.year, -20)}T15:00:00Z`),
      exitAt: new Date(`${addDays(baselines.day, 1)}T21:00:00Z`),
      exitPrice: 0,
      expiryDate: "2026-02-20",
      expiryClose: null,
    });
    loadCycleInputsForTickersMock.mockResolvedValue([{ symbol: "BAR", tickerId: "t", input: ledgerInput([expiredLeg]) }]);

    const result = await computeCyclePeriodPnl();

    for (const period of cyclePeriods) {
      expect(result.excludedByPeriod[period]).toEqual([{ symbol: "BAR", reason: "no expiry-date price bar for put $75 (2026-02-20)" }]);
      expect(result.buckets.csp[period]).toBe(0);
    }
  });

  it("adds up several symbols per bucket and keeps CC and CSP apart", async () => {
    const [putPositionId, callPositionId] = [randomUUID(), randomUUID()];
    const { today } = await seedBaselinesAndDailyGainingMarks([], 0);
    const afterBaselines = (daysAhead: number) => new Date(`${addDays(today, daysAhead)}T15:00:00Z`);
    // A put (+$149 as above) and a naked call sold after the baselines: $1.50 credit = $150, bought back at 0.25 = -$25 => $125.
    const closedPut = shortPutLeg(putPositionId, { entryAt: afterBaselines(2), exitAt: afterBaselines(3), exitPrice: 0.5, closingCommission: 1, hasClosingTrade: true });
    const closedCall = shortPutLeg(callPositionId, { optionType: "call", entryPrice: 1.5, entryAt: afterBaselines(2), exitAt: afterBaselines(3), exitPrice: 0.25, hasClosingTrade: true });
    loadCycleInputsForTickersMock.mockResolvedValue([
      { symbol: "PUT", tickerId: "t1", input: ledgerInput([closedPut]) },
      { symbol: "CAL", tickerId: "t2", input: ledgerInput([closedCall]) },
      { symbol: "PU2", tickerId: "t3", input: ledgerInput([{ ...closedPut, id: randomUUID(), positionId: randomUUID() }]) },
    ]);

    const result = await computeCyclePeriodPnl();

    expect(bucketPeriods(result, "csp")).toMatchObject({ day: 298, year: 298, realizedYear: 298 });
    expect(bucketPeriods(result, "cc")).toMatchObject({ day: 125, year: 125, realizedYear: 125 });
  });
});

describe("openMarkTotal", () => {
  it("is zero for a missing cycle", () => {
    expect(openMarkTotal(undefined, "csp")).toBe(0);
  });

  it("sums only the marked-to-market rows of the asked bucket", () => {
    const input = ledgerInput([shortPutLeg("pos", { entryAt: new Date("2026-01-02T15:00:00Z") })], new Map([["pos", 50]]));
    const cycle = deriveCycles(input)[0]!;
    // $200 credit row is dated; the open mark row is 50 - 200 = -150.
    expect(openMarkTotal(cycle, "csp")).toBe(-150);
    expect(openMarkTotal(cycle, "cc")).toBe(0);
  });
});
