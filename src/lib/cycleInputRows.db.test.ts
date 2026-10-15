import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { CycleDailyCloseRow, CycleOptionLegRow, CycleStockLegRow, CycleStockTradeRow } from "./cycleInputRows.js";

// The cycle loaders' SQL and the exported row mapping, on the same rows: what loadCycleInputsForTickers and
// fetchOpenCycleSummaryByTickerId return from the database is what buildCycleInputFromRows and
// summarizeOpenCycleFromRows build from those rows written out by hand. Runs in a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { fetchCyclesForTickers, loadCycleInputsForTickers } = await import("./cycleQueries.js");
const { fetchOpenCycleSummaryByTickerId } = await import("./cycleBreakEvenQueries.js");
const { buildCycleInputFromRows, summarizeOpenCycleFromRows } = await import("./cycleInputRows.js");
const { deriveCycles } = await import("./cycles.js");
const testDb: Knex = db;

// A wheel on one ticker: a $50 put assigned on 13 March (close 48.50), a call sold on the shares and bought back on
// 18 March (two closing fills, one without a commission report), a second call still open, a protective long put; a
// plain open put on a second ticker.
const wheelTickerId: string = randomUUID();
const otherTickerId: string = randomUUID();
const ids: Record<"putPosition" | "sharesPosition" | "firstCallPosition" | "secondCallPosition" | "hedgePosition" | "otherPutPosition", string> = { putPosition: randomUUID(), sharesPosition: randomUUID(), firstCallPosition: randomUUID(), secondCallPosition: randomUUID(), hedgePosition: randomUUID(), otherPutPosition: randomUUID() };
const legIds: Record<"put" | "handedShares" | "firstCall" | "firstCallShares" | "secondCall" | "secondCallShares" | "hedge" | "otherPut", string> = { put: randomUUID(), handedShares: randomUUID(), firstCall: randomUUID(), firstCallShares: randomUUID(), secondCall: randomUUID(), secondCallShares: randomUUID(), hedge: randomUUID(), otherPut: randomUUID() };
const at = (iso: string) => new Date(iso);
const putOpenedAt = at("2026-03-02T15:00:00Z");
const assignedAt = at("2026-03-13T20:00:00Z");
const firstCallAt = at("2026-03-16T14:00:00Z");
const rolledAt = at("2026-03-18T14:30:00Z");
const hedgeAt = at("2026-03-19T14:00:00Z");

