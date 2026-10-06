import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// The position lifecycle feed against the real positions, legs, trades and order tables of the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the position events tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { fetchPositionEvents } = await import("./positionEvents.js");
const testDb: Knex = db;

const createdTickerIds: string[] = [];
const createdUserIds: string[] = [];
let counter = Date.now() % 100_000;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `PE${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Position Events Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return { id: ticker.id, symbol };
}

async function createUser(displayName: string): Promise<string> {
  const [user] = await testDb("users").insert({ username: `pe_user_${(counter += 1)}`, display_name: displayName, password_hash: "x" }).returning(["id"]);
  createdUserIds.push(user.id);
  return user.id;
}

interface PositionOptions {
  strategyKey: string;
  openedAt?: Date;
  closedAt?: Date | null;
  closeReason?: string | null;
  unstructuredReason?: string | null;
}

async function createPosition(options: PositionOptions): Promise<{ positionId: string; symbol: string }> {
  const ticker = await createTicker();
  const [position] = await testDb("positions")
    .insert({
      strategy_key: options.strategyKey,
      ticker_id: ticker.id,
      status: options.closedAt ? "closed" : "open",
      opened_at: options.openedAt ?? new Date(),
      closed_at: options.closedAt ?? null,
      close_reason: options.closeReason ?? null,
      unstructured_reason: options.unstructuredReason ?? null,
    })
    .returning(["id"]);
  return { positionId: position.id, symbol: ticker.symbol };
}

interface LegOptions {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  exitAt?: Date | null;
  optionType?: "call" | "put";
  strikePrice?: number;
  expiryDate?: string;
}

async function insertLeg(positionId: string, leg: LegOptions): Promise<string> {
  const isOption = leg.legType === "option";
  const exitPrice = leg.exitPrice ?? null;
  const [row] = await testDb("position_legs")
    .insert({
      position_id: positionId,
      leg_type: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      multiplier: isOption ? 100 : 1,
      option_type: isOption ? (leg.optionType ?? "call") : null,
      strike_price: isOption ? (leg.strikePrice ?? 100) : null,
      expiry_date: isOption ? (leg.expiryDate ?? "2031-01-17") : null,
      entry_price: leg.entryPrice,
      entry_at: daysAgo(10),
      exit_price: exitPrice,
      exit_at: leg.exitAt !== undefined ? leg.exitAt : exitPrice === null ? null : new Date(),
    })
    .returning(["id"]);
  return row.id;
}

async function eventsFor(symbol: string, sinceDays?: number) {
  const events = await fetchPositionEvents(500, sinceDays);
  return events.filter((event) => event.symbol === symbol);
}

afterAll(async () => {
  const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
  const legIds = (await testDb("position_legs").whereIn("position_id", positionIds).select("id")).map((row) => row.id);
  await testDb("trades").whereIn("position_leg_id", legIds).del();
  await testDb("order_requests").whereIn("requested_by_user_id", createdUserIds).del();
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("id", positionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").whereIn("id", createdUserIds).del();
  await testDb.destroy();
});

describe("fetchPositionEvents: an opened position", () => {
  it("covered call: net cash is the premium sold minus the stock bought, and the value is stock minus the short call", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50 });
    await insertLeg(positionId, { legType: "option", side: "short", quantity: 1, entryPrice: 2, optionType: "call", strikePrice: 55 });

    const events = await eventsFor(symbol);
    expect(events).toHaveLength(1);
    const [opened] = events;
    expect(opened).toMatchObject({ eventType: "opened", strategyKey: "covered_call", closeReason: null, realizedPnl: null, attributedTo: null });
    // stock: -(50 x 100 shares) = -5000; short call: +(2 x 100 multiplier x 1 contract) = +200
    expect(opened!.netCashEffect).toBe(-4800);
    // stock: +5000; short call: -200
    expect(opened!.fullMarketValue).toBe(4800);
    expect(opened!.legs).toHaveLength(2);
    expect(opened!.legs.find((leg) => leg.legType === "option")).toMatchObject({ side: "short", optionType: "call", strikePrice: 55, expiryDate: "2031-01-17", entryPrice: 2, exitPrice: null });
  });

  it("cash-secured put: the collateral (strike x 100 x contracts) is added to the value but not to the cash effect", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put" });
    await insertLeg(positionId, { legType: "option", side: "short", quantity: 2, entryPrice: 1.5, optionType: "put", strikePrice: 100 });

    const [opened] = await eventsFor(symbol);
    // premium sold: 1.5 x 100 x 2 = 300
    expect(opened!.netCashEffect).toBe(300);
    // short put value -300 plus collateral 100 x 100 x 2 = 20000
    expect(opened!.fullMarketValue).toBe(19700);
  });

  it("hedge: a long option is a cash outflow and a positive value", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "hedge" });
    await insertLeg(positionId, { legType: "option", side: "long", quantity: 1, entryPrice: 3, optionType: "call" });

    const [opened] = await eventsFor(symbol);
    expect(opened!.netCashEffect).toBe(-300);
    expect(opened!.fullMarketValue).toBe(300);
  });

  it("a strategy outside the valued set has no market value", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "wheel_experiment" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 10, entryPrice: 10 });
    const [opened] = await eventsFor(symbol);
    expect(opened!.fullMarketValue).toBeNull();
  });

  it("partial-close slices of one contract read as a single leg in the opened event but stay apart in the closed event", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", closedAt: new Date(), closeReason: "closed_by_user" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 60, entryPrice: 50, exitPrice: 52 });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 40, entryPrice: 50, exitPrice: 53 });

    const events = await eventsFor(symbol);
    const opened = events.find((event) => event.eventType === "opened")!;
    const closed = events.find((event) => event.eventType === "closed")!;
    expect(opened.legs).toHaveLength(1);
    expect(opened.legs[0]).toMatchObject({ quantity: 100, exitPrice: null });
    expect(closed.legs.map((leg) => leg.quantity).sort()).toEqual([40, 60]);
  });
});

describe("fetchPositionEvents: a closed position", () => {
  it("realized P&L sums each leg's exit-minus-entry with the short side reversed, net of closing commissions", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", closedAt: new Date(), closeReason: "expired" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50, exitPrice: 55 });
    const callLegId = await insertLeg(positionId, { legType: "option", side: "short", quantity: 1, entryPrice: 2, exitPrice: 0.5, optionType: "call", strikePrice: 55 });
    await testDb("trades").insert({ position_leg_id: callLegId, side: "buy", quantity: 1, price: 0.5, executed_at: new Date(), is_closing_trade: true, commission: 1.3 });

    const events = await eventsFor(symbol);
    expect(events.map((event) => event.eventType).sort()).toEqual(["closed", "opened"]);
    const closed = events.find((event) => event.eventType === "closed")!;
    expect(closed.closeReason).toBe("expired");
    // stock: (55 - 50) x 100 = +500; short call: (0.5 - 2) x 100 x -1 = +150; commission -1.30
    expect(closed.realizedPnl).toBeCloseTo(648.7, 6);
    // stock 55 x 100 = 5500; short call -(0.5 x 100) = -50
    expect(closed.fullMarketValue).toBe(5450);
    expect(closed.netCashEffect).toBeNull();
    expect(closed.openedAt).toBe(events.find((event) => event.eventType === "opened")!.openedAt);
  });

  it("an exit with no recorded price makes P&L and value null, not a misleading $0", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", closedAt: new Date(), closeReason: "closed_by_user" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50, exitPrice: 55 });
    await insertLeg(positionId, { legType: "option", side: "short", quantity: 1, entryPrice: 2, exitPrice: null, exitAt: new Date() });

    const closed = (await eventsFor(symbol)).find((event) => event.eventType === "closed")!;
    expect(closed.realizedPnl).toBeNull();
    expect(closed.fullMarketValue).toBeNull();
  });

  it("a leg with no exit at all (still held) counts for nothing in realized P&L", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: "other", closedAt: new Date(), closeReason: "sold" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 10, entryPrice: 40, exitPrice: 42 });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 5, entryPrice: 40, exitPrice: null, exitAt: null });

    const closed = (await eventsFor(symbol)).find((event) => event.eventType === "closed")!;
    expect(closed.realizedPnl).toBe(20);
  });
});

describe("fetchPositionEvents: unstructured leftover-stock positions", () => {
  it("shows an unstructured position as its own event, with a value but no cash effect", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: "manual_stock_buy" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 40 });

    const events = await eventsFor(symbol);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "unstructured", unstructuredReason: "manual_stock_buy", netCashEffect: null, fullMarketValue: 4000 });
  });

  it.each(["csp_assigned_stock", "cc_expired_leftover_stock"])("hides the open of a leftover position that only exists because of another event (%s)", async (reason) => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: reason });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 40 });
    expect(await eventsFor(symbol)).toEqual([]);
  });

  it("still shows the close of a leftover position whose shares were actually sold", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: "csp_assigned_stock", closedAt: new Date(), closeReason: "sold" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 40, exitPrice: 44 });

    const events = await eventsFor(symbol);
    expect(events.map((event) => event.eventType)).toEqual(["closed"]);
    expect(events[0]!.realizedPnl).toBe(400);
  });

  it("hides the close of a leftover position whose shares were rolled into a covered call", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: "manual_stock_buy", closedAt: new Date(), closeReason: "stock_rolled_into_covered_call" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 40, exitPrice: 40 });

    expect((await eventsFor(symbol)).map((event) => event.eventType)).toEqual(["unstructured"]);
  });
});

describe("fetchPositionEvents: window, order and limit", () => {
  it("leaves out a position opened and closed before the window, and includes it with a wider window", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", openedAt: daysAgo(30), closedAt: daysAgo(29), closeReason: "expired" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50, exitPrice: 51 });

    expect(await eventsFor(symbol)).toEqual([]);
    expect((await eventsFor(symbol, 60)).map((event) => event.eventType).sort()).toEqual(["closed", "opened"]);
  });

  it("includes an old position that closed recently, with its original open date", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", openedAt: daysAgo(30), closedAt: new Date(), closeReason: "expired" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50, exitPrice: 51 });

    const closed = (await eventsFor(symbol)).find((event) => event.eventType === "closed")!;
    expect(new Date(closed.openedAt).getTime()).toBeLessThan(daysAgo(29).getTime());
  });

  it("sorts newest first and applies the limit to the events, not the positions", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call", openedAt: daysAgo(3), closedAt: daysAgo(1), closeReason: "expired" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50, exitPrice: 51 });

    const all = await fetchPositionEvents(500, 7);
    const own = all.filter((event) => event.symbol === symbol);
    expect(own.map((event) => event.eventType)).toEqual(["closed", "opened"]);
    const times = all.map((event) => new Date(event.eventAt).getTime());
    expect([...times].sort((first, second) => second - first)).toEqual(times);
    expect((await fetchPositionEvents(1, 7))).toHaveLength(1);
  });

  it("returns nothing when no position is in the window", async () => {
    expect(await fetchPositionEvents(40, 0)).toEqual([]);
  });
});

describe("fetchPositionEvents: who it is attributed to", () => {
  it("names the requester of the earliest opening fill for the open, and of the latest filled close order for the close", async () => {
    const firstOpener = await createUser("First Opener");
    const laterOpener = await createUser("Later Opener");
    const firstCloser = await createUser("First Closer");
    const lastCloser = await createUser("Last Closer");
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_by_user" });
    const putLegId = await insertLeg(positionId, { legType: "option", side: "short", quantity: 1, entryPrice: 1, exitPrice: 0.5, optionType: "put" });

    const requestFor = async (userId: string, createdAt: Date, extra: Record<string, unknown> = {}) => {
      const [request] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "test", payload: {}, status: "filled", created_at: createdAt, ...extra }).returning(["id"]);
      return request.id as string;
    };
    const earlyOpenRequest = await requestFor(firstOpener, daysAgo(5));
    const lateOpenRequest = await requestFor(laterOpener, daysAgo(4));
    await testDb("trades").insert([
      { position_leg_id: putLegId, side: "sell", quantity: 1, price: 1, executed_at: daysAgo(5), is_closing_trade: false, source_order_request_id: earlyOpenRequest },
      { position_leg_id: putLegId, side: "sell", quantity: 1, price: 1, executed_at: daysAgo(4), is_closing_trade: false, source_order_request_id: lateOpenRequest },
    ]);
    await requestFor(firstCloser, daysAgo(2), { related_position_id: positionId });
    await requestFor(lastCloser, daysAgo(1), { related_position_id: positionId });
    await requestFor(await createUser("Cancelled Closer"), daysAgo(0.5), { related_position_id: positionId, status: "cancelled" });

    const events = await eventsFor(symbol);
    expect(events.find((event) => event.eventType === "opened")!.attributedTo).toBe("First Opener");
    expect(events.find((event) => event.eventType === "closed")!.attributedTo).toBe("Last Closer");
  });

  it("leaves it null when no fill links to an order (a position placed outside the app)", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "covered_call" });
    await insertLeg(positionId, { legType: "stock", side: "long", quantity: 100, entryPrice: 50 });
    expect((await eventsFor(symbol))[0]!.attributedTo).toBeNull();
  });
});
