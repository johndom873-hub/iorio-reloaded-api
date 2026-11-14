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
const { easternInstant } = await import("./easternIsoDate.js");

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
    await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).del();
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

describe("expiry settlement audit — legs the worker already writes at the true cost", () => {
  it("a stock leg already at the put's strike needs no correction and is not reported", async () => {
    const tickerId = await createTicker();
    const putExitAt = daysAgo(2);
    const { positionId: putPositionId } = await insertAssignedPut(tickerId, 295.83, putExitAt);
    const leftoverPositionId = await insertPosition(tickerId, "unstructured", "closed_via_app");
    await insertStockLeg(leftoverPositionId, 100, 317.5, new Date(putExitAt.getTime() + 8_000), 279.864, daysAgo(1));

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === putPositionId)).toEqual([]);
  });

  it("a blended leg already at the true blended cost needs no correction and is not reported", async () => {
    const tickerId = await createTicker();
    const { putPositionId, blendedLegId } = await seedBlendedAssignment(tickerId, 200, 322.4955);

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === putPositionId)).toEqual([]);
    expect(Number((await testDb("position_legs").where({ id: blendedLegId }).first()).entry_price)).toBe(322.4955);
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

async function insertExpiredShortOption(positionId: string, optionType: "call" | "put", strike: number, contracts: number, expiryDate: string, exitAt: Date): Promise<string> {
  const [leg] = await testDb("position_legs")
    .insert({ position_id: positionId, leg_type: "option", side: "short", quantity: contracts, option_type: optionType, strike_price: strike, expiry_date: expiryDate, multiplier: 100, entry_price: 1.5, entry_at: daysAgo(10), exit_price: 0, exit_at: exitAt })
    .returning(["id"]);
  return leg.id;
}

let auditTradeCounter = 0;
async function insertTrade(legId: string, trade: { side: "buy" | "sell"; quantity: number; price: number; executedAt: Date; ibkrOrderId: string; sourceOrderRequestId?: string }): Promise<void> {
  await testDb("trades").insert({
    position_leg_id: legId,
    ibkr_exec_id: `audit-test-${Date.now()}-${(auditTradeCounter += 1)}`,
    ibkr_order_id: trade.ibkrOrderId,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    executed_at: trade.executedAt,
    is_closing_trade: true,
    source_order_request_id: trade.sourceOrderRequestId ?? null,
  });
}

const closeReasonOf = async (positionId: string) => (await testDb("positions").where({ id: positionId }).first("close_reason")).close_reason;

describe("expiry settlement audit — IBKR's $0 settlement record is not a closing trade (Marcelo 2026-11-02)", () => {
  it("TSLA: a $365 Call settled by IBKR (option at $0, shares sold at $365) and closed at $372.22 is relabelled assigned", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 372.22 });
    const coveredCallId = await insertPosition(tickerId, "covered_call", "expired_worthless");
    const settledAt = daysAgo(2);
    const stockLegId = await insertStockLeg(coveredCallId, 100, 364.361169, daysAgo(10), 365, settledAt);
    const callLegId = await insertExpiredShortOption(coveredCallId, "call", 365, 1, expiryDate, settledAt);
    await insertTrade(callLegId, { side: "buy", quantity: 1, price: 0, executedAt: settledAt, ibkrOrderId: "0" });
    await insertTrade(stockLegId, { side: "sell", quantity: 100, price: 365, executedAt: settledAt, ibkrOrderId: "0" });

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === coveredCallId).map((action) => action.kind)).toEqual(["close_reason"]);
    expect(await closeReasonOf(coveredCallId)).toBe("assigned");
  });

  it("NVDA: a Covered Call whose stock leg grew that day (300 sh, then a new 400-sh leg) is called away on the 400 only, and relabelled assigned", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 162.85 });
    const coveredCallId = await insertPosition(tickerId, "covered_call", "expired_worthless");
    const settledAt = daysAgo(2);
    const grewAt = new Date(settledAt.getTime() - 12 * 3_600_000); // 10:05 ET, settled 21:44 ET (staging, 13 Nov)
    const replacedLegId = await insertStockLeg(coveredCallId, 300, 198.4743045, grewAt, 198.4743045, grewAt);
    await testDb("position_legs").where({ id: replacedLegId }).update({ entry_at: daysAgo(4) });
    const calledAwayLegId = await insertStockLeg(coveredCallId, 400, 198.4743045, grewAt, 198.4743045, settledAt);
    await insertExpiredShortOption(coveredCallId, "call", 162.5, 4, expiryDate, settledAt);
    await insertTrade(calledAwayLegId, { side: "sell", quantity: 400, price: 162.5, executedAt: settledAt, ibkrOrderId: "0" });

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === coveredCallId).map((action) => action.kind)).toEqual(["call_away_stock_exit", "close_reason"]);
    expect(Number((await testDb("position_legs").where({ id: calledAwayLegId }).first()).exit_price)).toBe(162.5);
    expect(Number((await testDb("position_legs").where({ id: replacedLegId }).first()).exit_price)).toBe(198.4743045);
    expect(await closeReasonOf(coveredCallId)).toBe("assigned");
  });

  it("a Call bought back (a real fill, by an app order or not) is still not examined", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 120 });
    const coveredCallId = await insertPosition(tickerId, "covered_call", "closed_via_external_trade");
    const callLegId = await insertExpiredShortOption(coveredCallId, "call", 110, 1, expiryDate, daysAgo(4));
    await insertTrade(callLegId, { side: "buy", quantity: 1, price: 0, executedAt: daysAgo(4), ibkrOrderId: "4242" });

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === coveredCallId)).toEqual([]);
    expect(await closeReasonOf(coveredCallId)).toBe("closed_via_external_trade");
  });
});

