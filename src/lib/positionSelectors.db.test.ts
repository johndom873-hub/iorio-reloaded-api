import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { PositionFigures, PositionLegFigures } from "./positionSelectors.js";

// The position figures' SQL (positionSelect, fetchAvailableUncoveredShares, computeCashLockedInCsps) and their pure
// mirrors in positionSelectors.ts, on the same rows: one seeded position per CASE branch, read back from the database
// for the pure side, with the expected figures also worked out by hand. Runs in a private copy of the test tables,
// because the cash locked in puts is a sum over every position there is.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { fetchAvailableUncoveredShares, positionSelect } = await import("./positionQueries.js");
const { computeCashLockedInCsps } = await import("./positionExposure.js");
const { availableUncoveredShares, cashLockedInCashSecuredPuts, positionCapitalAtRisk, positionCapitalDeployed, positionRealizedPnl } = await import("./positionSelectors.js");
const { loadOpenPositionFigures } = await import("../pluto/ladderLookSnapshot.js");
const testDb: Knex = db;

const firstTickerId: string = randomUUID();
const secondTickerId: string = randomUUID();
const day = (dayOfMarch: number, hour = 15) => new Date(Date.UTC(2026, 2, dayOfMarch, hour));

interface SeedLeg {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  entryAt: Date;
  optionType?: "call" | "put";
  strike?: number;
  expiry?: string;
  exitPrice?: number | null;
  exitAt?: Date | null;
  /** Index of the leg (in this position) this one was carved from. */
  carvedFromLegIndex?: number;
  /** Commissions of this leg's trades: closing ones count, opening ones never do, null = no commission report. */
  closingTradeCommissions?: (number | null)[];
  openingTradeCommissions?: number[];
}

interface SeedPosition {
  name: string;
  tickerId: string;
  strategyKey: "hedge" | "leaps" | "covered_call" | "cash_secured_put" | "unstructured";
  status: "open" | "closed";
  legs: SeedLeg[];
  /** Hand-worked figures; null = the SQL returns NULL. */
  expected: { capitalAtRisk: number | null; capitalDeployed: number | null; realizedPnl: number; realizedPremiumPnl: number; realizedStockPnl: number };
}

const option = (side: "long" | "short", optionType: "call" | "put", strike: number, expiry: string, quantity: number, entryPrice: number, entryAt: Date, rest: Partial<SeedLeg> = {}): SeedLeg => ({ legType: "option", side, optionType, strike, expiry, quantity, entryPrice, entryAt, ...rest });
const stock = (quantity: number, entryPrice: number, entryAt: Date, rest: Partial<SeedLeg> = {}): SeedLeg => ({ legType: "stock", side: "long", quantity, entryPrice, entryAt, ...rest });

