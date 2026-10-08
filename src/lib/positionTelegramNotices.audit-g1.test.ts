import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { easternIsoDate } from "./easternIsoDate.js";
import { daysToExpiry } from "./optionContractLabel.js";

// Audit (G1, 2026-10-07) of the position side of the trading-events catch-all against the real test database.
// sendDuePositionTelegramNotices reads and marks EVERY position needing a notice, so each test runs inside one database
// transaction that is rolled back afterwards: the connection module's db is a proxy pointed at that transaction, other
// files' positions are marked as told inside it first (so the pass only sees this test's rows, in a known order), and
// nothing this file does survives the test. The Telegram sender is always a local fake (the dev .env has LIVE credentials).
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config({ quiet: true });
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the position Telegram notice audit tests.");
  const base = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } });
  const state: { current: Knex | Knex.Transaction } = { current: base };
  const proxy = new Proxy(function connectionProxy() {}, {
    apply: (_target, _thisArg, args: unknown[]) => (state.current as unknown as (...callArgs: unknown[]) => unknown)(...args),
    get: (_target, property) => {
      if (property === "__state") return state;
      if (property === "__base") return base;
      const value = (state.current as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(state.current) : value;
    },
  });
  return { db: proxy };
});

const connection = (await import("../db/connection.js")) as unknown as { db: Knex & { __state: { current: Knex | Knex.Transaction }; __base: Knex } };
const { sendDuePositionTelegramNotices, describePositionClosedNotice } = await import("./positionTelegramNotices.js");
const base = connection.db.__base;
let trx: Knex.Transaction;
let counter = Date.now() % 100_000;
// The pass runs on the real clock (its rows are stamped by the database), so the legs' DTE counts from today's Eastern date.
const jan17 = () => `17 Jan (${daysToExpiry("2031-01-17", easternIsoDate(new Date()))}DTE)`;

beforeEach(async () => {
  trx = await base.transaction();
  connection.db.__state.current = trx;
  // Everyone else's positions count as told, inside this transaction only.
  await trx.raw(`
    update positions set
      telegram_opened_notified_at = coalesce(telegram_opened_notified_at, now()),
      telegram_closed_notified_at = case when closed_at is not null then coalesce(telegram_closed_notified_at, now()) else telegram_closed_notified_at end
    where telegram_opened_notified_at is null or (closed_at is not null and telegram_closed_notified_at is null)
  `);
});

afterEach(async () => {
  connection.db.__state.current = base;
  await trx.rollback();
});

afterAll(async () => {
  await base.destroy();
});

async function createPosition(options: { strategyKey: string; openedAt?: Date; closedAt?: Date; closeReason?: string; unstructuredReason?: string }) {
  const symbol = `PG${(counter += 1)}`;
  const [ticker] = await trx("tickers").insert({ symbol, company_name: "G1 Position Audit Co", sector: "Technology" }).returning(["id"]);
  const [position] = await trx("positions")
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
  return { positionId: position.id as string, symbol };
}

async function insertLeg(positionId: string, fields: Record<string, unknown>): Promise<string> {
  const [leg] = await trx("position_legs")
    .insert({ position_id: positionId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "put", strike_price: 50, expiry_date: "2031-01-17", entry_price: 1.25, entry_at: new Date(), ...fields })
    .returning(["id"]);
  return leg.id;
}

function sender(deliver: (message: string, index: number) => boolean = () => true) {
  const sent: string[] = [];
  return {
    sent,
    send: async (message: string) => {
      sent.push(message);
      return deliver(message, sent.length - 1);
    },
  };
}

async function state(positionId: string) {
  return trx("positions").where({ id: positionId }).first("telegram_opened_notified_at as opened", "telegram_closed_notified_at as closed");
}

