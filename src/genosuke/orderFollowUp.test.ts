import { describe, expect, it } from "vitest";
import { describeOrderUpdate, sendDueOrderNotices, type OrderFill, type OrderFollowUpDependencies, type OrderNoticeInput } from "./orderFollowUp.js";

const order = (status: string, errorMessage: string | null = null, cancellationReason: string | null = null): OrderNoticeInput => ({ id: "o1", status, errorMessage, cancellationReason, symbol: "AAOI" });
const putFill: OrderFill = { side: "sell", quantity: 2, price: 1.35, optionType: "put", strikePrice: 50, expiryDate: "2026-10-16" };

describe("describeOrderUpdate", () => {
  it("says a day order expired at the close, or was never confirmed, instead of a plain cancel", () => {
    expect(describeOrderUpdate(order("cancelled", null, "expired_at_close"), [])).toContain("expired unfilled at the market close");
    expect(describeOrderUpdate(order("cancelled_partially_filled", null, "expired_at_close"), [putFill])).toContain("expired at the market close after partly filling");
    expect(describeOrderUpdate(order("cancelled", null, "not_confirmed_in_time"), [])).toContain("never confirmed");
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

function fakeDependencies(orders: OrderNoticeInput[], options: { failSendFor?: string } = {}) {
  const sent: string[] = [];
  const marked: string[] = [];
  const fillLoads: string[] = [];
  const dependencies: OrderFollowUpDependencies = {
    loadOrdersNeedingNotice: async () => orders,
    loadFills: async (orderId) => {
      fillLoads.push(orderId);
      return [putFill];
    },
    send: async (text) => {
      if (options.failSendFor && text.includes(options.failSendFor)) throw new Error("telegram down");
      sent.push(text);
    },
    markNotified: async (orderId, status) => {
      marked.push(`${orderId}:${status}`);
    },
  };
  return { dependencies, sent, marked, fillLoads };
}

describe("sendDueOrderNotices", () => {
  it("sends one message per changed order and marks each as told", async () => {
    const { dependencies, sent, marked } = fakeDependencies([{ ...order("submitted"), id: "a" }, { ...order("filled"), id: "b" }]);
    expect(await sendDueOrderNotices(dependencies)).toBe(2);
    expect(sent).toHaveLength(2);
    expect(marked).toEqual(["a:submitted", "b:filled"]);
  });

  it("reads fills only for statuses that have them", async () => {
    const { dependencies, fillLoads } = fakeDependencies([{ ...order("submitted"), id: "a" }, { ...order("error", "x"), id: "b" }, { ...order("partially_filled"), id: "c" }]);
    await sendDueOrderNotices(dependencies);
    expect(fillLoads).toEqual(["c"]);
  });

  it("leaves an order unmarked when its message could not be sent, and still handles the others", async () => {
    const { dependencies, marked } = fakeDependencies([{ ...order("filled"), id: "a" }, { ...order("cancelled"), id: "b" }], { failSendFor: "order filled" });
    expect(await sendDueOrderNotices(dependencies)).toBe(1);
    expect(marked).toEqual(["b:cancelled"]);
  });

  it("does nothing when nothing changed", async () => {
    const { dependencies, sent } = fakeDependencies([]);
    expect(await sendDueOrderNotices(dependencies)).toBe(0);
    expect(sent).toEqual([]);
  });
});
