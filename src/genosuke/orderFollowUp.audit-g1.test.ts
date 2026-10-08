import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderFill } from "../lib/orderFills.js";

// Audit (G1, 2026-10-07) of Genosuke's order follow-up after it started waiting for fills (shared shouldWaitForFills).
// Pure: the database and every Telegram sender are fakes.
vi.mock("../db/connection.js", () => ({ db: {} }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { describeOrderUpdate, sendDueOrderNotices } = await import("./orderFollowUp.js");
type Row = Awaited<ReturnType<Parameters<typeof sendDueOrderNotices>[0]["loadOrdersNeedingNotice"]>>[number];

const now = Date.parse("2026-10-07T15:00:00Z");
const buyBack: OrderFill = { side: "buy", quantity: 1, price: 0.5, optionType: "put", strikePrice: 52, expiryDate: "2031-10-10" };
const sellNew: OrderFill = { side: "sell", quantity: 1, price: 1.25, optionType: "put", strikePrice: 50, expiryDate: "2031-10-17" };

function row(overrides: Partial<Row> = {}): Row {
  return { id: "o1", status: "filled", errorMessage: null, cancellationReason: null, symbol: "GEN", legs: [{ quantity: 1 }, { quantity: 1 }], updatedAt: new Date(now), ...overrides };
}

function fake(rows: Row[], fills: Record<string, OrderFill[]>, send: (text: string) => Promise<void> = async () => {}) {
  const sent: string[] = [];
  const marked: [string, string][] = [];
  return {
    sent,
    marked,
    dependencies: {
      loadOrdersNeedingNotice: async () => rows,
      loadFills: async (id: string) => fills[id] ?? [],
      send: async (text: string) => {
        sent.push(text);
        await send(text);
      },
      markNotified: async (id: string, status: string) => {
        marked.push([id, status]);
      },
      now: () => now,
    },
  };
}

describe("sendDueOrderNotices (audit)", () => {
  // The contract wording counts days to expiry from today's Eastern date: pin it to the pass time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: now });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a roll filled with only its buy-back waits; once both fills land it is told with both", async () => {
    const waiting = fake([row()], { o1: [buyBack] });
    expect(await sendDueOrderNotices(waiting.dependencies)).toBe(0);
    expect(waiting.sent).toEqual([]);
    expect(waiting.marked).toEqual([]);

    const complete = fake([row()], { o1: [buyBack, sellNew] });
    expect(await sendDueOrderNotices(complete.dependencies)).toBe(1);
    expect(complete.sent[0]).toBe("✅ GEN order filled — IBKR confirmed the trade:\n• Buy $52 Put · 10 Oct (1829DTE) · 1× @ 0.50\n• Sell $50 Put · 17 Oct (1836DTE) · 1× @ 1.25");
    expect(complete.marked).toEqual([["o1", "filled"]]);
  });

  it("after 5 minutes with only the buy-back recorded it is told with that fill and says some are missing", async () => {
    const late = fake([row({ updatedAt: new Date(now - 5 * 60_000) })], { o1: [buyBack] });
    expect(await sendDueOrderNotices(late.dependencies)).toBe(1);
    expect(late.sent[0]).toBe("✅ GEN order filled — IBKR confirmed the trade:\n• Buy $52 Put · 10 Oct (1829DTE) · 1× @ 0.50\n(some fills not recorded yet)");
  });

  it("after 5 minutes with no fills recorded it is told anyway, saying the prices are not recorded yet", async () => {
    const late = fake([row({ updatedAt: new Date(now - 5 * 60_000) })], {});
    expect(await sendDueOrderNotices(late.dependencies)).toBe(1);
    expect(late.sent[0]).toBe("✅ GEN order filled — IBKR confirmed the trade:\n(fill prices not recorded yet)");
  });

  it("a send that throws leaves its order unmarked and does not stop the next order", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = [row({ id: "a", status: "submitted" }), row({ id: "b", status: "submitted" })];
    const failingFirst = fake(rows, {}, async (text) => {
      if (failingFirst.sent.length === 1) throw new Error(`telegram down for ${text.slice(0, 5)}`);
    });
    expect(await sendDueOrderNotices(failingFirst.dependencies)).toBe(1);
    expect(failingFirst.marked).toEqual([["b", "submitted"]]);
    errorSpy.mockRestore();
  });

  it("an order with no legs in its payload (legacy row) is told at once rather than waiting", async () => {
    const legacy = fake([row({ legs: [] })], {});
    expect(await sendDueOrderNotices(legacy.dependencies)).toBe(1);
    expect(legacy.sent[0]).toContain("(fill prices not recorded yet)");
  });

  it("a partial fill waits for its first fill, then lists it", async () => {
    const waiting = fake([row({ status: "partially_filled" })], {});
    expect(await sendDueOrderNotices(waiting.dependencies)).toBe(0);
    const ready = fake([row({ status: "partially_filled" })], { o1: [buyBack] });
    expect(await sendDueOrderNotices(ready.dependencies)).toBe(1);
    expect(ready.sent[0]).toBe("⚠️ GEN order partly filled so far, the rest is still working:\n• Buy $52 Put · 10 Oct (1829DTE) · 1× @ 0.50");
  });
});

describe("describeOrderUpdate (audit)", () => {
  it("a cancelled-after-partial order with no recorded fills says so instead of an empty list", () => {
    expect(describeOrderUpdate(row({ status: "cancelled_partially_filled", cancellationReason: "expired_at_close" }), [])).toBe(
      "⚠️ GEN order expired at the market close after partly filling. What was filled:\n(fill prices not recorded yet)",
    );
  });
});
