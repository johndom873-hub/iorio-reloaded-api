import { OrderAction } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { OrderFill } from "./orderFills.js";
import {
  describeOrderTelegramNotice,
  describePlacedBy,
  sendDueOrderTelegramNotices,
  type OrderTelegramNotice,
  type OrderTelegramNoticeDependencies,
  type OrderTelegramNoticeRow,
} from "./orderTelegramNotices.js";

vi.mock("../db/connection.js", () => ({ db: {} }));

const sellPut: OrderLegPayload = { role: "option", action: OrderAction.SELL, symbol: "AAPL", quantity: 2, unitPrice: 1.25, strike: 180, expiry: "20261017", right: "P" };
const putFill: OrderFill = { side: "sell", quantity: 2, price: 1.25, optionType: "put", strikePrice: 180, expiryDate: "2026-10-17" };

function order(overrides: Partial<OrderTelegramNotice> = {}): OrderTelegramNotice {
  return {
    id: "order-1",
    status: "submitted",
    requestType: "open_cash_secured_put",
    symbol: "AAPL",
    legs: [sellPut],
    errorMessage: null,
    cancellationReason: null,
    cancelledByDisplayName: null,
    placedBy: "Marce, web",
    ...overrides,
  };
}

describe("describePlacedBy", () => {
  const requester = { plutoActionId: null, requestedByUsername: "marce", requestedByDisplayName: "Marce" };

  it("names Pluto by its action, Genosuke by its service user, and anyone else as a web user", () => {
    expect(describePlacedBy({ ...requester, plutoActionId: "action-1" }, "genosuke_prod")).toBe("Pluto");
    expect(describePlacedBy({ ...requester, requestedByUsername: "genosuke_prod", requestedByDisplayName: "Genosuke" }, "genosuke_prod")).toBe("Genosuke");
    expect(describePlacedBy(requester, "genosuke_prod")).toBe("Marce, web");
    expect(describePlacedBy(requester, null)).toBe("Marce, web");
  });
});

describe("describeOrderTelegramNotice", () => {
  // The contract wording counts days to expiry from today's Eastern date: pin it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T15:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the order with its limit while it works, and the fills once filled", () => {
    expect(describeOrderTelegramNotice(order(), [])).toBe("⏳ AAPL order working at IBKR (Marce, web):\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit");
    expect(describeOrderTelegramNotice(order({ status: "partially_filled", placedBy: "Pluto" }), [{ ...putFill, quantity: 1 }])).toBe(
      "⚠️ AAPL order partly filled, rest still working (Pluto):\n• Sell $180 Put · 17 Oct (10DTE) · 1× @ 1.25",
    );
    expect(describeOrderTelegramNotice(order({ status: "filled", placedBy: "Genosuke" }), [putFill])).toBe("✅ AAPL order filled (Genosuke):\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25");
  });

  it("lists the order instead of fills when the fills were never recorded", () => {
    expect(describeOrderTelegramNotice(order({ status: "filled" }), [])).toBe(
      "✅ AAPL order filled (Marce, web):\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit\n(fill prices not recorded yet)",
    );
  });

  it("says who or what cancelled it, always with the order's details", () => {
    const lines = "\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit";
    expect(describeOrderTelegramNotice(order({ status: "cancelled", cancelledByDisplayName: "Marce" }), [])).toBe(`🚫 AAPL order cancelled by Marce — nothing filled:${lines}`);
    expect(describeOrderTelegramNotice(order({ status: "cancelled", cancellationReason: "expired_at_close" }), [])).toBe(
      `🚫 AAPL order expired unfilled at the close (Marce, web) — nothing filled:${lines}`,
    );
    expect(describeOrderTelegramNotice(order({ status: "cancelled", cancellationReason: "not_filled_in_time" }), [])).toContain("past the time limit (Marce, web) — nothing filled:");
    expect(describeOrderTelegramNotice(order({ status: "cancelled", cancellationReason: "not_confirmed_in_time" }), [])).toContain("never confirmed, cancelled (Marce, web) — nothing sent to IBKR:");
    expect(describeOrderTelegramNotice(order({ status: "cancelled", cancellationReason: "cancelled_by_ibkr", errorMessage: "Order Canceled" }), [])).toBe(
      `🚫 AAPL order cancelled at IBKR (Marce, web) — nothing filled (Order Canceled):${lines}`,
    );
  });

  it("lists both the order and what filled when a partly filled order ends", () => {
    expect(describeOrderTelegramNotice(order({ status: "cancelled_partially_filled", cancellationReason: "expired_at_close", placedBy: "Pluto" }), [{ ...putFill, quantity: 1 }])).toBe(
      "⚠️ AAPL order expired at the close after partly filling (Pluto):\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit\nFilled:\n• Sell $180 Put · 17 Oct (10DTE) · 1× @ 1.25",
    );
    expect(describeOrderTelegramNotice(order({ status: "cancelled_partially_filled" }), [])).toContain("Filled:\n(fill prices not recorded yet)");
  });

  it("gives the reason for a rejection or an error, with the order's details", () => {
    expect(describeOrderTelegramNotice(order({ status: "rejected", errorMessage: "Insufficient margin" }), [])).toBe(
      "❌ IBKR rejected the AAPL order (Marce, web): Insufficient margin\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit",
    );
    expect(describeOrderTelegramNotice(order({ status: "error", errorMessage: null }), [])).toBe("❌ AAPL order failed (Marce, web): unknown error\n• Sell $180 Put · 17 Oct (10DTE) · 2× @ 1.25 limit");
  });

  it("calls a roll a roll and shows its single net limit on its own line", () => {
    const buyBack: OrderLegPayload = { ...sellPut, action: OrderAction.BUY, quantity: 1, unitPrice: 0.4 };
    const sellNew: OrderLegPayload = { ...sellPut, quantity: 1, unitPrice: 1.25, strike: 175, expiry: "20261121" };
    expect(describeOrderTelegramNotice(order({ requestType: "roll_leg", legs: [buyBack, sellNew] }), [])).toBe(
      "⏳ AAPL roll working at IBKR (Marce, web):\n• Buy $180 Put · 17 Oct (10DTE) · 1×\n• Sell $175 Put · 21 Nov (45DTE) · 1×\nLimit: 0.85 net credit",
    );
    expect(describeOrderTelegramNotice(order({ requestType: "roll_leg", legs: [{ ...buyBack, unitPrice: 2 }, sellNew] }), [])).toContain("Limit: 0.75 net debit");
  });
});

