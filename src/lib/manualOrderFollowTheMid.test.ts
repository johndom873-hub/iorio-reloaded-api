import { describe, expect, it, vi } from "vitest";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { createManualOrderFollower, followedLimitPriceNow, manualFollowTheMidSide, type FollowableOrderPayload, type ManualOrderFollowerDependencies } from "./manualOrderFollowTheMid.js";

const putSale = (unitPrice: number, extra: Partial<FollowableOrderPayload> = {}): FollowableOrderPayload =>
  ({ symbol: "NVDA", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "NVDA", quantity: 2, unitPrice, strike: 180, expiry: "20261120", right: "P" }], followTheMid: true, ...extra }) as OrderRequestPayload;

describe("manualFollowTheMidSide", () => {
  const optionLeg = (action: string) => ({ role: "option", action });
  it("allows a person's Call or Put sale and LEAPS buy, one option leg each", () => {
    expect(manualFollowTheMidSide({ request_type: "open_covered_call", pluto_action_id: null, payload: { legs: [optionLeg("SELL")] } })).toBe("sell");
    expect(manualFollowTheMidSide({ request_type: "open_cash_secured_put", pluto_action_id: null, payload: { legs: [optionLeg("SELL")] } })).toBe("sell");
    expect(manualFollowTheMidSide({ request_type: "open_leaps", pluto_action_id: null, payload: { legs: [optionLeg("BUY")] } })).toBe("buy");
  });
  it("refuses Pluto's orders, a Call sold with its shares, buybacks, rolls and share orders", () => {
    expect(manualFollowTheMidSide({ request_type: "open_cash_secured_put", pluto_action_id: "a", payload: { legs: [optionLeg("SELL")] } })).toBeNull();
    expect(manualFollowTheMidSide({ request_type: "open_covered_call", pluto_action_id: null, payload: { legs: [{ role: "stock", action: "BUY" }, optionLeg("SELL")] } })).toBeNull();
    expect(manualFollowTheMidSide({ request_type: "close_leg", pluto_action_id: null, payload: { legs: [optionLeg("BUY")] } })).toBeNull();
    expect(manualFollowTheMidSide({ request_type: "roll_leg", pluto_action_id: null, payload: { legs: [optionLeg("BUY"), optionLeg("SELL")] } })).toBeNull();
    expect(manualFollowTheMidSide({ request_type: "open_shares", pluto_action_id: null, payload: { legs: [{ role: "stock", action: "BUY" }] } })).toBeNull();
  });
});

describe("followedLimitPriceNow", () => {
  it("moves to the mid one cent towards the other side", () => {
    expect(followedLimitPriceNow({ bid: 1.4, ask: 1.46 }, "sell", 1.5)).toBe(1.42);
    expect(followedLimitPriceNow({ bid: 12.2, ask: 12.8 }, "buy", 12.1)).toBe(12.51);
    expect(followedLimitPriceNow({ bid: 0.67, ask: 0.68 }, "sell", 0.7)).toBe(0.67);
  });
  it("leaves the order where it is on the same price, no quote, a one-sided or a crossed quote", () => {
    expect(followedLimitPriceNow({ bid: 1.4, ask: 1.46 }, "sell", 1.42)).toBeNull();
    expect(followedLimitPriceNow(null, "sell", 1.5)).toBeNull();
    expect(followedLimitPriceNow({ bid: null, ask: 1.46 }, "sell", 1.5)).toBeNull();
    expect(followedLimitPriceNow({ bid: 0, ask: 1.46 }, "buy", 1.5)).toBeNull();
    expect(followedLimitPriceNow({ bid: 1.5, ask: 1.5 }, "sell", 1.4)).toBeNull();
  });
});

describe("createManualOrderFollower", () => {
  function harness(rows: { id: string; request_type: string; pluto_action_id: string | null; payload: FollowableOrderPayload }[]) {
    const unsubscribed: string[] = [];
    const subscribed: PriceContract[] = [];
    const dependencies: ManualOrderFollowerDependencies = {
      loadFollowedOrders: async () => rows,
      subscribe: async (contract) => {
        subscribed.push(contract);
        return () => unsubscribed.push(contract.key);
      },
      liveQuote: () => ({ bid: 1.4, ask: 1.46 }),
      requestChange: vi.fn(async () => ({ ok: true as const })),
    };
    return { follower: createManualOrderFollower(dependencies), dependencies, subscribed, unsubscribed, rows };
  }

  it("opens the order's line on the first check and asks for the change on the next", async () => {
    const { follower, dependencies, subscribed } = harness([{ id: "o1", request_type: "open_cash_secured_put", pluto_action_id: null, payload: putSale(1.5) }]);
    await follower.check();
    expect(subscribed).toEqual([{ key: "manual-follow-o1", legType: "option", symbol: "NVDA", expiry: "20261120", strike: 180, right: "P" }]);
    expect(dependencies.requestChange).not.toHaveBeenCalled();
    await follower.check();
    expect(dependencies.requestChange).toHaveBeenCalledWith("o1", 1.42);
  });

  it("waits while the previous change is not yet sent, and stops at 20 changes", async () => {
    const changes = Array.from({ length: 20 }, () => ({ at: "2026-11-14T15:00:00.000Z", from: 1.5, to: 1.49 }));
    const { follower, dependencies, unsubscribed, rows } = harness([
      { id: "pending", request_type: "open_cash_secured_put", pluto_action_id: null, payload: putSale(1.5, { limitPriceChangeRequest: { limitPrice: 1.45, requestedAt: "2026-11-14T15:00:00.000Z" } }) },
      { id: "capped", request_type: "open_cash_secured_put", pluto_action_id: null, payload: putSale(1.5) },
    ]);
    await follower.check();
    rows[1]!.payload = putSale(1.5, { limitPriceChanges: changes });
    await follower.check();
    expect(dependencies.requestChange).not.toHaveBeenCalled();
    expect(unsubscribed).toEqual(["manual-follow-capped"]);
    expect(follower.followedOrderIds()).toEqual(["pending"]);
  });

  it("closes the line once the order is no longer working", async () => {
    const { follower, unsubscribed, rows } = harness([{ id: "o1", request_type: "open_cash_secured_put", pluto_action_id: null, payload: putSale(1.5) }]);
    await follower.check();
    rows.length = 0;
    await follower.check();
    expect(unsubscribed).toEqual(["manual-follow-o1"]);
    expect(follower.followedOrderIds()).toEqual([]);
  });

  it("logs a refusal once, not on every check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { follower, dependencies } = harness([{ id: "o1", request_type: "open_cash_secured_put", pluto_action_id: null, payload: putSale(1.5) }]);
    dependencies.requestChange = vi.fn(async () => ({ ok: false as const, status: 409 as const, error: "Trading is halted." }));
    for (let index = 0; index < 4; index++) await follower.check();
    expect(dependencies.requestChange).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
