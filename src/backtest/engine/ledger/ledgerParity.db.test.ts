import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { Cycle } from "../../../lib/cycles.js";

// Parity as a test (docs/backtesting/INVENTORY-WHEEL-ACCOUNTING.md §5.3): the finished six-symbol book of
// testSupport/finishedLedgerFixture.ts is written into the platform's tables, and the platform's own SQL (positionSelect,
// the free-shares and cash-locked queries, the break-even and cycle loaders) is asserted to read from those rows what
// the ledger's selectors read from memory. Runs in a private copy of the test tables.
vi.mock("../../../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../../../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../../../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../../../lib/testSupport/isolatedTestSchema.js");
const { fetchAvailableUncoveredShares, positionSelect } = await import("../../../lib/positionQueries.js");
const { computeCashLockedInCsps } = await import("../../../lib/positionExposure.js");
const { fetchBreakEvenByPositionId, fetchOpenCycleSummaryByTickerId } = await import("../../../lib/cycleBreakEvenQueries.js");
const { fetchCyclesForTickers } = await import("../../../lib/cycleQueries.js");
const { ledgerBreakEvenForPosition, ledgerCapitalAtRisk, ledgerCapitalDeployed, ledgerCashLockedInCashSecuredPuts, ledgerCycles, ledgerFreeShares, ledgerOpenCycleSummary, ledgerRealizedPnl } = await import("./ledgerSelectors.js");
const { buildFinishedLedgerFixture, fixtureDailyCloses, fixtureSectorBySymbol, fixtureSymbols } = await import("./testSupport/finishedLedgerFixture.js");
const { exportLedgerToDatabase } = await import("./testSupport/exportLedgerToDatabase.js");
const testDb: Knex = db;

const fixture = buildFinishedLedgerFixture();
const { ledger } = fixture;
const tickerIdBySymbol = new Map<string, string>(fixtureSymbols.map((symbol) => [symbol, randomUUID()]));
let positionIdByLedgerId = new Map<string, string>();
// The nightly snapshot's premium P&L of the open option positions at the 20 March marks: the MIX calls (0.3932 − 0.25) × 200,
// the ROL puts (1.3932 − 1.00) × 200.
const snapshotPremiumPnl = { mixCoveredCall: 28.64, rolPut: 78.64 };