describe("expiry settlement audit — a Call in the money that was not exercised (Marcelo 2026-11-14)", () => {
  /** NVDA on prod, 13 Nov: 9 × $162.50 Calls, close $162.85, IBKR's $0 expiry record and no share sale; the reconcile handed the 900 shares to a new position. */
  async function seedUnexercisedCall(closeReason: string, handOffShares: number | null) {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 162.85 });
    const coveredCallId = await insertPosition(tickerId, "covered_call", closeReason);
    const settledAt = daysAgo(2);
    const stockLegId = await insertStockLeg(coveredCallId, 900, 169.845003, daysAgo(4), 169.845003, settledAt);
    const callLegId = await insertExpiredShortOption(coveredCallId, "call", 162.5, 9, expiryDate, settledAt);
    await insertTrade(callLegId, { side: "buy", quantity: 9, price: 0, executedAt: settledAt, ibkrOrderId: "0" });
    if (handOffShares !== null) {
      const keptSharesId = (await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: tickerId, status: "open" }).returning(["id"]))[0].id;
      await insertStockLeg(keptSharesId, 900, 169.845003, settledAt, null, null);
      await testDb("position_share_sources").insert({ position_id: keptSharesId, source_position_id: coveredCallId, shares_received: handOffShares, created_at: settledAt });
    }
    return { coveredCallId, stockLegId };
  }
  const stockExitOf = async (legId: string) => Number((await testDb("position_legs").where({ id: legId }).first()).exit_price);

  it("shares handed to another position, no sale at the strike: stays expired_worthless, its shares are not called away", async () => {
    const { coveredCallId, stockLegId } = await seedUnexercisedCall("expired_worthless", 900);
    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === coveredCallId)).toEqual([]);
    expect(await closeReasonOf(coveredCallId)).toBe("expired_worthless");
    expect(await stockExitOf(stockLegId)).toBe(169.845003);
  });

  it("the same Call labelled assigned is relabelled expired_worthless, and a second run changes nothing", async () => {
    const { coveredCallId, stockLegId } = await seedUnexercisedCall("assigned", 900);
    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === coveredCallId).map((action) => action.kind)).toEqual(["close_reason"]);
    expect(await closeReasonOf(coveredCallId)).toBe("expired_worthless");
    expect(await stockExitOf(stockLegId)).toBe(169.845003);
    const secondRun = await runExpirySettlementAudit("apply", testDb);
    expect(secondRun.actions.filter((action) => action.positionId === coveredCallId)).toEqual([]);
  });

  it("no sale at the strike and the shares not handed over (or only some of them): reported for review, nothing changed", async () => {
    for (const handOffShares of [null, 400]) {
      const { coveredCallId, stockLegId } = await seedUnexercisedCall("expired_worthless", handOffShares);
      const result = await runExpirySettlementAudit("apply", testDb);
      expect(result.actions.filter((action) => action.positionId === coveredCallId).map((action) => action.kind)).toEqual(["skipped"]);
      expect(await closeReasonOf(coveredCallId)).toBe("expired_worthless");
      expect(await stockExitOf(stockLegId)).toBe(169.845003);
    }
  });
});

describe("expiry settlement audit — an option is examined from 16:00 Eastern on its expiry date", () => {
  it("a Put settled the same evening is examined at 22:15 Eastern, not at 15:59", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 90 });
    const putPositionId = await insertPosition(tickerId, "cash_secured_put", "expired_worthless");
    await insertExpiredShortOption(putPositionId, "put", 100, 1, expiryDate, daysAgo(3));
    const actionKindsAt = async (hour: number, minute: number) =>
      (await runExpirySettlementAudit("dry_run", testDb, easternInstant(expiryDate, hour, minute))).actions.filter((action) => action.positionId === putPositionId).map((action) => action.kind);

    expect(await actionKindsAt(15, 59)).toEqual([]);
    expect(await actionKindsAt(22, 15)).toContain("close_reason");
  });
});

