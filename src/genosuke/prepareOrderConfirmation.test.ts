import { describe, expect, it } from "vitest";
import type { GenosukeApiClient } from "./apiClient.js";
import { confirmPreparedOrder, discardPreparedOrder, prepareOrderConfirmation } from "./prepareOrderConfirmation.js";

type Handler = (path: string, body?: unknown) => unknown;

function fakeApi(handlers: { post?: Handler; get?: Handler }) {
  const calls: string[] = [];
  const api = {
    post: async (path: string, body?: unknown) => {
      calls.push(`POST ${path}`);
      return handlers.post?.(path, body);
    },
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return handlers.get?.(path);
    },
  } as unknown as GenosukeApiClient;
  return { api, calls };
}

const builtOrder = {
  id: "order-1",
  requestType: "open_cash_secured_put",
  payload: { symbol: "AAOI", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", quantity: 2, unitPrice: 1.35, strike: 50, expiry: "20261016", right: "P" }] },
};
const builtCard = "Place order for AAOI (cash-secured put)\n• SELL 2 put $50 exp 2026-10-16, limit 1.35\nOne limit order, sent to IBKR immediately when you tap Yes.";
const noCommissionWarning = { warn: false, netPremiumDollars: 100, commissionSharePctOfPremium: 1, warnThresholdPct: 5 };

describe("prepareOrderConfirmation", () => {
  it("returns the card of the built order and its id when nothing blocks and nothing warns", async () => {
    const { api } = fakeApi({
      post: (path) => (path === "/order-checks/commission-preview" ? noCommissionWarning : builtOrder),
      get: () => ({ blocks: [], warnings: [] }),
    });
    expect(await prepareOrderConfirmation(api, "/positions/orders", {})).toEqual({ description: builtCard, prepared: { orderId: "order-1" } });
  });

  it("puts the gate's warnings and the commission warning on the card", async () => {
    const { api } = fakeApi({
      post: (path) => (path === "/order-checks/commission-preview" ? { warn: true, netPremiumDollars: 100, commissionSharePctOfPremium: 8, warnThresholdPct: 5 } : builtOrder),
      get: () => ({ blocks: [], warnings: ["1 economic event before expiry: 2026-10-07 FOMC."] }),
    });
    const result = await prepareOrderConfirmation(api, "/positions/orders", {});
    expect(result).toMatchObject({ description: expect.stringContaining("⚠ Warnings:") });
    const description = (result as { description: string }).description;
    expect(description).toContain("• 1 economic event before expiry: 2026-10-07 FOMC.");
    expect(description).toContain("• Commission is 8.0% of the premium, above your 5% warning level.");
  });

  it("cancels the built order and returns the reasons when the gate blocks", async () => {
    const { api, calls } = fakeApi({ post: () => builtOrder, get: () => ({ blocks: ["too big", "delta out of band"], warnings: [] }) });
    const result = await prepareOrderConfirmation(api, "/positions/orders", {});
    expect(result).toEqual({ problem: "Blocked, nothing was placed: too big delta out of band" });
    expect(calls).toContain("POST /positions/orders/order-1/cancel");
  });

  it("reports a build failure without cancelling anything", async () => {
    const { api, calls } = fakeApi({
      post: () => {
        throw new Error("Unknown symbol");
      },
    });
    const result = await prepareOrderConfirmation(api, "/positions/orders", {});
    expect(result).toEqual({ problem: "The order could not be built, nothing was placed: Unknown symbol" });
    expect(calls).toEqual(["POST /positions/orders"]);
  });

  it("fails closed, and cancels, when the gate cannot be read", async () => {
    const { api, calls } = fakeApi({
      post: () => builtOrder,
      get: () => {
        throw new Error("timeout");
      },
    });
    const result = await prepareOrderConfirmation(api, "/positions/orders", {});
    expect(result).toMatchObject({ problem: expect.stringContaining("nothing was placed") });
    expect(calls).toContain("POST /positions/orders/order-1/cancel");
  });

  it("still shows the card when only the commission lookup fails", async () => {
    const { api } = fakeApi({
      post: (path) => {
        if (path === "/order-checks/commission-preview") throw new Error("IBKR down");
        return builtOrder;
      },
      get: () => ({ blocks: [], warnings: [] }),
    });
    expect(await prepareOrderConfirmation(api, "/positions/orders", {})).toMatchObject({ description: builtCard });
  });
});

describe("confirmPreparedOrder and discardPreparedOrder", () => {
  it("confirms the order that was built for the card", async () => {
    const { api, calls } = fakeApi({ post: () => ({ id: "order-1", status: "confirmed" }) });
    expect(await confirmPreparedOrder(api, { orderId: "order-1" })).toMatchObject({ status: "confirmed" });
    expect(calls).toEqual(["POST /positions/orders/order-1/confirm"]);
  });

  it("cancels the order when the confirm is refused, and rethrows the refusal", async () => {
    const { api, calls } = fakeApi({
      post: (path) => {
        if (path.endsWith("/confirm")) throw new Error("Trading is blocked");
        return {};
      },
    });
    await expect(confirmPreparedOrder(api, { orderId: "order-1" })).rejects.toThrow("Trading is blocked");
    expect(calls).toEqual(["POST /positions/orders/order-1/confirm", "POST /positions/orders/order-1/cancel"]);
  });

  it("discards by cancelling, and does nothing without a prepared order", async () => {
    const { api, calls } = fakeApi({ post: () => ({}) });
    await discardPreparedOrder({ orderId: "order-1" }, api);
    await discardPreparedOrder(undefined, api);
    expect(calls).toEqual(["POST /positions/orders/order-1/cancel"]);
  });
});
