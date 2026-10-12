import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Runs the real positions SQL against the test database (same convention as ibkrGatewayReconcilePositions.test.ts).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run position query tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { fetchPositionById } = await import("./positionQueries.js");

const testDb: Knex = db;
const createdTickerIds: string[] = [];
let tickerCounter = Date.now() % 100_000;

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `PQ${(tickerCounter += 1)}`, company_name: "Position Query Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

// Inserted as closed on purpose: the reconciliation tests share this database, and their pass closes any status 'open' position
// that has no open leg, which is exactly what this one is for the moment between inserting it and inserting its legs.
async function insertPosition(tickerId: string, strategyKey: string): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning(["id"]);
  return position.id;
}

async function insertStockLeg(positionId: string, quantity: number, entryPrice: number, exitPrice: number | null): Promise<void> {
  await testDb("position_legs").insert({
    position_id: positionId,
    leg_type: "stock",
    side: "long",
    quantity,
    multiplier: 1,
    entry_price: entryPrice,
    entry_at: new Date(Date.now() - 86_400_000),
    exit_price: exitPrice,
    exit_at: exitPrice === null ? null : new Date(),
  });
}

afterAll(async () => {
  const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("id", positionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

describe("positionSelect — capitalAtRisk (exposed now) vs capitalDeployed (base for P&L %)", () => {
  it("a position that sold part of its shares: exposure is the shares still held, the P&L % base also counts the sold slices", async () => {
    const positionId = await insertPosition(await createTicker(), "unstructured");
    await insertStockLeg(positionId, 80, 40, 42);
    await insertStockLeg(positionId, 80, 40, 42.5);
    await insertStockLeg(positionId, 40, 40, null);

    const position = await fetchPositionById(positionId);
    expect(Number(position!.capitalAtRisk)).toBe(1600);
    expect(Number(position!.capitalDeployed)).toBe(8000);
  });

  it("a position that sold nothing: the two are the same", async () => {
    const positionId = await insertPosition(await createTicker(), "unstructured");
    await insertStockLeg(positionId, 100, 55.5, null);

    const position = await fetchPositionById(positionId);
    expect(Number(position!.capitalAtRisk)).toBe(5550);
    expect(Number(position!.capitalDeployed)).toBe(5550);
  });

  it("a short put bought back in slices: exposure is the open contracts' collateral less their premium, the P&L % base is all contracts of that strike and expiry", async () => {
    const positionId = await insertPosition(await createTicker(), "cash_secured_put");
    const optionLeg = (quantity: number, strikePrice: number, expiryDate: string, exitPrice: number | null) => ({
      position_id: positionId,
      leg_type: "option",
      side: "short",
      quantity,
      option_type: "put",
      strike_price: strikePrice,
      expiry_date: expiryDate,
      multiplier: 100,
      entry_price: 2,
      entry_at: new Date(Date.now() - 86_400_000),
      exit_price: exitPrice,
      exit_at: exitPrice === null ? null : new Date(),
    });
    await testDb("position_legs").insert([optionLeg(2, 300, "2030-01-18", 0.8), optionLeg(3, 300, "2030-01-18", null)]);

    const position = await fetchPositionById(positionId);
    // ($300 strike − $2 premium) × 100 × 3 open contracts; × 5 contracts for the base.
    expect(Number(position!.capitalAtRisk)).toBe(89400);
    expect(Number(position!.capitalDeployed)).toBe(149000);
  });

  it("a leg of another strike or expiry (rolled away) is a different contract and stays out of the base", async () => {
    const positionId = await insertPosition(await createTicker(), "cash_secured_put");
    const optionLeg = (quantity: number, strikePrice: number, expiryDate: string, exitPrice: number | null) => ({
      position_id: positionId,
      leg_type: "option",
      side: "short",
      quantity,
      option_type: "put",
      strike_price: strikePrice,
      expiry_date: expiryDate,
      multiplier: 100,
      entry_price: 2,
      entry_at: new Date(Date.now() - 86_400_000),
      exit_price: exitPrice,
      exit_at: exitPrice === null ? null : new Date(),
    });
    await testDb("position_legs").insert([optionLeg(2, 290, "2030-01-11", 1), optionLeg(2, 300, "2030-01-18", 0.8), optionLeg(3, 300, "2030-01-18", null)]);

    const position = await fetchPositionById(positionId);
    expect(Number(position!.capitalDeployed)).toBe(149000);
  });

  const shortCall = (positionId: string, strikePrice: number, entryPrice: number, exitPrice: number | null, entryDaysAgo: number) => ({
    position_id: positionId,
    leg_type: "option",
    side: "short",
    quantity: 1,
    option_type: "call",
    strike_price: strikePrice,
    expiry_date: "2030-01-18",
    multiplier: 100,
    entry_price: entryPrice,
    entry_at: new Date(Date.now() - entryDaysAgo * 86_400_000),
    exit_price: exitPrice,
    exit_at: exitPrice === null ? null : new Date(),
  });

  it("a covered call: exposure and base are the shares' cost less the open call's premium, not an earlier call's", async () => {
    const positionId = await insertPosition(await createTicker(), "covered_call");
    await insertStockLeg(positionId, 100, 50, null);
    await testDb("position_legs").insert([shortCall(positionId, 52, 1, 0.2, 3), shortCall(positionId, 55, 1.5, null, 1)]);

    const position = await fetchPositionById(positionId);
    expect(Number(position!.capitalAtRisk)).toBe(4850);
    expect(Number(position!.capitalDeployed)).toBe(4850);
  });

  it("shares with no call open: exposure is their cost; a closed covered call's base keeps the call it ended with", async () => {
    const positionId = await insertPosition(await createTicker(), "covered_call");
    await insertStockLeg(positionId, 100, 50, null);
    await testDb("position_legs").insert(shortCall(positionId, 55, 1.5, 0.1, 1));
    expect(Number((await fetchPositionById(positionId))!.capitalAtRisk)).toBe(5000);

    const calledAway = await insertPosition(await createTicker(), "covered_call");
    await insertStockLeg(calledAway, 100, 50, 55);
    await testDb("position_legs").insert(shortCall(calledAway, 55, 1.5, 0, 1));
    expect(Number((await fetchPositionById(calledAway))!.capitalDeployed)).toBe(4850);
  });
});