beforeAll(async () => {
  await testDb("tickers").insert(fixtureSymbols.map((symbol) => ({ id: tickerIdBySymbol.get(symbol)!, symbol, company_name: `${symbol} Co`, sector: fixtureSectorBySymbol.get(symbol) ?? "" })));
  ({ positionIdByLedgerId } = await exportLedgerToDatabase(testDb, ledger, tickerIdBySymbol));
  await testDb("daily_price_bars").insert(fixtureSymbols.flatMap((symbol) => fixtureDailyCloses[symbol].map((bar) => ({ ticker_id: tickerIdBySymbol.get(symbol)!, trading_date: bar.date, close_price: bar.close }))));
  await testDb("position_pnl_snapshots").insert([
    { position_id: positionIdByLedgerId.get(fixture.open.mixCoveredCallPositionId)!, snapshot_date: "2026-03-20", premium_pnl: snapshotPremiumPnl.mixCoveredCall },
    { position_id: positionIdByLedgerId.get(fixture.open.rolPutPositionId)!, snapshot_date: "2026-03-20", premium_pnl: snapshotPremiumPnl.rolPut },
  ]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const numberOrNull = (value: string | number | null) => (value === null ? null : Number(value));

function expectSameNumber(fromSql: number | null, fromLedger: number | null, what: string): void {
  if (fromLedger === null) expect(fromSql, what).toBeNull();
  else expect(fromSql, what).toBeCloseTo(fromLedger, 6);
}

/** A cycle with its instants as text and its rows in a fixed order: rows of one instant come out in the order the legs were read. */
function comparableCycle(cycle: Cycle) {
  const round = (value: number) => Number(value.toFixed(6));
  const buckets = Object.fromEntries(Object.entries(cycle.buckets).map(([bucket, result]) => [bucket, { premium: round(result.premium), stock: round(result.stock), total: round(result.total), capital: round(result.capital) }]));
  const timeline = cycle.timeline
    .map((row) => `${row.at === null ? "mark" : row.at.toISOString()} | ${row.bucket} | ${row.label} | ${row.instrument} ${row.quantity} | strike ${row.strike} | stock ${row.stockPrice === null ? null : round(row.stockPrice)} | premium ${round(row.premium)} | stock P&L ${round(row.stock)}`)
    .sort();
  return {
    startAt: cycle.startAt.toISOString(),
    endAt: cycle.endAt?.toISOString() ?? null,
    status: cycle.status,
    sharesHeld: cycle.sharesHeld,
    total: round(cycle.total),
    netPremium: round(cycle.netPremium),
    breakEvenPerShare: cycle.breakEvenPerShare === null ? null : round(cycle.breakEvenPerShare),
    dataFlags: cycle.dataFlags,
    buckets,
    timeline,
  };
}

describe("the platform's SQL over an exported ledger", () => {
  it("wrote every row of the ledger", async () => {
    const count = async (table: string) => Number((await testDb(table).count<{ count: string }[]>("* as count"))[0]!.count);
    expect(await count("positions")).toBe(ledger.positions.length);
    expect(await count("position_legs")).toBe(ledger.legs.length);
    expect(await count("trades")).toBe(ledger.trades.length);
    expect(await count("position_share_sources")).toBe(ledger.shareSources.length);
    expect(ledger.positions.length).toBe(19);
  });

  it("positionSelect reads each position's EXP $, P&L base and realized P&L as the ledger's selectors do", async () => {
    const sqlRows: { id: string; status: string; strategyKey: string; closeReason: string | null; unstructuredReason: string | null; capitalAtRisk: string | null; capitalDeployed: string | null; realizedPnl: string; realizedPremiumPnl: string; realizedStockPnl: string }[] = (await testDb.raw(positionSelect)).rows;
    const sqlRowById = new Map(sqlRows.map((row) => [row.id, row]));
    expect(sqlRows).toHaveLength(ledger.positions.length);
    for (const position of ledger.positions) {
      const what = `${position.symbol} ${position.strategyKey} ${position.id}`;
      const sqlRow = sqlRowById.get(positionIdByLedgerId.get(position.id)!)!;
      expect({ status: sqlRow.status, strategyKey: sqlRow.strategyKey, closeReason: sqlRow.closeReason, unstructuredReason: sqlRow.unstructuredReason }, what).toEqual({ status: position.status, strategyKey: position.strategyKey, closeReason: position.closeReason, unstructuredReason: position.unstructuredReason });
      const realized = ledgerRealizedPnl(ledger, position.id);
      expectSameNumber(numberOrNull(sqlRow.capitalAtRisk), ledgerCapitalAtRisk(ledger, position.id), `${what} capitalAtRisk`);
      expectSameNumber(numberOrNull(sqlRow.capitalDeployed), ledgerCapitalDeployed(ledger, position.id), `${what} capitalDeployed`);
      expectSameNumber(Number(sqlRow.realizedPnl), realized.total, `${what} realizedPnl`);
      expectSameNumber(Number(sqlRow.realizedPremiumPnl), realized.premium, `${what} realizedPremiumPnl`);
      expectSameNumber(Number(sqlRow.realizedStockPnl), realized.stock, `${what} realizedStockPnl`);
    }
    // Spot values, so the agreement is not two zeros: the open MIX covered call and the ROL put that was rolled away from.
    expect(Number(sqlRowById.get(positionIdByLedgerId.get(fixture.open.mixCoveredCallPositionId)!)!.capitalAtRisk)).toBeCloseTo(5933.96, 6);
    const rolledAwayPosition = ledger.positions.find((position) => position.symbol === "ROL" && position.status === "closed")!;
    expect(Number(sqlRowById.get(positionIdByLedgerId.get(rolledAwayPosition.id)!)!.realizedPnl)).toBeCloseTo(-62.72, 6);
  });

  it("the free shares of each ticker and the cash locked in puts agree", async () => {
    for (const symbol of fixtureSymbols) expect(await fetchAvailableUncoveredShares(tickerIdBySymbol.get(symbol)!), symbol).toBe(ledgerFreeShares(ledger, symbol));
    expect(await fetchAvailableUncoveredShares(tickerIdBySymbol.get("FRE")!)).toBe(100);
    expect(await computeCashLockedInCsps()).toBeCloseTo(ledgerCashLockedInCashSecuredPuts(ledger), 6);
    expect(await computeCashLockedInCsps()).toBe(7800);
  });

  it("fetchOpenCycleSummaryByTickerId finds the same open cycles, with the same break-even", async () => {
    const summaries = await fetchOpenCycleSummaryByTickerId([...tickerIdBySymbol.values()]);
    expect([...summaries.keys()].sort()).toEqual(["MIX", "ROL", "FRE"].map((symbol) => tickerIdBySymbol.get(symbol)!).sort());
    for (const symbol of fixtureSymbols) {
      const fromSql = summaries.get(tickerIdBySymbol.get(symbol)!) ?? null;
      const fromLedger = ledgerOpenCycleSummary(ledger, symbol);
      if (fromLedger === null) {
        expect(fromSql, symbol).toBeNull();
        continue;
      }
      expect(fromSql, symbol).not.toBeNull();
      expect({ sharesHeld: fromSql!.sharesHeld, sharesAcquired: fromSql!.sharesAcquired, unavailableReason: fromSql!.unavailableReason }, symbol).toEqual({ sharesHeld: fromLedger.sharesHeld, sharesAcquired: fromLedger.sharesAcquired, unavailableReason: fromLedger.unavailableReason });
      expectSameNumber(fromSql!.acquisitionCost, fromLedger.acquisitionCost, `${symbol} acquisitionCost`);
      expectSameNumber(fromSql!.netPremium, fromLedger.netPremium, `${symbol} netPremium`);
      expectSameNumber(fromSql!.breakEvenPerShare, fromLedger.breakEvenPerShare, `${symbol} breakEvenPerShare`);
      expect(fromSql!.openShortPuts, symbol).toEqual(fromLedger.openShortPuts.map((put) => ({ ...put, positionId: positionIdByLedgerId.get(put.positionId)! })));
    }
    expect(summaries.get(tickerIdBySymbol.get("MIX")!)!.breakEvenPerShare).toBeCloseTo(6991 / 240, 6);
  });

  it("fetchBreakEvenByPositionId gives each open position the ledger's break-even", async () => {
    const breakEvens = await fetchBreakEvenByPositionId([...tickerIdBySymbol.values()]);
    const openPositions = ledger.positions.filter((position) => position.status === "open");
    expect(breakEvens.size).toBe(openPositions.length);
    for (const position of openPositions) {
      const fromSql = breakEvens.get(positionIdByLedgerId.get(position.id)!)!;
      const fromLedger = ledgerBreakEvenForPosition(ledger, position.id);
      expectSameNumber(fromSql.breakEven, fromLedger.breakEven, `${position.symbol} break-even`);
      expect(fromSql.breakEvenUnavailableReason, position.symbol).toBe(fromLedger.reason);
    }
    expect(breakEvens.get(positionIdByLedgerId.get(fixture.open.rolPutPositionId)!)!.breakEven).toBeCloseTo(37.9204, 6);
  });

  it("fetchCyclesForTickers derives the same cycles, bucket by bucket and row by row", async () => {
    const fromSql = await fetchCyclesForTickers("all");
    expect(fromSql.map((entry) => entry.symbol)).toEqual([...fixtureSymbols].sort());
    for (const symbol of fixtureSymbols) {
      const sqlCycles = fromSql.find((entry) => entry.symbol === symbol)!.cycles;
      const ledgerCyclesOfSymbol = ledgerCycles(ledger, symbol, { dailyCloses: fixtureDailyCloses[symbol], optionMarkByLegId: fixture.optionMarkByLegId });
      expect(sqlCycles.map(comparableCycle), symbol).toEqual(ledgerCyclesOfSymbol.map(comparableCycle));
      for (const cycle of sqlCycles) expect(cycle.dataFlags, symbol).toEqual([]);
    }
    const totalsOf = (symbol: string) => fromSql.find((entry) => entry.symbol === symbol)!.cycles.map((cycle) => cycle.total.toFixed(2));
    expect(totalsOf("WHL")).toEqual(["287.96"]);
    expect(totalsOf("MIX")).toEqual(["298.40"]);
    expect(totalsOf("ROL")).toEqual(["15.92"]);
    expect(totalsOf("BWR")).toEqual(["295.64", "23.64", "70.64"]);
    expect(totalsOf("SLD")).toEqual(["137.82"]);
    expect(totalsOf("FRE")).toEqual(["-5.68"]);
  });
});

describe("a leg settled inside the platform's unclear zone", () => {
  // A $50 put sold at 1.20 finishes at 49.98: two cents in the money, assigned by the ledger's rule. The tables have no
  // column for how a leg settled, so the platform's loaders fall back on the expiry close and call it unclear; the
  // ledger's own rows carry the settlement and give the cycle its break-even, (5,000 − 119.32) ÷ 100 = 48.8068.
  it("is read correctly only through the ledger's rows", async () => {
    const { openCashSecuredPut, settleExpiry } = await import("./ledgerEvents.js");
    const { createSimulatedLedger } = await import("./simulatedLedger.js");
    const { decisionAt } = await import("./testSupport/finishedLedgerFixture.js");
    const pinLedger = createSimulatedLedger(100_000, decisionAt("2026-03-02"));
    const put = openCashSecuredPut(pinLedger, { symbol: "PIN", expiryDate: "2026-03-06", strike: 50, contracts: 1, fillPrice: 1.2, at: decisionAt("2026-03-02"), actionId: null, splitFactorToday: 1 });
    expect(settleExpiry(pinLedger, { legId: put.legId, expiryClose: 49.98 })).toBe("put_assigned");
    const pinTickerId: string = randomUUID();
    await testDb("tickers").insert({ id: pinTickerId, symbol: "PIN", company_name: "PIN Co", sector: "" });
    await exportLedgerToDatabase(testDb, pinLedger, new Map([["PIN", pinTickerId]]));
    await testDb("daily_price_bars").insert({ ticker_id: pinTickerId, trading_date: "2026-03-06", close_price: 49.98 });

    const fromLedger = ledgerOpenCycleSummary(pinLedger, "PIN")!;
    expect(fromLedger.unavailableReason).toBeNull();
    expect(fromLedger.breakEvenPerShare).toBeCloseTo(48.8068, 6);
    expect(ledgerCycles(pinLedger, "PIN", { dailyCloses: [{ date: "2026-03-06", close: 49.98 }] })[0]!.dataFlags).toEqual([]);

    const fromSql = (await fetchOpenCycleSummaryByTickerId([pinTickerId])).get(pinTickerId)!;
    expect(fromSql.breakEvenPerShare).toBeNull();
    expect(fromSql.unavailableReason).toContain("assignment unclear");
    expect((await fetchCyclesForTickers([pinTickerId]))[0]!.cycles[0]!.dataFlags).toEqual([expect.stringContaining("assignment unclear")]);
  });
});