describe("sendDuePositionTelegramNotices (audit)", () => {
  it("opened delivered but close undelivered: the opening is marked, and the next pass sends only the close", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_via_app" });
    await insertLeg(positionId, { exit_price: 0.4, exit_at: new Date() });

    const first = sender((_message, index) => index === 0);
    expect(await sendDuePositionTelegramNotices(first.send)).toBe(1);
    expect(first.sent).toHaveLength(2);
    expect((await state(positionId)).opened).not.toBeNull();
    expect((await state(positionId)).closed).toBeNull();

    const second = sender();
    expect(await sendDuePositionTelegramNotices(second.send)).toBe(1);
    expect(second.sent).toEqual([`📤 Position closed: ${symbol} cash-secured put — closed in the app\n• Buy $50 Put · ${jan17()} · 1× @ 0.40\nP&L: +$85.00 (+1.70%)`]);
  });

  it("the first undelivered message ends the pass: a later position is not even tried", async () => {
    const older = await createPosition({ strategyKey: "cash_secured_put", openedAt: new Date(Date.now() - 60_000) });
    await insertLeg(older.positionId, {});
    const newer = await createPosition({ strategyKey: "cash_secured_put" });
    await insertLeg(newer.positionId, {});

    const failing = sender(() => false);
    expect(await sendDuePositionTelegramNotices(failing.send)).toBe(0);
    expect(failing.sent).toHaveLength(1);
    expect(failing.sent[0]).toContain(older.symbol);
    expect((await state(older.positionId)).opened).toBeNull();
    expect((await state(newer.positionId)).opened).toBeNull();
  });

  it("a hedge that expired (the expiry message skips hedges) is told by the catch-all, with a full loss over the premium paid", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "hedge", closedAt: new Date(), closeReason: "expired_worthless" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    await insertLeg(positionId, { side: "long", option_type: "call", strike_price: 90, entry_price: 2, exit_price: 0, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    // (0 − 2.00) × 1 × 100 = −$200.00 over capitalDeployed (premium paid, $200) = −100.00%.
    expect(pass.sent).toEqual([`📤 Position closed: ${symbol} hedge — expired worthless\n• Sell $90 Call · ${jan17()} · 1× @ 0.00\nP&L: −$200.00 (−100.00%)`]);
  });

  it("a close with a missing exit price says the P&L is unknown and the leg's price is unknown", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "unknown" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    await insertLeg(positionId, { exit_price: null, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    expect(pass.sent).toEqual([`📤 Position closed: ${symbol} cash-secured put — reason unknown\n• Buy $50 Put · ${jan17()} · 1× (price unknown)\nP&L: unknown (an exit price is missing)`]);
  });

  it("realized P&L is net of closing commissions", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_via_app" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    const legId = await insertLeg(positionId, { exit_price: 0.4, exit_at: new Date() });
    await trx("trades").insert({ position_leg_id: legId, side: "buy", quantity: 1, price: 0.4, commission: 1.3, executed_at: new Date(), is_closing_trade: true });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    // (1.25 − 0.40) × 100 − 1.30 = +$83.70 over $5,000 collateral = +1.67%.
    expect(pass.sent).toEqual([`📤 Position closed: ${symbol} cash-secured put — closed in the app\n• Buy $50 Put · ${jan17()} · 1× @ 0.40\nP&L: +$83.70 (+1.67%)`]);
  });

  it("an opening lists slices of one contract as one leg; the close lists each slice at its own exit", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_via_app" });
    await insertLeg(positionId, { quantity: 1, exit_price: 0.4, exit_at: new Date() });
    await insertLeg(positionId, { quantity: 2, exit_price: 0.3, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    const sorted = (text: string) => text.split("\n").slice(1, 3).sort();
    expect(pass.sent[0]).toBe(`📥 New position: ${symbol} cash-secured put\n• Sell $50 Put · ${jan17()} · 3× @ 1.25`);
    expect(sorted(pass.sent[1]!)).toEqual([`• Buy $50 Put · ${jan17()} · 1× @ 0.40`, `• Buy $50 Put · ${jan17()} · 2× @ 0.30`]);
    // (1.25−0.40)×100 + (1.25−0.30)×2×100 = 85 + 190 = +$275.00 over the 3 contracts' collateral ($15,000) = +1.83%.
    expect(pass.sent[1]!.split("\n")[3]).toBe("P&L: +$275.00 (+1.83%)");
  });

  it("the most common close reason (closed_via_app) is named in the headline", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "cash_secured_put", closedAt: new Date(), closeReason: "closed_via_app" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    await insertLeg(positionId, { exit_price: 0.4, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    expect(pass.sent[0]!.split("\n")[0]).toBe(`📤 Position closed: ${symbol} cash-secured put — closed in the app`);
  });

  // Shares handed off to a successor position (a covered call rolled to a new call, or leftover stock absorbed into a new
  // covered call) are closed at their own entry price with no closing trade: they were never sold.
  it("a covered call whose shares were handed to its successor (roll) does not claim the shares were sold", async () => {
    const { positionId } = await createPosition({ strategyKey: "covered_call", closedAt: new Date(), closeReason: "closed_via_app" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    await insertLeg(positionId, { leg_type: "stock", side: "long", quantity: 100, multiplier: 1, option_type: null, strike_price: null, expiry_date: null, entry_price: 50, exit_price: 50, exit_at: new Date() });
    await insertLeg(positionId, { option_type: "call", strike_price: 55, exit_price: 0.4, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    expect(pass.sent).toHaveLength(1);
    expect(pass.sent[0]).not.toContain("Sell 100 shares");
    expect(pass.sent[0]).toContain("• 100 shares moved to the next position");
    expect(pass.sent[0]).toContain(`• Buy $55 Call · ${jan17()} · 1× @ 0.40`);
  });

  it("leftover shares absorbed into a covered call are told as such (reason label)", async () => {
    const { positionId, symbol } = await createPosition({ strategyKey: "unstructured", unstructuredReason: "csp_assigned_stock", closedAt: new Date(), closeReason: "stock_rolled_into_covered_call" });
    await trx("positions").where({ id: positionId }).update({ telegram_opened_notified_at: new Date() });
    await insertLeg(positionId, { leg_type: "stock", side: "long", quantity: 100, multiplier: 1, option_type: null, strike_price: null, expiry_date: null, entry_price: 50, exit_price: 50, exit_at: new Date() });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    expect(pass.sent[0]!.split("\n")[0]).toBe(`📤 Position closed: ${symbol} stock, no strategy — shares moved into a covered call`);
    // The base is what the shares cost (100 × 50), even once they have moved on.
    expect(pass.sent[0]!.split("\n").at(-1)).toBe("P&L: $0.00 (0.00%)");
  });

  it("a position with no legs at all (an orphan the self-heal closes) still produces readable messages", async () => {
    const { symbol } = await createPosition({ strategyKey: "covered_call", closedAt: new Date(), closeReason: "unknown" });
    const pass = sender();
    await sendDuePositionTelegramNotices(pass.send);
    expect(pass.sent).toEqual([`📥 New position: ${symbol} covered call`, `📤 Position closed: ${symbol} covered call — reason unknown\nP&L: $0.00`]);
  });
});

describe("describePositionClosedNotice (pure)", () => {
  const event = {
    positionId: "p",
    eventType: "closed" as const,
    eventAt: "2031-01-17T20:00:00Z",
    openedAt: "2031-01-01T15:00:00Z",
    symbol: "PURE",
    strategyKey: "cash_secured_put",
    closeReason: "assigned",
    unstructuredReason: null,
    realizedPnl: -12.345,
    netCashEffect: null,
    fullMarketValue: null,
    attributedTo: null,
    legs: [{ legType: "option" as const, side: "short" as const, quantity: 1, optionType: "put" as const, strikePrice: 50, expiryDate: "2031-01-17", entryPrice: 1.25, exitPrice: 1.37 }],
  };

  it("a loss shows the minus before the dollar sign and a negative percent", () => {
    expect(describePositionClosedNotice(event, 5_000).split("\n").at(-1)).toBe("P&L: −$12.35 (−0.25%)");
  });

  it("capitalDeployed of zero or null drops the percent instead of dividing by zero", () => {
    expect(describePositionClosedNotice(event, 0).split("\n").at(-1)).toBe("P&L: −$12.35");
    expect(describePositionClosedNotice(event, null).split("\n").at(-1)).toBe("P&L: −$12.35");
  });

  it("a close reason with no label is left out rather than printed raw", () => {
    expect(describePositionClosedNotice({ ...event, closeReason: "some_future_reason" }, null).split("\n")[0]).toBe("📤 Position closed: PURE cash-secured put");
  });
});