beforeAll(async () => {
  await testDb("tickers").insert([
    { id: wheelTickerId, symbol: "WHL", company_name: "Wheel Co", sector: "Technology" },
    { id: otherTickerId, symbol: "OTH", company_name: "Other Co", sector: "Financial" },
  ]);
  await testDb("positions").insert([
    { id: ids.putPosition, strategy_key: "cash_secured_put", ticker_id: wheelTickerId, status: "closed", opened_at: putOpenedAt, closed_at: assignedAt, close_reason: "assigned" },
    { id: ids.sharesPosition, strategy_key: "unstructured", ticker_id: wheelTickerId, status: "closed", opened_at: assignedAt, closed_at: firstCallAt, close_reason: "stock_rolled_into_covered_call", unstructured_reason: "csp_assigned_stock" },
    { id: ids.firstCallPosition, strategy_key: "covered_call", ticker_id: wheelTickerId, status: "closed", opened_at: firstCallAt, closed_at: rolledAt, close_reason: "closed_via_app" },
    { id: ids.secondCallPosition, strategy_key: "covered_call", ticker_id: wheelTickerId, status: "open", opened_at: rolledAt },
    { id: ids.hedgePosition, strategy_key: "hedge", ticker_id: wheelTickerId, status: "open", opened_at: hedgeAt },
    { id: ids.otherPutPosition, strategy_key: "cash_secured_put", ticker_id: otherTickerId, status: "open", opened_at: putOpenedAt },
  ]);
  const optionLeg = (id: string, positionId: string, side: string, optionType: string, strike: number, expiry: string, entryPrice: number, entryAt: Date, exitPrice: number | null, exitAt: Date | null, quantity = 1) => ({ id, position_id: positionId, leg_type: "option", side, quantity, option_type: optionType, strike_price: strike, expiry_date: expiry, multiplier: 100, entry_price: entryPrice, entry_at: entryAt, exit_price: exitPrice, exit_at: exitAt });
  const stockLeg = (id: string, positionId: string, entryAt: Date, exitAt: Date | null) => ({ id, position_id: positionId, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 50, entry_at: entryAt, exit_price: exitAt === null ? null : 50, exit_at: exitAt });
  await testDb("position_legs").insert([
    optionLeg(legIds.put, ids.putPosition, "short", "put", 50, "2026-03-13", 0.9932, putOpenedAt, 0, assignedAt),
    stockLeg(legIds.handedShares, ids.sharesPosition, assignedAt, firstCallAt),
    optionLeg(legIds.firstCall, ids.firstCallPosition, "short", "call", 51, "2026-03-20", 0.7932, firstCallAt, 0.35, rolledAt),
    stockLeg(legIds.firstCallShares, ids.firstCallPosition, firstCallAt, rolledAt),
    optionLeg(legIds.secondCall, ids.secondCallPosition, "short", "call", 52, "2026-03-27", 0.8432, rolledAt, null, null),
    stockLeg(legIds.secondCallShares, ids.secondCallPosition, rolledAt, null),
    optionLeg(legIds.hedge, ids.hedgePosition, "long", "put", 45, "2026-04-17", 0.4, hedgeAt, null, null),
    optionLeg(legIds.otherPut, ids.otherPutPosition, "short", "put", 20, "2026-03-27", 0.3, putOpenedAt, null, null, 2),
  ]);
  const trade = (legId: string, side: string, quantity: number, price: number, commission: number | null, executedAt: Date, isClosingTrade: boolean) => ({ position_leg_id: legId, side, quantity, price, commission, executed_at: executedAt, is_closing_trade: isClosingTrade });
  await testDb("trades").insert([
    trade(legIds.put, "sell", 1, 1, 0.68, putOpenedAt, false),
    trade(legIds.handedShares, "buy", 100, 50, 0, assignedAt, false),
    trade(legIds.firstCall, "sell", 1, 0.8, 0.68, firstCallAt, false),
    trade(legIds.firstCall, "buy", 1, 0.35, 0.68, rolledAt, true),
    trade(legIds.firstCall, "buy", 1, 0.35, null, rolledAt, true),
    trade(legIds.secondCall, "sell", 1, 0.85, 0.68, rolledAt, false),
  ]);
  await testDb("daily_price_bars").insert([
    { ticker_id: wheelTickerId, trading_date: "2026-03-13", close_price: 48.5 },
    { ticker_id: wheelTickerId, trading_date: "2026-03-16", close_price: 49.4 },
    { ticker_id: wheelTickerId, trading_date: "2026-03-18", close_price: 50.6 },
    { ticker_id: wheelTickerId, trading_date: "2026-03-20", close_price: 51.2 },
    { ticker_id: otherTickerId, trading_date: "2026-03-20", close_price: 21 },
  ]);
  await testDb("position_pnl_snapshots").insert([
    { position_id: ids.secondCallPosition, snapshot_date: "2026-03-19", premium_pnl: 12.5 },
    { position_id: ids.secondCallPosition, snapshot_date: "2026-03-20", premium_pnl: 30.25 },
  ]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const optionRow = (row: Omit<CycleOptionLegRow, "multiplier" | "quantity"> & { quantity?: number }): CycleOptionLegRow => ({ multiplier: 100, quantity: 1, ...row });
const wheelOptionRows: CycleOptionLegRow[] = [
  optionRow({ id: legIds.put, positionId: ids.putPosition, tickerId: wheelTickerId, side: "short", optionType: "put", strike: 50, entryPrice: 0.9932, entryAt: putOpenedAt, exitPrice: 0, exitAt: assignedAt, expiryDate: "2026-03-13", closingCommission: 0, hasClosingTrade: false, expiryClose: 48.5 }),
  optionRow({ id: legIds.firstCall, positionId: ids.firstCallPosition, tickerId: wheelTickerId, side: "short", optionType: "call", strike: 51, entryPrice: 0.7932, entryAt: firstCallAt, exitPrice: 0.35, exitAt: rolledAt, expiryDate: "2026-03-20", closingCommission: 0.68, hasClosingTrade: true, expiryClose: 51.2 }),
  optionRow({ id: legIds.secondCall, positionId: ids.secondCallPosition, tickerId: wheelTickerId, side: "short", optionType: "call", strike: 52, entryPrice: 0.8432, entryAt: rolledAt, exitPrice: null, exitAt: null, expiryDate: "2026-03-27", closingCommission: 0, hasClosingTrade: false, expiryClose: null }),
  optionRow({ id: legIds.hedge, positionId: ids.hedgePosition, tickerId: wheelTickerId, side: "long", optionType: "put", strike: 45, entryPrice: 0.4, entryAt: hedgeAt, exitPrice: null, exitAt: null, expiryDate: "2026-04-17", closingCommission: 0, hasClosingTrade: false, expiryClose: null }),
];
const otherOptionRows: CycleOptionLegRow[] = [optionRow({ id: legIds.otherPut, positionId: ids.otherPutPosition, tickerId: otherTickerId, side: "short", optionType: "put", strike: 20, quantity: 2, entryPrice: 0.3, entryAt: putOpenedAt, exitPrice: null, exitAt: null, expiryDate: "2026-03-27", closingCommission: 0, hasClosingTrade: false, expiryClose: null })];
const stockLegRows: CycleStockLegRow[] = [
  { tickerId: wheelTickerId, positionId: ids.sharesPosition, quantity: 100, entryAt: assignedAt, exitAt: firstCallAt },
  { tickerId: wheelTickerId, positionId: ids.firstCallPosition, quantity: 100, entryAt: firstCallAt, exitAt: rolledAt },
  { tickerId: wheelTickerId, positionId: ids.secondCallPosition, quantity: 100, entryAt: rolledAt, exitAt: null },
];
const stockTradeRows: CycleStockTradeRow[] = [{ tickerId: wheelTickerId, at: assignedAt, side: "buy", quantity: 100, price: 50, commission: 0 }];
const barRows: CycleDailyCloseRow[] = [
  { tickerId: wheelTickerId, date: "2026-03-13", close: 48.5 },
  { tickerId: wheelTickerId, date: "2026-03-16", close: 49.4 },
  { tickerId: wheelTickerId, date: "2026-03-18", close: 50.6 },
  { tickerId: wheelTickerId, date: "2026-03-20", close: 51.2 },
  { tickerId: otherTickerId, date: "2026-03-20", close: 21 },
];
const handWrittenRows = { optionRows: [...wheelOptionRows, ...otherOptionRows], stockLegRows, stockTradeRows, barRows, openPositionPremiumPnl: new Map([[ids.secondCallPosition, 30.25]]), openPositionMarkDate: new Map([[ids.secondCallPosition, "2026-03-20"]]) };

const sortById = <Row extends { id: string }>(rows: Row[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const sortByEntry = <Row extends { entryAt: Date }>(rows: Row[]) => [...rows].sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime());

describe("the cycle loaders and the exported row mapping", () => {
  it("load from the database the CycleInput the mapping builds from the same rows, per ticker", async () => {
    const loaded = await loadCycleInputsForTickers([wheelTickerId, otherTickerId]);
    expect(loaded.map((entry) => entry.symbol)).toEqual(["OTH", "WHL"]);
    for (const { tickerId, input } of loaded) {
      const built = buildCycleInputFromRows(tickerId, handWrittenRows);
      expect(sortById(input.optionLegs)).toEqual(sortById(built.optionLegs));
      expect(sortByEntry(input.stockLegs)).toEqual(sortByEntry(built.stockLegs));
      expect(input.stockTrades).toEqual(built.stockTrades);
      expect(input.dailyCloses).toEqual(built.dailyCloses);
      expect(input.lastPrice).toEqual(built.lastPrice);
      expect(input.openPositionPremiumPnl).toEqual(built.openPositionPremiumPnl);
      expect(input.openPositionMarkDate).toEqual(built.openPositionMarkDate);
    }
  });

  it("derive the same cycles from either", async () => {
    const [wheel] = (await fetchCyclesForTickers([wheelTickerId])).map((entry) => entry.cycles);
    const fromRows = deriveCycles(buildCycleInputFromRows(wheelTickerId, handWrittenRows));
    expect(wheel).toHaveLength(1);
    expect(wheel![0]!.dataFlags).toEqual([]);
    expect(wheel![0]!.total).toBeCloseTo(fromRows[0]!.total, 8);
    expect(wheel![0]!.buckets).toEqual(fromRows[0]!.buckets);
    expect(wheel![0]!.sharesHeld).toBe(100);
  });

  it("summarize the open cycle the mapping summarizes from the short legs, the stock fills and the open shares", async () => {
    const summaries = await fetchOpenCycleSummaryByTickerId([wheelTickerId, otherTickerId]);
    const closeReasonByPosition = new Map<string, string | null>([[ids.putPosition, "assigned"], [ids.firstCallPosition, "closed_via_app"], [ids.secondCallPosition, null], [ids.otherPutPosition, null]]);
    const shortRows = handWrittenRows.optionRows.filter((row) => row.side === "short").map((row) => ({ ...row, positionCloseReason: closeReasonByPosition.get(row.positionId) ?? null }));
    const wheelFromRows = summarizeOpenCycleFromRows(wheelTickerId, { optionRows: shortRows, stockTradeRows, openStockShares: 100 })!;
    expect(summaries.get(wheelTickerId)).toEqual(wheelFromRows);
    // By hand: 100 shares at the $50 strike; premium 99.32 + (79.32 − 35 − 0.68) + 84.32 = 227.28; break-even (5,000 − 227.28) ÷ 100.
    expect(wheelFromRows.netPremium).toBeCloseTo(227.28, 8);
    expect(wheelFromRows.breakEvenPerShare).toBeCloseTo(47.7272, 8);
    expect(summaries.get(otherTickerId)).toEqual(summarizeOpenCycleFromRows(otherTickerId, { optionRows: shortRows, stockTradeRows, openStockShares: 0 }));
  });
});

// An early assignment (Marcelo 2026-10-15): a $40 put expiring 17 April assigned on the night of 23 March (reconciliation
// closes the leg at 22:00 ET with no closing trade and marks the position assigned; IBKR's stock buy at the strike lands
// 40 s earlier). It settles on 23 March's close, $37: the 24 March bar is after the leg closed, and 17 April has no bar.
describe("an option assigned before its expiry date", () => {
  const earlyTickerId: string = randomUUID();
  const putPositionId: string = randomUUID();
  const sharesPositionId: string = randomUUID();
  const putLegId: string = randomUUID();
  const sharesLegId: string = randomUUID();
  const assignedNight = at("2026-03-24T02:00:00Z");

  beforeAll(async () => {
    await testDb("tickers").insert({ id: earlyTickerId, symbol: "EAR", company_name: "Early Assignment Co", sector: "Technology" });
    await testDb("positions").insert([
      { id: putPositionId, strategy_key: "cash_secured_put", ticker_id: earlyTickerId, status: "closed", opened_at: putOpenedAt, closed_at: assignedNight, close_reason: "assigned" },
      { id: sharesPositionId, strategy_key: "unstructured", ticker_id: earlyTickerId, status: "open", opened_at: assignedNight, unstructured_reason: "csp_assigned_stock" },
    ]);
    await testDb("position_legs").insert([
      { id: putLegId, position_id: putPositionId, leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: 40, expiry_date: "2026-04-17", multiplier: 100, entry_price: 1.2, entry_at: putOpenedAt, exit_price: null, exit_at: assignedNight },
      { id: sharesLegId, position_id: sharesPositionId, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 38.8, entry_at: assignedNight, exit_price: null, exit_at: null },
    ]);
    await testDb("trades").insert([
      { position_leg_id: putLegId, side: "sell", quantity: 1, price: 1.2, commission: 0.68, executed_at: putOpenedAt, is_closing_trade: false },
      { position_leg_id: sharesLegId, side: "buy", quantity: 100, price: 40, commission: 0, executed_at: at("2026-03-24T01:59:20Z"), is_closing_trade: false },
    ]);
    await testDb("daily_price_bars").insert([
      { ticker_id: earlyTickerId, trading_date: "2026-03-23", close_price: 37 },
      { ticker_id: earlyTickerId, trading_date: "2026-03-24", close_price: 38 },
    ]);
  });

  it("settles as assigned on the assignment day's close, not waiting for an expiry-date bar", async () => {
    const [loaded] = await loadCycleInputsForTickers([earlyTickerId]);
    const putLeg = loaded!.input.optionLegs.find((leg) => leg.id === putLegId)!;
    expect(putLeg).toMatchObject({ settledAs: "assigned", expiryClose: 37 });
    expect(putLeg).not.toHaveProperty("assignedBeforeExpiry");

    const [cycles] = (await fetchCyclesForTickers([earlyTickerId])).map((entry) => entry.cycles);
    expect(cycles![0]!.dataFlags).toEqual([]);
    expect(cycles![0]!.sharesHeld).toBe(100);
    expect(cycles![0]!.timeline.find((row) => row.label.startsWith("Put assigned"))).toMatchObject({ strike: 40, stockPrice: 37, quantity: 100 });
  });

  it("gives the cycle a break-even, from IBKR's stock buy at the strike counted once", async () => {
    const summary = (await fetchOpenCycleSummaryByTickerId([earlyTickerId])).get(earlyTickerId)!;
    // 100 shares at $40 less the $120 premium: (4,000 − 120) ÷ 100.
    expect(summary).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, unavailableReason: null });
    expect(summary.breakEvenPerShare).toBeCloseTo(38.8, 8);
  });

  it("still refuses a leg that vanished before its expiry without being marked assigned", async () => {
    await testDb("positions").where({ id: putPositionId }).update({ close_reason: "expired" });
    try {
      const summary = (await fetchOpenCycleSummaryByTickerId([earlyTickerId])).get(earlyTickerId)!;
      expect(summary.breakEvenPerShare).toBeNull();
      expect(summary.unavailableReason).toMatch(/no expiry-date price bar/);
    } finally {
      await testDb("positions").where({ id: putPositionId }).update({ close_reason: "assigned" });
    }
  });
});
