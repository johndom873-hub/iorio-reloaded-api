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

  it("a short put bought back in slices: exposure is the open contracts' collateral, the P&L % base is all contracts of that strike and expiry", async () => {
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
    expect(Number(position!.capitalAtRisk)).toBe(90000);
    expect(Number(position!.capitalDeployed)).toBe(150000);
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
    expect(Number(position!.capitalDeployed)).toBe(150000);
  });
});
