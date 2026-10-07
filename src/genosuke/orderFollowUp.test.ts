import { describe, expect, it } from "vitest";
import { describeOrderUpdate, sendDueOrderNotices, type OrderFill, type OrderFollowUpDependencies, type OrderNoticeInput, type OrderNoticeRow } from "./orderFollowUp.js";

const order = (status: string, errorMessage: string | null = null, cancellationReason: string | null = null): OrderNoticeInput => ({ id: "o1", status, errorMessage, cancellationReason, symbol: "AAOI" });
const putFill: OrderFill = { side: "sell", quantity: 2, price: 1.35, optionType: "put", strikePrice: 50, expiryDate: "2026-10-16" };

describe("describeOrderUpdate", () => {
  it("says a day order expired at the close, or was never confirmed, instead of a plain cancel", () => {
    expect(describeOrderUpdate(order("cancelled", null, "expired_at_close"), [])).toContain("expired unfilled at the market close");
    expect(describeOrderUpdate(order("cancelled_partially_filled", null, "expired_at_close"), [putFill])).toContain("expired at the market close after partly filling");
    expect(describeOrderUpdate(order("cancelled", null, "not_confirmed_in_time"), [])).toContain("never confirmed");
    expect(describeOrderUpdate(order("cancelled", null, "not_filled_in_time"), [])).toContain("past the time limit");
    expect(describeOrderUpdate(order("cancelled_partially_filled", null, "not_filled_in_time"), [putFill])).toContain("past the time limit after partly filling");
    expect(describeOrderUpdate(order("cancelled", "IBKR: Not enough buying power", "cancelled_by_ibkr"), [])).toContain("(IBKR: Not enough buying power)");
  });

  it("says the order is working when IBKR accepts it", () => {
    expect(describeOrderUpdate(order("submitted"), [])).toContain("Working at IBKR");
  });

  it("lists what was filled for a full fill, a partial fill and a cancel after a partial fill", () => {
    expect(describeOrderUpdate(order("filled"), [putFill])).toBe("✅ AAOI order filled — IBKR confirmed the trade:\n• SELL 2 put $50 exp 2026-10-16 at 1.35");
    expect(describeOrderUpdate(order("partially_filled"), [putFill])).toContain("partly filled so far, the rest is still working");
    expect(describeOrderUpdate(order("cancelled_partially_filled"), [putFill])).toContain("cancelled at IBKR after partly filling");
  });

  it("describes a stock fill without option details", () => {
    const stockFill: OrderFill = { side: "buy", quantity: 100, price: 48.2, optionType: null, strikePrice: null, expiryDate: null };
    expect(describeOrderUpdate(order("filled"), [stockFill])).toContain("• BUY 100 shares at 48.2");
  });

  it("gives the reason for a rejection or an error, and a plain cancel", () => {
    expect(describeOrderUpdate(order("rejected", "IBKR error 201: insufficient margin"), [])).toBe("❌ IBKR rejected the AAOI order: IBKR error 201: insufficient margin.");
    expect(describeOrderUpdate(order("error", "Could not resolve one or more contract ids."), [])).toContain("Could not resolve one or more contract ids.");
    expect(describeOrderUpdate(order("error"), [])).toContain("unknown error");
    expect(describeOrderUpdate(order("cancelled"), [])).toContain("nothing was filled");
  });
});

const now = Date.parse("2026-10-07T15:00:00Z");

/** An order of one 2-lot put leg whose status changed just now, unless overridden. */
function row(input: OrderNoticeInput, overrides: Partial<OrderNoticeRow> = {}): OrderNoticeRow {
  return { ...input, legs: [{ quantity: 2 }], updatedAt: new Date(now), ...overrides };
}

function fakeDependencies(orders: OrderNoticeRow[], options: { failSendFor?: string; fills?: OrderFill[] } = {}) {
  const sent: string[] = [];
  const marked: string[] = [];
  const fillLoads: string[] = [];
  const dependencies: OrderFollowUpDependencies = {
    loadOrdersNeedingNotice: async () => orders,
    loadFills: async (orderId) => {
      fillLoads.push(orderId);
      return options.fills ?? [putFill];
    },
    send: async (text) => {
      if (options.failSendFor && text.includes(options.failSendFor)) throw new Error("telegram down");
      sent.push(text);
    },
    markNotified: async (orderId, status) => {
      marked.push(`${orderId}:${status}`);
    },
    now: () => now,
  };
  return { dependencies, sent, marked, fillLoads };
}

describe("sendDueOrderNotices", () => {
  it("sends one message per changed order and marks each as told", async () => {
    const { dependencies, sent, marked } = fakeDependencies([row({ ...order("submitted"), id: "a" }), row({ ...order("filled"), id: "b" })]);
    expect(await sendDueOrderNotices(dependencies)).toBe(2);
    expect(sent).toHaveLength(2);
    expect(marked).toEqual(["a:submitted", "b:filled"]);
  });

  it("reads fills only for statuses that have them", async () => {
    const { dependencies, fillLoads } = fakeDependencies([row({ ...order("submitted"), id: "a" }), row({ ...order("error", "x"), id: "b" }), row({ ...order("partially_filled"), id: "c" })]);
    await sendDueOrderNotices(dependencies);
    expect(fillLoads).toEqual(["c"]);
  });

  it("leaves an order unmarked when its message could not be sent, and still handles the others", async () => {
    const { dependencies, marked } = fakeDependencies([row({ ...order("filled"), id: "a" }), row({ ...order("cancelled"), id: "b" })], { failSendFor: "order filled" });
    expect(await sendDueOrderNotices(dependencies)).toBe(1);
    expect(marked).toEqual(["b:cancelled"]);
  });

  it("waits for a new contract's fills, and for both legs of a roll, before telling a fill", async () => {
    const noFillsYet = fakeDependencies([row(order("filled"))], { fills: [] });
    expect(await sendDueOrderNotices(noFillsYet.dependencies)).toBe(0);
    expect(noFillsYet.marked).toEqual([]);

    // A roll's buy-back is recorded at once; the new leg's fill only when reconciliation creates its leg.
    const rollHalfRecorded = fakeDependencies([row(order("filled"), { legs: [{ quantity: 1 }, { quantity: 1 }] })], { fills: [{ ...putFill, side: "buy", quantity: 1 }] });
    expect(await sendDueOrderNotices(rollHalfRecorded.dependencies)).toBe(0);

    const rollRecorded = fakeDependencies([row(order("filled"), { legs: [{ quantity: 1 }, { quantity: 1 }] })], { fills: [{ ...putFill, side: "buy", quantity: 1 }, { ...putFill, quantity: 1 }] });
    expect(await sendDueOrderNotices(rollRecorded.dependencies)).toBe(1);
  });

  it("tells a fill without its prices once the wait is over", async () => {
    const { dependencies, sent } = fakeDependencies([row(order("filled"), { updatedAt: new Date(now - 6 * 60_000) })], { fills: [] });
    expect(await sendDueOrderNotices(dependencies)).toBe(1);
    expect(sent).toEqual(["✅ AAOI order filled — IBKR confirmed the trade:\n(fill prices not recorded yet)"]);
  });

  it("does nothing when nothing changed", async () => {
    const { dependencies, sent } = fakeDependencies([]);
    expect(await sendDueOrderNotices(dependencies)).toBe(0);
    expect(sent).toEqual([]);
  });
});