const seedPositions: SeedPosition[] = [
  {
    // Hedge: the premium paid for every option leg, open or closed: 0.40 × 100 × 2 + 0.25 × 100 × 1.
    name: "hedge with an open long put and a sold long call",
    tickerId: firstTickerId,
    strategyKey: "hedge",
    status: "open",
    legs: [option("long", "put", 45, "2026-04-17", 2, 0.4, day(2)), option("long", "call", 60, "2026-04-17", 1, 0.25, day(3), { exitPrice: 0.1, exitAt: day(10), closingTradeCommissions: [0.68] })],
    expected: { capitalAtRisk: 105, capitalDeployed: 105, realizedPnl: -15.68, realizedPremiumPnl: -15.68, realizedStockPnl: 0 },
  },
  {
    // LEAPS: like a hedge, the premium paid, not the strike: 3.918 × 100 × 2.
    name: "LEAPS with an open long call",
    tickerId: firstTickerId,
    strategyKey: "leaps",
    status: "open",
    legs: [option("long", "call", 82, "2028-06-16", 2, 3.918, day(4))],
    expected: { capitalAtRisk: 783.6, capitalDeployed: 783.6, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // Open stock leg + open short call: 50.015 × 200 − 0.7932 × 100 × 2.
    name: "open covered call",
    tickerId: firstTickerId,
    strategyKey: "covered_call",
    status: "open",
    legs: [stock(200, 50.015, day(4), { openingTradeCommissions: [1] }), option("short", "call", 52, "2026-03-27", 2, 0.7932, day(4), { openingTradeCommissions: [1.36] })],
    expected: { capitalAtRisk: 9844.36, capitalDeployed: 9844.36, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // Option only: (45 − 1.1932) × 100 × 3.
    name: "open cash-secured put",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "open",
    legs: [option("short", "put", 45, "2026-03-27", 3, 1.1932, day(5))],
    expected: { capitalAtRisk: 13142.04, capitalDeployed: 13142.04, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // Carved slices: 2 of 5 contracts bought back at 0.30. At risk: the 3 still open; deployed: all 5 of the contract.
    // Realized: (0.8932 − 0.30) × 2 × 100 − 1.36 commission.
    name: "cash-secured put partly bought back",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "open",
    legs: [option("short", "put", 40, "2026-03-27", 3, 0.8932, day(5)), option("short", "put", 40, "2026-03-27", 2, 0.8932, day(5), { exitPrice: 0.3, exitAt: day(11), carvedFromLegIndex: 0, closingTradeCommissions: [0.68, 0.68] })],
    expected: { capitalAtRisk: 11732.04, capitalDeployed: 19553.4, realizedPnl: 117.28, realizedPremiumPnl: 117.28, realizedStockPnl: 0 },
  },
  {
    // Closed legs, shares called away at 52: no open stock leg, so at risk falls back to the call's strike less its
    // premium; deployed stays the shares' cost less the call premium. Stock (52 − 50) × 100, premium 0.6932 × 100.
    name: "covered call called away",
    tickerId: firstTickerId,
    strategyKey: "covered_call",
    status: "closed",
    legs: [stock(100, 50, day(2), { exitPrice: 52, exitAt: day(13, 20) }), option("short", "call", 52, "2026-03-13", 1, 0.6932, day(2), { exitPrice: 0, exitAt: day(13, 20) })],
    expected: { capitalAtRisk: 5130.68, capitalDeployed: 4930.68, realizedPnl: 269.32, realizedPremiumPnl: 69.32, realizedStockPnl: 200 },
  },
  {
    name: "bare leftover stock",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "open",
    legs: [stock(300, 48, day(6))],
    expected: { capitalAtRisk: 14400, capitalDeployed: 14400, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // 40 of 100 shares sold at 49.50: at risk the 60 held, deployed all 100, realized (49.5 − 47) × 40 − 0.20.
    name: "stock with a sold slice",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "open",
    legs: [stock(60, 47, day(6), { openingTradeCommissions: [0.5] }), stock(40, 47, day(6), { exitPrice: 49.5, exitAt: day(12), carvedFromLegIndex: 0, closingTradeCommissions: [0.2] })],
    expected: { capitalAtRisk: 2820, capitalDeployed: 4700, realizedPnl: 99.8, realizedPremiumPnl: 0, realizedStockPnl: 99.8 },
  },
  {
    // Two call contracts on one position (older data): only the open one's premium comes off, at risk and deployed.
    // Realized on the closed call: (0.50 − 0.20) × 100 − 0.68, the second closing trade has no commission report.
    name: "covered call with an earlier call contract closed",
    tickerId: firstTickerId,
    strategyKey: "covered_call",
    status: "open",
    legs: [stock(100, 50, day(2)), option("short", "call", 51, "2026-03-13", 1, 0.5, day(2), { exitPrice: 0.2, exitAt: day(9), closingTradeCommissions: [0.68, null] }), option("short", "call", 53, "2026-03-27", 1, 0.9, day(9))],
    expected: { capitalAtRisk: 4910, capitalDeployed: 4910, realizedPnl: 29.32, realizedPremiumPnl: 29.32, realizedStockPnl: 0 },
  },
  {
    // A long option outside a hedge position brought no premium in: the whole strike, 60 × 100.
    name: "long call on an unstructured position",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "open",
    legs: [option("long", "call", 60, "2026-04-17", 1, 0.3, day(7))],
    expected: { capitalAtRisk: 6000, capitalDeployed: 6000, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    name: "position without legs",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "closed",
    legs: [],
    expected: { capitalAtRisk: null, capitalDeployed: null, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // Closed option-only position: the latest leg. (30 − 0.5) × 100; realized the whole premium.
    name: "put expired worthless",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "closed",
    legs: [option("short", "put", 30, "2026-03-13", 1, 0.5, day(2), { exitPrice: 0, exitAt: day(13, 20) })],
    expected: { capitalAtRisk: 2950, capitalDeployed: 2950, realizedPnl: 50, realizedPremiumPnl: 50, realizedStockPnl: 0 },
  },
  {
    // Two different put contracts, both closed: the later one is "the contract"; the earlier is not a slice of it.
    // Realized (0.60 − 0.90) × 100 + 0.70 × 100.
    name: "closed position with two put contracts",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "closed",
    legs: [option("short", "put", 35, "2026-03-13", 1, 0.6, day(2), { exitPrice: 0.9, exitAt: day(9) }), option("short", "put", 34, "2026-03-20", 1, 0.7, day(9), { exitPrice: 0, exitAt: day(20, 20) })],
    expected: { capitalAtRisk: 3330, capitalDeployed: 3330, realizedPnl: 40, realizedPremiumPnl: 40, realizedStockPnl: 0 },
  },
  {
    // A leg that left with no exit price yet (vanished before expiry) is closed but realizes nothing.
    name: "put gone with no exit price",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "closed",
    legs: [option("short", "put", 28, "2026-03-27", 1, 0.45, day(2), { exitPrice: null, exitAt: day(10) })],
    expected: { capitalAtRisk: 2755, capitalDeployed: 2755, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    // Still open as a position though its only leg has closed: its strike still counts as cash locked.
    name: "open put position whose leg already closed",
    tickerId: firstTickerId,
    strategyKey: "cash_secured_put",
    status: "open",
    legs: [option("short", "put", 25, "2026-03-13", 1, 0.35, day(2), { exitPrice: 0, exitAt: day(13, 20) })],
    expected: { capitalAtRisk: 2465, capitalDeployed: 2465, realizedPnl: 35, realizedPremiumPnl: 35, realizedStockPnl: 0 },
  },
  {
    name: "closed leftover stock, sold",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "closed",
    legs: [stock(100, 46, day(3), { exitPrice: 46.8, exitAt: day(8), closingTradeCommissions: [0.5] })],
    expected: { capitalAtRisk: null, capitalDeployed: 4600, realizedPnl: 79.5, realizedPremiumPnl: 0, realizedStockPnl: 79.5 },
  },
  {
    name: "short stock on an open unstructured position",
    tickerId: firstTickerId,
    strategyKey: "unstructured",
    status: "open",
    legs: [{ legType: "stock", side: "short", quantity: 10, entryPrice: 49, entryAt: day(7) }],
    expected: { capitalAtRisk: 490, capitalDeployed: 490, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    name: "leftover stock on the second ticker",
    tickerId: secondTickerId,
    strategyKey: "unstructured",
    status: "open",
    legs: [stock(100, 20, day(6))],
    expected: { capitalAtRisk: 2000, capitalDeployed: 2000, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
  {
    name: "open put on the second ticker",
    tickerId: secondTickerId,
    strategyKey: "cash_secured_put",
    status: "open",
    legs: [option("short", "put", 20, "2026-03-27", 1, 0.3, day(6))],
    expected: { capitalAtRisk: 1970, capitalDeployed: 1970, realizedPnl: 0, realizedPremiumPnl: 0, realizedStockPnl: 0 },
  },
];

const positionIdByName = new Map<string, string>();

beforeAll(async () => {
  await testDb("tickers").insert([
    { id: firstTickerId, symbol: "SELA", company_name: "Selector A", sector: "Technology" },
    { id: secondTickerId, symbol: "SELB", company_name: "Selector B", sector: "Financial" },
  ]);
  for (const position of seedPositions) {
    const positionId: string = randomUUID();
    positionIdByName.set(position.name, positionId);
    await testDb("positions").insert({ id: positionId, strategy_key: position.strategyKey, ticker_id: position.tickerId, status: position.status, opened_at: day(2), closed_at: position.status === "closed" ? day(20) : null });
    const legIds: string[] = position.legs.map(() => randomUUID());
    for (const [index, leg] of position.legs.entries()) {
      await testDb("position_legs").insert({
        id: legIds[index],
        position_id: positionId,
        leg_type: leg.legType,
        side: leg.side,
        quantity: leg.quantity,
        option_type: leg.optionType ?? null,
        strike_price: leg.strike ?? null,
        expiry_date: leg.expiry ?? null,
        multiplier: leg.legType === "stock" ? 1 : 100,
        entry_price: leg.entryPrice,
        entry_at: leg.entryAt,
        exit_price: leg.exitPrice ?? null,
        exit_at: leg.exitAt ?? null,
        parent_leg_id: leg.carvedFromLegIndex === undefined ? null : legIds[leg.carvedFromLegIndex],
      });
      const trades = [
        ...(leg.openingTradeCommissions ?? []).map((commission) => ({ commission, is_closing_trade: false })),
        ...(leg.closingTradeCommissions ?? []).map((commission) => ({ commission, is_closing_trade: true })),
      ];
      if (trades.length > 0) await testDb("trades").insert(trades.map((trade) => ({ position_leg_id: legIds[index], side: "buy", quantity: 1, price: 1, executed_at: day(12), ...trade })));
    }
  }
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

/** Every position as the pure selectors take it, read back from the tables the SQL reads. */
async function loadPositionFigures(): Promise<Map<string, PositionFigures & { tickerId: string; closingCommissionByLegId: Map<string, number> }>> {
  const positionRows: { id: string; strategy_key: string; status: "open" | "closed"; ticker_id: string }[] = await testDb("positions").select("id", "strategy_key", "status", "ticker_id");
  const legRows = await testDb("position_legs").select("*", testDb.raw("expiry_date::text as expiry_date"));
  const commissionRows: { position_leg_id: string; total: string | null }[] = await testDb("trades").where({ is_closing_trade: true }).groupBy("position_leg_id").select("position_leg_id").sum({ total: "commission" });
  const closingCommissionByLegId = new Map(commissionRows.map((row) => [row.position_leg_id, Number(row.total ?? 0)]));
  return new Map(
    positionRows.map((position) => {
      const legs: PositionLegFigures[] = legRows
        .filter((leg) => leg.position_id === position.id)
        .map((leg) => ({ id: leg.id, legType: leg.leg_type, side: leg.side, quantity: Number(leg.quantity), optionType: leg.option_type, strikePrice: leg.strike_price === null ? null : Number(leg.strike_price), expiryDate: leg.expiry_date, multiplier: Number(leg.multiplier), entryPrice: Number(leg.entry_price), entryAt: new Date(leg.entry_at), exitPrice: leg.exit_price === null ? null : Number(leg.exit_price), exitAt: leg.exit_at === null ? null : new Date(leg.exit_at) }));
      return [position.id, { strategyKey: position.strategy_key, status: position.status, legs, tickerId: position.ticker_id, closingCommissionByLegId }];
    }),
  );
}

const numberOrNull = (value: string | number | null) => (value === null ? null : Number(value));

describe("position figures: the SQL and its pure mirror", () => {
  it.each(seedPositions.map((position) => [position.name, position] as const))("agree on %s", async (_name, seed) => {
    const positionId = positionIdByName.get(seed.name)!;
    const sqlRow = (await testDb.raw(`${positionSelect} WHERE p.id = ?`, [positionId])).rows[0];
    const figures = (await loadPositionFigures()).get(positionId)!;
    const realized = positionRealizedPnl(figures.legs, figures.closingCommissionByLegId);
    const pure = { capitalAtRisk: positionCapitalAtRisk(figures), capitalDeployed: positionCapitalDeployed(figures), realizedPnl: realized.total, realizedPremiumPnl: realized.premium, realizedStockPnl: realized.stock };
    const fromSql = { capitalAtRisk: numberOrNull(sqlRow.capitalAtRisk), capitalDeployed: numberOrNull(sqlRow.capitalDeployed), realizedPnl: Number(sqlRow.realizedPnl), realizedPremiumPnl: Number(sqlRow.realizedPremiumPnl), realizedStockPnl: Number(sqlRow.realizedStockPnl) };
    for (const key of ["capitalAtRisk", "capitalDeployed", "realizedPnl", "realizedPremiumPnl", "realizedStockPnl"] as const) {
      if (seed.expected[key] === null) {
        expect(fromSql[key], `SQL ${key}`).toBeNull();
        expect(pure[key], `pure ${key}`).toBeNull();
      } else {
        expect(fromSql[key], `SQL ${key}`).toBeCloseTo(seed.expected[key]!, 6);
        expect(pure[key], `pure ${key}`).toBeCloseTo(seed.expected[key]!, 6);
      }
    }
  });

  it("agree on the free shares of each ticker: open long stock on open unstructured positions only", async () => {
    const positions = [...(await loadPositionFigures()).values()];
    // First ticker: 300 leftover + the 60 still held beside the sold slice; not the covered calls' shares, not the short stock.
    expect(await fetchAvailableUncoveredShares(firstTickerId)).toBe(360);
    expect(availableUncoveredShares(positions.filter((position) => position.tickerId === firstTickerId))).toBe(360);
    expect(await fetchAvailableUncoveredShares(secondTickerId)).toBe(100);
    expect(availableUncoveredShares(positions.filter((position) => position.tickerId === secondTickerId))).toBe(100);
  });

  it("agree on the cash locked in cash-secured puts: the full strike of every open put position", async () => {
    // 45 × 300 + 40 × 300 (the open slice) + 25 × 100 (leg closed, position still open) + 20 × 100 on the second ticker.
    const expectedLocked = 13_500 + 12_000 + 2_500 + 2_000;
    expect(await computeCashLockedInCsps()).toBeCloseTo(expectedLocked, 6);
    expect(cashLockedInCashSecuredPuts([...(await loadPositionFigures()).values()])).toBeCloseTo(expectedLocked, 6);
  });

  it("the live ladder's loader reads a ticker's open positions as the SQL figures them", async () => {
    const loaded = await loadOpenPositionFigures(firstTickerId);
    const sqlRows = (await testDb.raw(`${positionSelect} WHERE p.ticker_id = ? AND p.status = 'open'`, [firstTickerId])).rows;
    expect(loaded).toHaveLength(sqlRows.length);
    expect(availableUncoveredShares(loaded)).toBe(360);
    // 45 × 300 + 40 × 300 + 25 × 100: the first ticker's open put positions.
    expect(cashLockedInCashSecuredPuts(loaded)).toBeCloseTo(28_000, 6);
    const sqlCapitalAtRisk = sqlRows.reduce((sum: number, row: { capitalAtRisk: string | null }) => sum + (numberOrNull(row.capitalAtRisk) ?? 0), 0);
    expect(loaded.reduce((sum, position) => sum + (positionCapitalAtRisk(position) ?? 0), 0)).toBeCloseTo(sqlCapitalAtRisk, 6);
  });
});