describe("expiry settlement audit — an out-of-the-money option labelled assigned (Marcelo 2026-11-02)", () => {
  async function seedTwoNvdaPuts(tickerId: string) {
    const expiryDate = isoDate(daysAgo(3));
    const settledAt = daysAgo(2);
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 214.13 });
    const assignedPutId = await insertPosition(tickerId, "cash_secured_put", "assigned");
    const assignedPutLegId = await insertExpiredShortOption(assignedPutId, "put", 220, 2, expiryDate, settledAt);
    await insertTrade(assignedPutLegId, { side: "buy", quantity: 2, price: 0, executedAt: settledAt, ibkrOrderId: "0" });
    const expiredPutId = await insertPosition(tickerId, "cash_secured_put", "assigned");
    const expiredPutLegId = await insertExpiredShortOption(expiredPutId, "put", 212.5, 2, expiryDate, settledAt);
    await insertTrade(expiredPutLegId, { side: "buy", quantity: 2, price: 0, executedAt: settledAt, ibkrOrderId: "0" });
    const leftoverId = await insertPosition(tickerId, "unstructured", null);
    await testDb("positions").where({ id: leftoverId }).update({ status: "open", closed_at: null });
    const leftoverStockLegId = await insertStockLeg(leftoverId, 200, 220, new Date(settledAt.getTime() + 5_000), null, null);
    await insertTrade(leftoverStockLegId, { side: "buy", quantity: 200, price: 220, executedAt: settledAt, ibkrOrderId: "0" });
    await testDb("trades").where({ position_leg_id: leftoverStockLegId }).update({ is_closing_trade: false });
    await testDb("position_share_sources").insert([
      { position_id: leftoverId, source_position_id: assignedPutId, shares_received: 200 },
      { position_id: leftoverId, source_position_id: expiredPutId, shares_received: 200 },
    ]);
    return { assignedPutId, expiredPutId, leftoverId, expiryDate };
  }

  it("NVDA: the $212.5 Put (close $214.13, no fill at $212.5) becomes expired_worthless and loses its share-source link; the $220 Put keeps both", async () => {
    const tickerId = await createTicker();
    const { assignedPutId, expiredPutId, leftoverId } = await seedTwoNvdaPuts(tickerId);

    const dryRun = await runExpirySettlementAudit("dry_run", testDb);
    expect(dryRun.actions.filter((action) => action.positionId === expiredPutId).map((action) => action.kind)).toEqual(["close_reason", "share_sources_removed"]);
    expect(await closeReasonOf(expiredPutId)).toBe("assigned");

    const applied = await runExpirySettlementAudit("apply", testDb);
    const removal = applied.actions.find((action) => action.positionId === expiredPutId && action.kind === "share_sources_removed")!;
    expect(removal.description).toContain(leftoverId);
    expect(await closeReasonOf(expiredPutId)).toBe("expired_worthless");
    expect(await closeReasonOf(assignedPutId)).toBe("assigned");
    expect((await testDb("position_share_sources").where({ position_id: leftoverId }).select("source_position_id")).map((row) => row.source_position_id)).toEqual([assignedPutId]);

    const secondRun = await runExpirySettlementAudit("apply", testDb);
    expect(secondRun.actions.filter((action) => action.positionId === expiredPutId)).toEqual([]);
  });

  it("a Put assigned early (its fill at the strike is recorded) keeps 'assigned' though the stock closed above the strike at expiry", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    const assignedAt = daysAgo(5);
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 60 });
    const putPositionId = await insertPosition(tickerId, "cash_secured_put", "assigned");
    await insertExpiredShortOption(putPositionId, "put", 50, 1, expiryDate, assignedAt);
    const leftoverId = await insertPosition(tickerId, "unstructured", null);
    const stockLegId = await insertStockLeg(leftoverId, 100, 50, assignedAt, 58, daysAgo(1));
    await insertTrade(stockLegId, { side: "buy", quantity: 100, price: 50, executedAt: new Date(assignedAt.getTime() - 60_000), ibkrOrderId: "0" });
    await testDb("trades").where({ position_leg_id: stockLegId }).update({ is_closing_trade: false });

    const result = await runExpirySettlementAudit("apply", testDb);
    expect(result.actions.filter((action) => action.positionId === putPositionId)).toEqual([]);
    expect(await closeReasonOf(putPositionId)).toBe("assigned");
  });

  it("a Put labelled assigned that closed less than $0.05 above its strike is left for review, not relabelled", async () => {
    const tickerId = await createTicker();
    const expiryDate = isoDate(daysAgo(3));
    await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: expiryDate, close_price: 50.03 });
    const putPositionId = await insertPosition(tickerId, "cash_secured_put", "assigned");
    await insertExpiredShortOption(putPositionId, "put", 50, 1, expiryDate, daysAgo(2));

    await runExpirySettlementAudit("apply", testDb);
    expect(await closeReasonOf(putPositionId)).toBe("assigned");
  });
});