describe("sendDueOrderTelegramNotices", () => {
  const now = Date.parse("2026-10-07T15:00:00Z");

  function dependencies(rows: OrderTelegramNoticeRow[], fills: OrderFill[], delivered = true) {
    const sent: string[] = [];
    const marked: [string, string][] = [];
    const fake: OrderTelegramNoticeDependencies = {
      loadOrdersNeedingNotice: async () => rows,
      loadFills: async () => fills,
      send: async (text) => {
        sent.push(text);
        return delivered;
      },
      markNotified: async (orderId, status) => {
        marked.push([orderId, status]);
      },
      now: () => now,
    };
    return { fake, sent, marked };
  }

  it("sends and marks each order whose status changed", async () => {
    const { fake, sent, marked } = dependencies([{ ...order(), updatedAt: new Date(now) }], []);
    expect(await sendDueOrderTelegramNotices(fake)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(marked).toEqual([["order-1", "submitted"]]);
  });

  it("leaves an undelivered message for the next pass", async () => {
    const { fake, marked } = dependencies([{ ...order(), updatedAt: new Date(now) }], [], false);
    expect(await sendDueOrderTelegramNotices(fake)).toBe(0);
    expect(marked).toEqual([]);
  });

  it("waits for a fill's details, then sends without them once the wait is over", async () => {
    const justFilled = dependencies([{ ...order({ status: "filled" }), updatedAt: new Date(now - 10_000) }], [{ ...putFill, quantity: 1 }]);
    expect(await sendDueOrderTelegramNotices(justFilled.fake)).toBe(0);
    expect(justFilled.sent).toEqual([]);

    const longFilled = dependencies([{ ...order({ status: "filled" }), updatedAt: new Date(now - 6 * 60_000) }], []);
    expect(await sendDueOrderTelegramNotices(longFilled.fake)).toBe(1);
    expect(longFilled.sent[0]).toContain("(fill prices not recorded yet)");

    const allFilled = dependencies([{ ...order({ status: "filled" }), updatedAt: new Date(now) }], [putFill]);
    expect(await sendDueOrderTelegramNotices(allFilled.fake)).toBe(1);
  });
});
