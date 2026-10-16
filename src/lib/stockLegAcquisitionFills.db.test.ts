import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Against the test database: what carried-over shares were really bought at, followed through hand-overs.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { fetchStockAcquisitionByPositionId } = await import("./stockLegAcquisitionFills.js");
const testDb: Knex = db;
const createdTickerIds: string[] = [];
let counter = 0;

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `AQ${Date.now() % 100_000}${(counter += 1)}`, company_name: "Acquisition Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return ticker.id;
}
async function position(tickerId: string, strategyKey: string, status = "open", closeReason: string | null = null): Promise<string> {
  const [row] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status, close_reason: closeReason }).returning(["id"]);
  return row.id;
}
async function stockLeg(positionId: string, quantity: number, entryPrice: number, closed = false): Promise<string> {
  const [row] = await testDb("position_legs")
    .insert({ position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, entry_price: entryPrice, entry_at: new Date(), ibkr_contract_id: "1", ...(closed ? { exit_at: new Date(), exit_price: entryPrice } : {}) })
    .returning(["id"]);
  return row.id;
}
async function buyFill(legId: string, quantity: number, price: number, commission: number | null): Promise<void> {
  await testDb("trades").insert({ position_leg_id: legId, ibkr_exec_id: `acquisition-test-${legId}-${(counter += 1)}`, side: "buy", quantity, price, commission, executed_at: new Date(), is_closing_trade: false });
}

afterAll(async () => {
  const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
  await testDb("position_share_sources").whereIn("position_id", positionIds).del();
  await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).del();
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("id", positionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

describe("fetchStockAcquisitionByPositionId", () => {
  it("INTC: the $98 Covered Call's shares came from the leftover position the $100 put's assignment filled at $100.00; the $94 one bought its own at $92.43", async () => {
    const tickerId = await createTicker();
    const cspId = await position(tickerId, "cash_secured_put", "closed", "assigned");
    await testDb("position_legs").insert({ position_id: cspId, leg_type: "option", side: "short", quantity: 2, multiplier: 100, option_type: "put", strike_price: 100, expiry_date: "2026-10-14", entry_price: 1.3358, entry_at: new Date(), exit_at: new Date(), exit_price: 0, ibkr_contract_id: "2" });
    const leftoverId = await position(tickerId, "unstructured", "closed");
    await buyFill(await stockLeg(leftoverId, 200, 100, true), 200, 100, null);
    const the98Id = await position(tickerId, "covered_call");
    await stockLeg(the98Id, 200, 100);
    const the94Id = await position(tickerId, "covered_call");
    await buyFill(await stockLeg(the94Id, 100, 92.440903), 100, 92.43, 1.0903);
    await testDb("position_share_sources").insert([
      { position_id: leftoverId, source_position_id: cspId, shares_received: 200 },
      { position_id: the98Id, source_position_id: leftoverId, shares_received: 200 },
    ]);

    const acquisitions = await fetchStockAcquisitionByPositionId([the98Id, the94Id]);
    expect(acquisitions.get(the98Id)).toEqual({ fillPrice: 100, commissionPerShare: 0 });
    expect(acquisitions.get(the94Id)!.fillPrice).toBeCloseTo(92.43, 10);
    expect(acquisitions.get(the94Id)!.commissionPerShare).toBeCloseTo(0.010903, 10);
  });

  it("a Covered Call on shares from two positions shows their share-weighted average; a put whose assignment fill is missing counts at its strike", async () => {
    const tickerId = await createTicker();
    const firstId = await position(tickerId, "unstructured", "closed");
    await buyFill(await stockLeg(firstId, 100, 50.01, true), 100, 50, 1);
    const cspId = await position(tickerId, "cash_secured_put", "closed", "assigned");
    await testDb("position_legs").insert({ position_id: cspId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "put", strike_price: 40, expiry_date: "2026-10-09", entry_price: 1, entry_at: new Date(), exit_at: new Date(), exit_price: 0, ibkr_contract_id: "3" });
    const coveredCallId = await position(tickerId, "covered_call");
    await stockLeg(coveredCallId, 200, 45);
    await testDb("position_share_sources").insert([
      { position_id: coveredCallId, source_position_id: firstId, shares_received: 100 },
      { position_id: coveredCallId, source_position_id: cspId, shares_received: 100 },
    ]);

    const acquisition = (await fetchStockAcquisitionByPositionId([coveredCallId])).get(coveredCallId)!;
    expect(acquisition.fillPrice).toBeCloseTo(45, 10);
    expect(acquisition.commissionPerShare).toBeCloseTo(0.005, 10);
  });
});
