import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real getCycleMarksHandler with the real cycle queries and cycle derivation against the test database. Positions are created as
// closed with their legs in place and flipped to open only around the request: the reconciliation tests share this database and
// their pass closes any open position that has no open leg. The response also carries whatever other open positions exist, so every
// assertion reads this file's own symbols out of it.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run cycle marks route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { getCycleMarksHandler } = await import("./positionCycleMarks.js");

const testDb: Knex = db;

const runTag = String(Date.now() % 100_000_000);
const symbolPrefix = `CYM${runTag}`;
const dayMs = 86_400_000;

let server: Server;
let baseUrl: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];

beforeAll(async () => {
  const app = express();
  app.get("/cycles/marks", getCycleMarksHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const legIds = (await testDb("position_legs").whereIn("position_id", createdPositionIds).select("id")).map((row) => row.id);
  await testDb("trades").whereIn("position_leg_id", legIds).del();
  await testDb("position_pnl_snapshots").whereIn("position_id", createdPositionIds).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

async function createTicker(letter: string, closeBars: { daysAgo: number; close: number }[] = []): Promise<{ id: string; symbol: string }> {
  const symbol = `${symbolPrefix}${letter}`;
  const [ticker] = await testDb("tickers").insert({ symbol }).returning("id");
  createdTickerIds.push(ticker.id);
  for (const bar of closeBars) {
    await testDb("daily_price_bars").insert({ ticker_id: ticker.id, trading_date: testDb.raw("CURRENT_DATE - ?::int", [bar.daysAgo]), close_price: bar.close });
  }
  return { id: ticker.id, symbol };
}

async function readDateIsoDaysAgo(daysAgo: number): Promise<string> {
  const result = await testDb.raw("SELECT to_char(CURRENT_DATE - ?::int, 'YYYY-MM-DD') AS iso", [daysAgo]);
  return result.rows[0].iso;
}

async function createClosedPosition(tickerId: string, strategyKey: string): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  return position.id;
}

async function insertOptionLeg(positionId: string, leg: { side: "long" | "short"; optionType: "call" | "put"; strike: number; quantity: number; entryPrice: number; entryDaysAgo: number; exit?: { price: number; daysAgo: number } }): Promise<string> {
  const [row] = await testDb("position_legs")
    .insert({
      position_id: positionId,
      leg_type: "option",
      side: leg.side,
      option_type: leg.optionType,
      strike_price: leg.strike,
      expiry_date: testDb.raw("CURRENT_DATE + 30"),
      quantity: leg.quantity,
      multiplier: 100,
      entry_price: leg.entryPrice,
      entry_at: new Date(Date.now() - leg.entryDaysAgo * dayMs),
      exit_price: leg.exit?.price ?? null,
      exit_at: leg.exit ? new Date(Date.now() - leg.exit.daysAgo * dayMs) : null,
    })
    .returning("id");
  return row.id;
}

async function insertOpenStockLegWithBuyFill(positionId: string, quantity: number, price: number, entryDaysAgo: number): Promise<void> {
  const entryAt = new Date(Date.now() - entryDaysAgo * dayMs);
  const [leg] = await testDb("position_legs")
    .insert({ position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, entry_price: price, entry_at: entryAt })
    .returning("id");
  await testDb("trades").insert({ position_leg_id: leg.id, side: "buy", quantity, price, executed_at: entryAt, is_closing_trade: false });
}

/** GET /cycles/marks with the given positions open for the duration of the request, closed again afterwards. */
async function getMarksWithOpenPositions(positionIds: string[]): Promise<{ status: number; json: Record<string, any> }> {
  await testDb("positions").whereIn("id", positionIds).update({ status: "open", closed_at: null });
  try {
    const response = await fetch(`${baseUrl}/cycles/marks`);
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  } finally {
    await testDb("positions").whereIn("id", positionIds).update({ status: "closed", closed_at: new Date() });
  }
}

const ownEntries = (marks: Record<string, unknown>) => Object.keys(marks).filter((symbol) => symbol.startsWith(symbolPrefix));

describe("GET cycle marks", () => {
  it("a short put with no nightly mark yet sits at its credit: total and option mark are the credit, no shares, marked at the last daily close", async () => {
    const ticker = await createTicker("A", [
      { daysAgo: 3, close: 51 },
      { daysAgo: 1, close: 52.5 },
    ]);
    const positionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(positionId, { side: "short", optionType: "put", strike: 50, quantity: 2, entryPrice: 1.5, entryDaysAgo: 3 });

    const { status, json } = await getMarksWithOpenPositions([positionId]);

    expect(status).toBe(200);
    expect(json[ticker.symbol]).toEqual({
      symbol: ticker.symbol,
      total: 300,
      sharesHeld: 0,
      markPrice: 52.5,
      markDate: await readDateIsoDaysAgo(1),
      optionMarks: { [positionId]: 300 },
      dataFlags: [],
    });
  });

  it("the latest nightly premium P&L of an open position becomes its option mark and moves the total by the difference from the credit", async () => {
    const ticker = await createTicker("B", [{ daysAgo: 1, close: 80 }]);
    const positionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(positionId, { side: "short", optionType: "put", strike: 75, quantity: 1, entryPrice: 2, entryDaysAgo: 5 });
    await testDb("position_pnl_snapshots").insert([
      { position_id: positionId, snapshot_date: testDb.raw("CURRENT_DATE - 3"), premium_pnl: 999 },
      { position_id: positionId, snapshot_date: testDb.raw("CURRENT_DATE - 1"), premium_pnl: 120 },
    ]);

    const { json } = await getMarksWithOpenPositions([positionId]);

    expect(json[ticker.symbol]).toMatchObject({ total: 120, optionMarks: { [positionId]: 120 }, sharesHeld: 0, dataFlags: [] });
  });

  it("shares with a covered call: the shares are marked at the last close, the call stays at its credit, shares held and the mark price are reported", async () => {
    const ticker = await createTicker("C", [{ daysAgo: 1, close: 44 }]);
    const positionId = await createClosedPosition(ticker.id, "covered_call");
    await insertOpenStockLegWithBuyFill(positionId, 100, 40, 10);
    await insertOptionLeg(positionId, { side: "short", optionType: "call", strike: 45, quantity: 1, entryPrice: 2, entryDaysAgo: 9 });

    const { json } = await getMarksWithOpenPositions([positionId]);

    // 100 sh bought at 40 and marked at 44 = +400 of stock result, plus the 200 credit of the call.
    expect(json[ticker.symbol]).toEqual({
      symbol: ticker.symbol,
      total: 600,
      sharesHeld: 100,
      markPrice: 44,
      markDate: await readDateIsoDaysAgo(1),
      optionMarks: { [positionId]: 200 },
      dataFlags: [],
    });
  });

  it("a hedge (long options only) with no nightly mark is carried at what it cost: a mark of 0 and a total of 0", async () => {
    const ticker = await createTicker("D", [{ daysAgo: 1, close: 90 }]);
    const positionId = await createClosedPosition(ticker.id, "hedge");
    await insertOptionLeg(positionId, { side: "long", optionType: "call", strike: 95, quantity: 1, entryPrice: 3, entryDaysAgo: 4 });

    const { json } = await getMarksWithOpenPositions([positionId]);

    expect(json[ticker.symbol]).toMatchObject({ total: 0, sharesHeld: 0, optionMarks: { [positionId]: 0 }, dataFlags: [] });
  });

  it("a ticker with no price bar has a null mark price and date", async () => {
    const ticker = await createTicker("E");
    const positionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(positionId, { side: "short", optionType: "put", strike: 20, quantity: 1, entryPrice: 0.5, entryDaysAgo: 2 });

    const { json } = await getMarksWithOpenPositions([positionId]);

    expect(json[ticker.symbol]).toMatchObject({ total: 50, markPrice: null, markDate: null, optionMarks: { [positionId]: 50 } });
  });

  it("shares held with no price to mark them are flagged instead of guessed", async () => {
    const ticker = await createTicker("F");
    const positionId = await createClosedPosition(ticker.id, "unstructured");
    await insertOpenStockLegWithBuyFill(positionId, 50, 10, 6);

    const { json } = await getMarksWithOpenPositions([positionId]);

    expect(json[ticker.symbol]).toMatchObject({ sharesHeld: 50, markPrice: null, dataFlags: ["no price to mark the shares still held"] });
  });

  it("two open positions on one ticker give one entry with a mark per position; one with a nightly mark, the other at its credit", async () => {
    const ticker = await createTicker("G", [{ daysAgo: 1, close: 60 }]);
    const markedPositionId = await createClosedPosition(ticker.id, "cash_secured_put");
    const unmarkedPositionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(markedPositionId, { side: "short", optionType: "put", strike: 55, quantity: 1, entryPrice: 1, entryDaysAgo: 4 });
    await insertOptionLeg(unmarkedPositionId, { side: "short", optionType: "put", strike: 50, quantity: 2, entryPrice: 0.75, entryDaysAgo: 4 });
    await testDb("position_pnl_snapshots").insert({ position_id: markedPositionId, snapshot_date: testDb.raw("CURRENT_DATE - 1"), premium_pnl: 40 });

    const { json } = await getMarksWithOpenPositions([markedPositionId, unmarkedPositionId]);

    expect(ownEntries(json).filter((symbol) => symbol === ticker.symbol)).toHaveLength(1);
    // Credits: 100 + 150 = 250; the marked position is 60 below its credit.
    expect(json[ticker.symbol]).toMatchObject({ total: 190, optionMarks: { [markedPositionId]: 40, [unmarkedPositionId]: 150 } });
  });

  it("an earlier closed cycle on the ticker does not count: only the open cycle's numbers come back", async () => {
    const ticker = await createTicker("H", [{ daysAgo: 1, close: 30 }]);
    const earlierPositionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(earlierPositionId, { side: "short", optionType: "put", strike: 25, quantity: 1, entryPrice: 1, entryDaysAgo: 60, exit: { price: 0.2, daysAgo: 50 } });
    const currentPositionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(currentPositionId, { side: "short", optionType: "put", strike: 28, quantity: 1, entryPrice: 1.25, entryDaysAgo: 3 });

    const { json } = await getMarksWithOpenPositions([currentPositionId]);

    expect(json[ticker.symbol]).toMatchObject({ total: 125, sharesHeld: 0, optionMarks: { [currentPositionId]: 125 }, dataFlags: [] });
  });

  it("a ticker whose position is closed is not in the response, even when a leg is still open", async () => {
    const ticker = await createTicker("I", [{ daysAgo: 1, close: 10 }]);
    const positionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(positionId, { side: "short", optionType: "put", strike: 9, quantity: 1, entryPrice: 0.3, entryDaysAgo: 2 });

    const { status, json } = await getMarksWithOpenPositions([]);

    expect(status).toBe(200);
    expect(json[ticker.symbol]).toBeUndefined();
  });

  it("answers with one object keyed by symbol", async () => {
    const ticker = await createTicker("J", [{ daysAgo: 1, close: 10 }]);
    const positionId = await createClosedPosition(ticker.id, "cash_secured_put");
    await insertOptionLeg(positionId, { side: "short", optionType: "put", strike: 9, quantity: 1, entryPrice: 0.3, entryDaysAgo: 2 });

    const { json } = await getMarksWithOpenPositions([positionId]);

    expect(Array.isArray(json)).toBe(false);
    for (const [symbol, marks] of Object.entries(json)) expect(marks.symbol).toBe(symbol);
  });
});
