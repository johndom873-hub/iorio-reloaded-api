import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Audit D (2026-10-07): describeDaySignalsWatch against decideRerank, and loadDaySignalsWatchStatuses against the test database.
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Day Signals watch status audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { describeDaySignalsWatch, loadDaySignalsWatchStatuses } = await import("./daySignalsWatchStatus.js");
const { decideRerank, daySignalsRerankTriggerFraction } = await import("./daySignalsContractSet.js");
const testDb: Knex = db;

const base = { openDay: true, seedFinished: true, pooledExpiries: [] as string[], atmImpliedVolatility: 0.25, snapshotSpotPrice: 100, rerankState: null };

describe("describeDaySignalsWatch — audit D (pure)", () => {
  it("a spot at either displayed trigger price makes the loop look (the screen's promise matches decideRerank)", () => {
    const misses: string[] = [];
    for (const reference of [10, 11.11, 23.45, 47.3, 113.93, 407.29]) {
      for (const atmImpliedVolatility of [0.25, 0.627, 0.8]) {
        const status = describeDaySignalsWatch({ ...base, atmImpliedVolatility, snapshotSpotPrice: reference });
        for (const trigger of [status.triggerLowPrice!, status.triggerHighPrice!]) {
          const decision = decideRerank({ spotPrice: trigger, referenceSpotPrice: reference, atmImpliedVolatility, lastLookAtMs: null, firstSeenAtMs: null, pooled: true, nowMs: 0 });
          if (decision !== "price") misses.push(`${reference} @ IV ${atmImpliedVolatility}: ${trigger} (fraction ${daySignalsRerankTriggerFraction(atmImpliedVolatility).toFixed(6)})`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("the next timed check it shows is exactly when decideRerank first returns timed", () => {
    const firstSeenAt = new Date("2026-10-07T14:07:00Z");
    const lastLookAt = new Date("2026-10-07T15:30:00Z");
    for (const state of [
      { referenceSpotPrice: 100, reranks: 0, firstSeenAt, lastLookAt: null, lastLookKind: null },
      { referenceSpotPrice: 100, reranks: 1, firstSeenAt, lastLookAt, lastLookKind: "price" as const },
    ]) {
      const status = describeDaySignalsWatch({ ...base, rerankState: state });
      const dueMs = Date.parse(status.nextTimedCheckAt!);
      const input = { spotPrice: 100, referenceSpotPrice: 100, atmImpliedVolatility: 0.25, lastLookAtMs: state.lastLookAt?.getTime() ?? null, firstSeenAtMs: firstSeenAt.getTime(), pooled: false };
      expect(decideRerank({ ...input, nowMs: dueMs - 1 })).toBeNull();
      expect(decideRerank({ ...input, nowMs: dueMs })).toBe("timed");
    }
  });

  it("an unpooled ticker the loop has not seen yet has triggers from the 10:00 spot and no next timed check", () => {
    const status = describeDaySignalsWatch(base);
    expect(status).toMatchObject({ kind: "not_watched", nextTimedCheckAt: null, lastLookAt: null, lastLookKind: null, triggerLowPrice: 99, triggerHighPrice: 101 });
  });

  it("no surface when today's snapshot has no spot, even with an IV", () => {
    expect(describeDaySignalsWatch({ ...base, snapshotSpotPrice: null }).kind).toBe("no_surface");
  });

  it("market closed wins over everything else, waiting for the capture over a missing surface", () => {
    expect(describeDaySignalsWatch({ ...base, openDay: false, seedFinished: false, atmImpliedVolatility: null }).kind).toBe("market_closed");
    expect(describeDaySignalsWatch({ ...base, seedFinished: false, atmImpliedVolatility: null }).kind).toBe("waiting_for_capture");
  });

  it("a pooled ticker after a look shows that look and triggers around its spot, and still no timed check", () => {
    const lastLookAt = new Date("2026-10-07T15:30:00Z");
    const status = describeDaySignalsWatch({ ...base, pooledExpiries: ["2026-10-16"], rerankState: { referenceSpotPrice: 110, reranks: 4, firstSeenAt: new Date("2026-10-07T14:07:00Z"), lastLookAt, lastLookKind: "price" } });
    expect(status).toEqual({ kind: "watched", pooledExpiries: ["2026-10-16"], lastLookAt: lastLookAt.toISOString(), lastLookKind: "price", nextTimedCheckAt: null, triggerLowPrice: 108.9, triggerHighPrice: 111.1 });
  });
});

// ---- DB: loadDaySignalsWatchStatuses on a far-future Monday (2031-03-03, no market_calendar row = weekday = open) ----
const tradingDate = "2031-03-03";
const sessionNow = new Date("2031-03-03T16:00:00Z"); // 11:00 ET, session open
const created = { tickers: [] as string[], snapshots: [] as string[], jobRuns: [] as string[] };
let counter = Date.now() % 100_000;

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `AWD${(counter += 1)}`, company_name: "Audit D Watch Co", sector: "Technology" }).returning(["id"]);
  created.tickers.push(ticker.id);
  return ticker.id;
}

async function createSnapshot(tickerId: string, dateIso: string, underlyingPrice: number | null, sliceDaysToExpiry: number[]): Promise<string> {
  const [snapshot] = await testDb("option_chain_snapshots").insert({ ticker_id: tickerId, trading_date: dateIso, captured_at: new Date(`${dateIso}T14:00:00Z`), status: "complete", underlying_price: underlyingPrice }).returning(["id"]);
  created.snapshots.push(snapshot.id);
  for (const days of sliceDaysToExpiry) {
    const expiry = new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    // Flat SVI with total variance a = 0.3^2 * T: ATM IV 30%.
    const yearsToExpiry = days / 365;
    await testDb("option_surface_fits").insert({ snapshot_id: snapshot.id, expiry, years_to_expiry: yearsToExpiry, forward_price: underlyingPrice ?? 100, status: "ok", point_count: 20, dropped_counts: JSON.stringify({ inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 }), param_a: 0.09 * yearsToExpiry, param_b: 0, param_rho: 0, param_m: 0, param_sigma: 0.1 });
  }
  return snapshot.id;
}

async function createSeedRun(startedAt: string, finishedAt: string | null, jobName = "day_signals_seed"): Promise<void> {
  const [run] = await testDb("job_runs").insert({ job_name: jobName, started_at: startedAt, finished_at: finishedAt, status: finishedAt ? "success" : "running" }).returning(["id"]);
  created.jobRuns.push(run.id);
}

afterEach(async () => {
  await testDb("job_runs").whereIn("id", created.jobRuns).del();
  created.jobRuns.length = 0;
  await testDb("day_signal_rerank_state").whereIn("ticker_id", created.tickers).del();
  await testDb("day_signal_expiries").whereIn("ticker_id", created.tickers).del();
});

afterAll(async () => {
  await testDb("option_surface_fits").whereIn("snapshot_id", created.snapshots).del();
  await testDb("option_chain_snapshots").whereIn("id", created.snapshots).del();
  await testDb("tickers").whereIn("id", created.tickers).del();
  await testDb.destroy();
});

describe("loadDaySignalsWatchStatuses — audit D (test DB)", () => {
  it("returns every kind from real rows: watched, not watched with its clock, no surface (old snapshot, short slices only, no snapshot)", async () => {
    const pooled = await createTicker();
    const pooledSnapshot = await createSnapshot(pooled, tradingDate, 50, [30]);
    await testDb("day_signal_expiries").insert({ ticker_id: pooled, expiry: "2031-03-14", trading_date: tradingDate, snapshot_id: pooledSnapshot, rank: 1, seed_best_edge_dollars: 10, seed_best_net_edge: 0.01, seeded_at: new Date("2031-03-03T15:07:00Z") });
    const unpooled = await createTicker();
    await createSnapshot(unpooled, tradingDate, 200, [7, 30, 60]);
    const firstSeenAt = new Date("2031-03-03T15:07:30Z");
    await testDb("day_signal_rerank_state").insert({ ticker_id: unpooled, trading_date: tradingDate, reference_spot_price: 200, rerank_count: 0, first_seen_at: firstSeenAt, updated_at: new Date() });
    const yesterdayOnly = await createTicker();
    await createSnapshot(yesterdayOnly, "2031-02-28", 80, [30]);
    const shortOnly = await createTicker();
    await createSnapshot(shortOnly, tradingDate, 80, [7]);
    const noSnapshot = await createTicker();
    await createSeedRun("2031-03-03T15:05:00Z", "2031-03-03T15:07:00Z");

    const result = await loadDaySignalsWatchStatuses([pooled, unpooled, yesterdayOnly, shortOnly, noSnapshot], sessionNow);
    expect(result.tradingDateIso).toBe(tradingDate);
    expect(result.sessionOpen).toBe(true);
    expect(result.statuses.get(pooled)).toMatchObject({ kind: "watched", pooledExpiries: ["2031-03-14"], triggerLowPrice: 49.5, triggerHighPrice: 50.5, nextTimedCheckAt: null });
    expect(result.statuses.get(unpooled)).toMatchObject({ kind: "not_watched", nextTimedCheckAt: "2031-03-03T16:07:30.000Z", triggerLowPrice: 198, triggerHighPrice: 202 });
    expect(result.statuses.get(yesterdayOnly)!.kind).toBe("no_surface");
    expect(result.statuses.get(shortOnly)!.kind).toBe("no_surface");
    expect(result.statuses.get(noSnapshot)!.kind).toBe("no_surface");
  });

  it("waits for the capture until a seed run finishes; a still-running seed or another job does not count", async () => {
    const ticker = await createTicker();
    await createSnapshot(ticker, tradingDate, 100, [30]);
    await createSeedRun("2031-03-03T15:05:00Z", null);
    await createSeedRun("2031-03-03T15:05:00Z", "2031-03-03T15:06:00Z", "option_chain_capture_audit_d");
    expect((await loadDaySignalsWatchStatuses([ticker], sessionNow)).statuses.get(ticker)!.kind).toBe("waiting_for_capture");
  });

  it("counts a seed by its Eastern start date: 22:30 ET on the 3rd (03:30 UTC on the 4th) is the 3rd's seed, not the 4th's", async () => {
    const { hasDaySignalsSeedFinished } = await import("./daySignalsStore.js");
    await createSeedRun("2031-03-04T03:30:00Z", "2031-03-04T03:31:00Z");
    expect(await hasDaySignalsSeedFinished("2031-03-03")).toBe(true);
    expect(await hasDaySignalsSeedFinished("2031-03-04")).toBe(false);
  });

  it("a failed (finished) seed counts as done", async () => {
    const { hasDaySignalsSeedFinished } = await import("./daySignalsStore.js");
    const [run] = await testDb("job_runs").insert({ job_name: "day_signals_seed", started_at: "2031-03-05T15:05:00Z", finished_at: "2031-03-05T15:06:00Z", status: "failure", error_message: "one ticker without a snapshot" }).returning(["id"]);
    created.jobRuns.push(run.id);
    expect(await hasDaySignalsSeedFinished("2031-03-05")).toBe(true);
  });

  it("reports market closed on a weekend and an empty ticker list without failing", async () => {
    const saturday = new Date("2031-03-08T16:00:00Z");
    const ticker = await createTicker();
    expect((await loadDaySignalsWatchStatuses([ticker], saturday)).statuses.get(ticker)!.kind).toBe("market_closed");
    const empty = await loadDaySignalsWatchStatuses([], sessionNow);
    expect(empty.statuses.size).toBe(0);
  });
});
