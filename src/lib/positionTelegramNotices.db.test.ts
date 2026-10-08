import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";
import { easternIsoDate } from "./easternIsoDate.js";
import { daysToExpiry } from "./optionContractLabel.js";

// The position side of the trading-events Telegram catch-all against the real positions and legs tables of the test
// database. Other files' leftover positions may be picked up too, so every assertion looks only at this file's tickers.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the position Telegram notice tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { sendDuePositionTelegramNotices } = await import("./positionTelegramNotices.js");
const testDb: Knex = db;

const createdTickerIds: string[] = [];
let counter = Date.now() % 100_000;
// The pass runs on the real clock (its rows are stamped by the database), so the legs' DTE counts from today's Eastern date.
const jan17 = () => `17 Jan (${daysToExpiry("2031-01-17", easternIsoDate(new Date()))}DTE)`;

async function createPosition(options: { strategyKey: string; closedAt?: Date; closeReason?: string; unstructuredReason?: string }): Promise<{ positionId: string; symbol: string }> {
  const symbol = `PT${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Position Notice Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  const [position] = await testDb("positions")
    .insert({
      strategy_key: options.strategyKey,
      ticker_id: ticker.id,
      status: options.closedAt ? "closed" : "open",
      closed_at: options.closedAt ?? null,
      close_reason: options.closeReason ?? null,
      unstructured_reason: options.unstructuredReason ?? null,
    })
    .returning(["id"]);
  return { positionId: position.id, symbol };
}

async function insertShortPut(positionId: string, exitPrice: number | null): Promise<void> {
  await testDb("position_legs").insert({
    position_id: positionId,
    leg_type: "option",
    side: "short",
    quantity: 1,
    multiplier: 100,
    option_type: "put",
    strike_price: 180,
    expiry_date: "2031-01-17",
    entry_price: 1.25,
    entry_at: new Date(),
    exit_price: exitPrice,
    exit_at: exitPrice === null ? null : new Date(),
  });
}

async function noticeState(positionId: string) {
  return testDb("positions").where({ id: positionId }).first("telegram_opened_notified_at as opened", "telegram_closed_notified_at as closed");
}

function recordingSender(delivered = true) {
  const sent: string[] = [];
  return {
    sent,
    send: async (message: string) => {
      sent.push(message);
      return delivered;
    },
  };
}

const createdOrderIds: string[] = [];
let orderUserId: string | null = null;

afterAll(async () => {
  const positionIds = testDb("positions").whereIn("ticker_id", createdTickerIds).select("id");
  await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).del();
  await testDb("order_requests").whereIn("id", createdOrderIds).del();
  if (orderUserId) await testDb("users").where({ id: orderUserId }).del();
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

describe("sendDuePositionTelegramNotices", () => {
  it("tells a new position once, with its legs as opened", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put" });
    await insertShortPut(positionId, null);

    const first = recordingSender();
    await sendDuePositionTelegramNotices(first.send);
    expect(first.sent.filter((message) => message.includes(symbol))).toEqual([`📥 New position: ${symbol} cash-secured put\n• Sell $180 Put · ${jan17()} · 1× @ 1.25`]);
    expect((await noticeState(positionId)).opened).not.toBeNull();

    const second = recordingSender();
    await sendDuePositionTelegramNotices(second.send);
    expect(second.sent.filter((message) => message.includes(symbol))).toEqual([]);
  });

  it("waits while the opening order is still filling, then tells the position at its full size", async () => {
    if (!orderUserId) {
      const [user] = await testDb("users").insert({ username: `ptn-orders-${Date.now()}`, display_name: "Notice orders", password_hash: "x" }).returning(["id"]);
      orderUserId = user.id as string;
    }
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put" });
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: orderUserId, request_type: "open_cash_secured_put", payload: JSON.stringify({ symbol, legs: [] }), status: "partially_filled" }).returning(["id"]);
    createdOrderIds.push(order.id);
    const [leg] = await testDb("position_legs")
      .insert({ position_id: positionId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "put", strike_price: 180, expiry_date: "2031-01-17", entry_price: 1.25, entry_at: new Date() })
      .returning(["id"]);
    await testDb("trades").insert({ position_leg_id: leg.id, ibkr_exec_id: `ptn-lot-1-${leg.id}`, side: "sell", quantity: 1, price: 1.25, executed_at: new Date(), is_closing_trade: false, source_order_request_id: order.id });

    const whileFilling = recordingSender();
    await sendDuePositionTelegramNotices(whileFilling.send);
    expect(whileFilling.sent.filter((message) => message.includes(symbol))).toEqual([]);
    expect((await noticeState(positionId)).opened).toBeNull();

    await testDb("position_legs").where({ id: leg.id }).update({ quantity: 3 });
    await testDb("order_requests").where({ id: order.id }).update({ status: "filled" });
    const afterFill = recordingSender();
    await sendDuePositionTelegramNotices(afterFill.send);
    expect(afterFill.sent.filter((message) => message.includes(symbol))).toEqual([`📥 New position: ${symbol} cash-secured put\n• Sell $180 Put · ${jan17()} · 3× @ 1.25`]);
  });

  it("tells a position opened and closed between two passes in order, with the realized P&L", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_via_app" });
    await insertShortPut(positionId, 0.4);

    const sender = recordingSender();
    await sendDuePositionTelegramNotices(sender.send);
    const mine = sender.sent.filter((message) => message.includes(symbol));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toContain("📥 New position:");
    // (1.25 − 0.40) × 1 × 100 = +$85.00 over capitalDeployed (the $180 × 100 collateral) = +0.47%.
    expect(mine[1]).toBe(`📤 Position closed: ${symbol} cash-secured put — closed in the app\n• Buy $180 Put · ${jan17()} · 1× @ 0.40\nP&L: +$85.00 (+0.47%)`);
    const state = await noticeState(positionId);
    expect(state.opened).not.toBeNull();
    expect(state.closed).not.toBeNull();
  });

  it("does not repeat a close the expiry message already told, and names a leftover-stock position", async () => {
    const expired = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "expired_worthless" });
    await insertShortPut(expired.positionId, 0);
    await testDb("positions").where({ id: expired.positionId }).update({ telegram_opened_notified_at: new Date(), telegram_closed_notified_at: new Date() });
    const leftover = await createPosition({ strategyKey: "unstructured", unstructuredReason: "csp_assigned_stock" });
    await testDb("position_legs").insert({ position_id: leftover.positionId, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 180, entry_at: new Date() });

    const sender = recordingSender();
    await sendDuePositionTelegramNotices(sender.send);
    expect(sender.sent.filter((message) => message.includes(expired.symbol))).toEqual([]);
    expect(sender.sent.filter((message) => message.includes(leftover.symbol))).toEqual([
      `📥 New position: ${leftover.symbol} stock, no strategy (left over from a put assignment)\n• Buy 100 shares @ 180.00`,
    ]);
  });

  it("leaves everything untold when Telegram does not deliver, and stops the pass at the first failure", async () => {
    const { positionId } = await createPosition({ strategyKey: "cash_secured_put" });
    await insertShortPut(positionId, null);

    const sender = recordingSender(false);
    await sendDuePositionTelegramNotices(sender.send);
    expect(sender.sent).toHaveLength(1);
    expect((await noticeState(positionId)).opened).toBeNull();

    await sendDuePositionTelegramNotices(recordingSender().send);
    expect((await noticeState(positionId)).opened).not.toBeNull();
  });
});
