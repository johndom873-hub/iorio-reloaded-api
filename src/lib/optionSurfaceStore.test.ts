import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { blackScholesPriceOnForward, computeForwardPrice, sviTotalVariance, yearsBetweenIsoDates, type RawSviParameters } from "./impliedVolatilitySurface.js";

// Runs the surface-fit store against the test database (same convention as daySignalsContractContextStore.test.ts).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { fitAndStoreSurfacesForDate } = await import("./optionSurfaceStore.js");
const { loadSlices, loadLatestSnapshot, loadSnapshotVersions } = await import("./signalsStore.js");
const testDb: Knex = db;

const tradingDate = "2026-09-21";
const expiry = "2026-10-21";
const legacyExpiry = "2026-11-20";
const ratePercent = 4;
const snapshotSpot = 98; // read before the quotes arrived
const quotedUnderlying = 100; // what the quote rows carry
const truth: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };

let symbol = "";
let tickerId = "";
let snapshotId = "";

beforeAll(async () => {
  symbol = `SF${Date.now() % 100_000}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Surface Fit Test Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
  const [snapshot] = await testDb("option_chain_snapshots")
    .insert({ ticker_id: tickerId, trading_date: tradingDate, captured_at: new Date(), underlying_price: snapshotSpot, risk_free_rate_percent: ratePercent, status: "complete" })
    .returning("id");
  snapshotId = snapshot.id;
  const years = yearsBetweenIsoDates(tradingDate, expiry);
  const impliedForward = computeForwardPrice(quotedUnderlying, ratePercent / 100, years) * 1.004; // the market forward sits a little above the spot-based one
  const rows = Array.from({ length: 41 }, (_, index) => 80 + index).flatMap((strike) =>
    (["C", "P"] as const).map((right) => {
      const volatility = Math.sqrt(sviTotalVariance(truth, Math.log(strike / impliedForward)) / years);
      const mid = blackScholesPriceOnForward(impliedForward, strike, years, ratePercent / 100, volatility, right === "C");
      return { snapshot_id: snapshotId, expiry, strike, option_right: right, bid: mid * 0.985, ask: mid * 1.015, underlying_price: quotedUnderlying };
    }),
  );
  await testDb("option_quote_snapshots").insert(rows);
});

afterAll(async () => {
  await testDb("option_surface_fits").where({ snapshot_id: snapshotId }).del();
  await testDb("option_quote_snapshots").where({ snapshot_id: snapshotId }).del();
  await testDb("option_chain_snapshots").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
});

describe("surface fits, against the database", () => {
  it("stores the forward and the underlying price it is anchored to, and loadSlices reads both back", async () => {
    const result = await fitAndStoreSurfacesForDate(tradingDate, () => {}, [symbol]);
    expect(result).toMatchObject({ snapshotsConsidered: 1, tickersFitted: 1, expiriesOk: 1 });

    const [slice] = await loadSlices(snapshotId);
    expect(slice).toMatchObject({ expiry, status: "ok", fitUnderlyingPrice: quotedUnderlying });
    const spotBasedForward = computeForwardPrice(quotedUnderlying, ratePercent / 100, slice!.yearsToExpiry);
    expect(slice!.forwardPrice / spotBasedForward).toBeCloseTo(1.004, 3);

    const stored = await testDb("option_surface_fits").where({ snapshot_id: snapshotId, expiry }).first();
    expect(Number(stored.underlying_price)).toBe(quotedUnderlying);
    expect(Number(stored.forward_price)).toBeCloseTo(slice!.forwardPrice, 4);
  });

  it("reads a fit stored before the anchor existed as fitUnderlyingPrice null", async () => {
    await testDb("option_surface_fits").insert({ snapshot_id: snapshotId, expiry: legacyExpiry, years_to_expiry: 0.16, forward_price: 100.5, status: "insufficient_points", point_count: 3, dropped_counts: JSON.stringify({}) });
    const legacy = (await loadSlices(snapshotId)).find((slice) => slice.expiry === legacyExpiry);
    expect(legacy).toMatchObject({ forwardPrice: 100.5, fitUnderlyingPrice: null });
  });
});

describe("fit completion mark (Analysing vs analysed)", () => {
  const markDate = "2026-09-22";
  let markTickerId = "";
  let markSymbol = "";

  beforeAll(async () => {
    markSymbol = `FM${Date.now() % 100_000}`;
    const [ticker] = await testDb("tickers").insert({ symbol: markSymbol, company_name: "Fit Mark Test Co", sector: "Technology" }).returning("id");
    markTickerId = ticker.id;
  });

  afterAll(async () => {
    await testDb("option_chain_snapshots").where({ ticker_id: markTickerId }).del();
    await testDb("tickers").where({ id: markTickerId }).del();
  });

  async function insertSnapshot(overrides: Record<string, unknown> = {}): Promise<string> {
    await testDb("option_chain_snapshots").where({ ticker_id: markTickerId }).del();
    const [row] = await testDb("option_chain_snapshots")
      .insert({ ticker_id: markTickerId, trading_date: markDate, captured_at: new Date(), underlying_price: 100, risk_free_rate_percent: 4, status: "complete", ...overrides })
      .returning("id");
    return row.id;
  }

  it("a freshly saved snapshot is pending, and fitting it stamps fit_completed_at and moves its version token", async () => {
    const id = await insertSnapshot();
    expect((await loadLatestSnapshot(markTickerId))).toMatchObject({ snapshotId: id, fitCompletedAt: null, fitIssue: null });
    const pendingVersion = (await loadSnapshotVersions([markTickerId])).get(markTickerId);
    expect(pendingVersion).toBe(`${id}|pending`);

    const years = yearsBetweenIsoDates(markDate, expiry);
    const forward = computeForwardPrice(100, 0.04, years);
    const rows = Array.from({ length: 41 }, (_, index) => 80 + index).flatMap((strike) =>
      (["C", "P"] as const).map((right) => {
        const volatility = Math.sqrt(sviTotalVariance(truth, Math.log(strike / forward)) / years);
        const mid = blackScholesPriceOnForward(forward, strike, years, 0.04, volatility, right === "C");
        return { snapshot_id: id, expiry, strike, option_right: right, bid: mid * 0.985, ask: mid * 1.015, underlying_price: 100 };
      }),
    );
    await testDb("option_quote_snapshots").insert(rows);

    await fitAndStoreSurfacesForDate(markDate, () => {}, [markSymbol]);
    const analysed = await loadLatestSnapshot(markTickerId);
    expect(analysed!.fitCompletedAt).not.toBeNull();
    expect(analysed!.fitIssue).toBeNull();
    const fittedVersion = (await loadSnapshotVersions([markTickerId])).get(markTickerId);
    expect(fittedVersion).not.toBe(pendingVersion);
    expect(fittedVersion).toMatch(new RegExp(`^${id}\\|\\d{4}-`));
  });

  it("a snapshot the fit skips is analysed too, carrying the skip reason (so it never stays Analysing)", async () => {
    await insertSnapshot(); // no quote rows
    const result = await fitAndStoreSurfacesForDate(markDate, () => {}, [markSymbol]);
    expect(result).toMatchObject({ tickersSkipped: 1, tickersFitted: 0 });
    expect(await loadLatestSnapshot(markTickerId)).toMatchObject({ fitIssue: "no_quotes" });
    expect((await loadLatestSnapshot(markTickerId))!.fitCompletedAt).not.toBeNull();
  });

  it("a snapshot without a spot price records that as the issue", async () => {
    await insertSnapshot({ underlying_price: null });
    await fitAndStoreSurfacesForDate(markDate, () => {}, [markSymbol]);
    expect(await loadLatestSnapshot(markTickerId)).toMatchObject({ fitIssue: "no_spot_price" });
  });

  it("loadSnapshotVersions skips tickers with no usable snapshot and answers an empty list without a query", async () => {
    await testDb("option_chain_snapshots").where({ ticker_id: markTickerId }).del();
    expect((await loadSnapshotVersions([markTickerId])).size).toBe(0);
    expect((await loadSnapshotVersions([])).size).toBe(0);
  });
});

