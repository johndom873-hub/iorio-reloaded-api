import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Runs the real audit against the test database (same convention as ibkrGatewayReconcilePositions.test.ts).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { runExpirySettlementAudit, summarizeExpirySettlement } = await import("./expirySettlementAudit.js");

const testDb: Knex = db;
const createdTickerIds: string[] = [];
let tickerCounter = Date.now() % 100_000;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `AU${(tickerCounter += 1)}`, company_name: "Audit Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

async function insertPosition(tickerId: string, strategyKey: string, closeReason: string | null): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date(), close_reason: closeReason }).returning(["id"]);
  return position.id;
}

async function insertStockLeg(positionId: string, quantity: number, entryPrice: number, entryAt: Date, exitPrice: number | null, exitAt: Date | null): Promise<string> {
  const [leg] = await testDb("position_legs")
    .insert({ position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, entry_price: entryPrice, entry_at: entryAt, exit_price: exitPrice, exit_at: exitAt })
    .returning(["id"]);
  return leg.id;
}

/** A $317.5-style put that expired in the money and was assigned: closed at 0 with no closing trade. */
async function insertAssignedPut(tickerId: string, expiryClose: number, putExitAt: Date, acknowledged = false): Promise<{ legId: string; positionId: string }> {
  const positionId = await insertPosition(tickerId, "cash_secured_put", "assigned");
  const expiryDate = isoDate(daysAgo(3));
  await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: expiryClose });
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: positionId,
      leg_type: "option",
      side: "short",
      quantity: 1,
      option_type: "put",
      strike_price: 317.5,
      expiry_date: expiryDate,
      multiplier: 100,
      entry_price: 7.3471,
      entry_at: daysAgo(10),
      exit_price: 0,
      exit_at: putExitAt,
      settlement_audit_acknowledged_at: acknowledged ? new Date() : null,
    })
    .returning(["id"]);
  return { legId: leg.id, positionId };
}

/** The COHR sequence: a covered call expired with 100 shares retained (handed over at their own entry price), the put assigned 100 more, IBKR reports one 200-share leg at the blended cost. */
async function seedBlendedAssignment(tickerId: string, blendedLegShares: number, blendedEntry: number) {
  const putExitAt = daysAgo(2);
  const { legId: putLegId, positionId: putPositionId } = await insertAssignedPut(tickerId, 295.83, putExitAt);
  const coveredCallPositionId = await insertPosition(tickerId, "covered_call", "expired_worthless");
  const handoverAt = new Date(putExitAt.getTime() + 7_000);
  await insertStockLeg(coveredCallPositionId, 100, 327.4909, daysAgo(10), 327.4909, handoverAt);
  const leftoverPositionId = await insertPosition(tickerId, "unstructured", "closed_via_app");
  const blendedLegId = await insertStockLeg(leftoverPositionId, blendedLegShares, blendedEntry, new Date(putExitAt.getTime() + 8_000), 279.864, daysAgo(1));
  return { putLegId, putPositionId, blendedLegId };
}

beforeAll(() => {
  process.env.EXPIRY_SETTLEMENT_MODE ??= "dry_run";
});

afterAll(async () => {
  if (createdTickerIds.length > 0) {
    const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
    await testDb("position_legs").whereIn("position_id", positionIds).del();
    await testDb("positions").whereIn("id", positionIds).del();
    await testDb("daily_price_bars").whereIn("ticker_id", createdTickerIds).del();
    await testDb("tickers").whereIn("id", createdTickerIds).del();
  }
  await testDb.destroy();
});

describe("expiry settlement audit — assigned shares blended with shares already held", () => {
  it("COHR: corrects the blended entry so the put's premium is not counted twice, and a second run changes nothing", async () => {
    const tickerId = await createTicker();
    const { blendedLegId, putPositionId } = await seedBlendedAssignment(tickerId, 200, 318.8219);
    const actionsFor = <Action extends { positionId: string }>(result: { actions: Action[] }) => result.actions.filter((action) => action.positionId === putPositionId);
    const entryOf = async () => Number((await testDb("position_legs").where({ id: blendedLegId }).first()).entry_price);

    const dryRun = await runExpirySettlementAudit("dry_run", testDb);
    expect(actionsFor(dryRun).map((action) => action.kind)).toEqual(["put_assigned_stock_entry"]);
    expect(await entryOf()).toBe(318.8219);

    const applied = await runExpirySettlementAudit("apply", testDb);
    const change = actionsFor(applied);
    expect(change.map((action) => action.kind)).toEqual(["put_assigned_stock_entry"]);
    expect(change[0]!.description).toContain("blended with the 100 sh already held at $327.49");
    const corrected = await entryOf();
    expect(corrected).toBeCloseTo(322.4955, 3);
    // Sold at 279.864: the stock P&L drops by the premium that used to be baked into the cost (7.3471 x 100 shares).
    expect(change[0]!.pnlDelta).toBeCloseTo(-(corrected - 318.8219) * 200, 1);
    expect(change[0]!.pnlDelta).toBeCloseTo(-734.7, 0);

    const secondRun = await runExpirySettlementAudit("apply", testDb);
    expect(actionsFor(secondRun)).toEqual([]);
    expect(await entryOf()).toBe(corrected);
  });

  it("does not claim a leg whose share counts do not add up (150 sh cannot be 100 held + 100 assigned): reported for review", async () => {
    const tickerId = await createTicker();
    const { blendedLegId, putPositionId } = await seedBlendedAssignment(tickerId, 150, 318.8219);

    const result = await runExpirySettlementAudit("apply", testDb);
    const own = result.actions.filter((action) => action.positionId === putPositionId);
    expect(own.map((action) => action.kind)).toEqual(["skipped"]);
    expect(own[0]!.detail).toContain("assigned shares not tracked as a leg");
    expect(Number((await testDb("position_legs").where({ id: blendedLegId }).first()).entry_price)).toBe(318.8219);
  });

  it("does not claim a leg whose entry is neither the blended cost nor the corrected one", async () => {
    const tickerId = await createTicker();
    const { blendedLegId, putPositionId } = await seedBlendedAssignment(tickerId, 200, 330.0);

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === putPositionId).map((action) => action.kind)).toEqual(["skipped"]);
    expect(Number((await testDb("position_legs").where({ id: blendedLegId }).first()).entry_price)).toBe(330);
  });
});

describe("expiry settlement audit — acknowledged legs", () => {
  it("a leg a person has acknowledged is neither examined nor reported; the same leg unacknowledged is", async () => {
    const tickerId = await createTicker();
    const { legId, positionId } = await insertAssignedPut(tickerId, 295.83, daysAgo(2), true);

    const whileAcknowledged = await runExpirySettlementAudit("dry_run", testDb);
    expect(whileAcknowledged.actions.filter((action) => action.positionId === positionId)).toEqual([]);

    await testDb("position_legs").where({ id: legId }).update({ settlement_audit_acknowledged_at: null });
    const afterwards = await runExpirySettlementAudit("dry_run", testDb);
    expect(afterwards.actions.filter((action) => action.positionId === positionId).map((action) => action.kind)).toEqual(["skipped"]);
  });
});
