import { beforeEach, describe, expect, it, vi } from "vitest";

// Routine order problems (routineOrderProblems.ts): an order IBKR or the worker ends for a drifted price, a missing quote,
// its tick size or margin is a blocked action, planned afresh at the next look; any other rejection still trips order_error.
// A refusal at confirm (the order gates, the ladder's book-wide cap included) is a blocked action too. Ledger, breaker and
// Telegram are mocked; the order API is a fake.

vi.mock("../db/connection.js", () => {
  const chain = { join: () => chain, where: () => chain, select: () => Promise.resolve([]) };
  return { db: () => chain };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("./ledger.js", () => ({ recordPlutoEvent: vi.fn(async () => {}), updatePlutoAction: vi.fn(async () => {}) }));
vi.mock("./stateStore.js", () => ({ tripPlutoBreaker: vi.fn(async () => {}) }));

const { watchPlutoOrder, executePlutoOrder } = await import("./executor.js");
const { updatePlutoAction, recordPlutoEvent } = await import("./ledger.js");
const { tripPlutoBreaker } = await import("./stateStore.js");
const { InternalApiError } = await import("../lib/internalApiClient.js");

const settings = { maxFillSlippagePct: 5, telegramVerbosity: "actions" } as never;
const watched = { actionId: "a1", orderId: "o1", symbol: "LADR", reference: { price: 0.8, side: "sell" as const, multiplier: 100 }, description: "LADR Sell $45 Put · 20 Nov (31DTE) · 2× @ 0.80" };

function endedOrder(status: "rejected" | "error", errorMessage: string) {
  return { get: vi.fn(async () => ({ id: "o1", status, errorMessage, updatedAt: new Date().toISOString(), payload: { legs: [] } })), post: vi.fn(async () => ({})) } as never;
}

beforeEach(() => {
  vi.mocked(updatePlutoAction).mockClear();
  vi.mocked(recordPlutoEvent).mockClear();
  vi.mocked(tripPlutoBreaker).mockClear();
});

describe("watchPlutoOrder: routine order problems", () => {
  it.each([
    ["rejected", "IBKR error 110: The price does not conform to the minimum price variation for this contract.", "tick size"],
    ["rejected", "IBKR error 201: Order rejected - reason:YOUR ORDER IS NOT ACCEPTED. IN ORDER TO OBTAIN THE DESIRED POSITION YOUR EQUITY WITH LOAN VALUE [1 USD] MUST EXCEED THE INITIAL MARGIN [2 USD]", "margin refusal"],
    ["error", "The order's limit price failed the live-quote check at placement: Limit price 0.80 for LADR Sell $45 Put is 0.10 below the live mid 0.90.", "drifted price"],
    ["error", "The order's limit price could not be checked against a live quote at placement (timeout).", "missing quote"],
  ] as const)("a %s order (%s) is blocked and retried, no breaker", async (status, errorMessage, label) => {
    const result = await watchPlutoOrder(endedOrder(status, errorMessage), settings, watched, { pollIntervalMs: 0 });
    expect(result).toEqual({ outcome: "blocked", detail: `${label}: ${errorMessage}` });
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
    expect(vi.mocked(updatePlutoAction).mock.calls.at(-1)![1]).toMatchObject({ outcome: "blocked", blockReason: `${label}: ${errorMessage}` });
    expect(recordPlutoEvent).toHaveBeenCalledWith("action_blocked", expect.objectContaining({ actionId: "a1", stage: "order", reason: `${label}: ${errorMessage}` }));
  });

  it("any other rejection still trips order_error", async () => {
    const result = await watchPlutoOrder(endedOrder("rejected", "IBKR error 201: Order rejected - reason:The contract is not available for trading."), settings, watched, { pollIntervalMs: 0 });
    expect(result.outcome).toBe("rejected");
    expect(tripPlutoBreaker).toHaveBeenCalledWith("order_error", expect.stringContaining("not available for trading"));
  });
});

describe("executePlutoOrder: a refusal at confirm", () => {
  it("the ladder's book-wide cap refusing at confirm (HTTP 409) is a blocked action, cancelled, no breaker", async () => {
    const reason = "Pluto's tickers would commit $100,420 together, above Pluto's capital budget of $100,000 (50.0% of portfolio value); $96,000 is already committed, counting orders still working.";
    const post = vi.fn(async (path: string) => {
      if (path === "/positions/orders") return { id: "o9", status: "pending_confirmation", errorMessage: null, payload: { legs: [] } };
      if (path.endsWith("/confirm")) throw new InternalApiError(409, reason);
      return {};
    });
    const result = await executePlutoOrder({ post } as never, settings, { kind: "ladder_open", actionId: "a9", symbol: "LADR", strategyKey: "cash_secured_put", contract: { expiry: "2026-11-20", strike: 45, right: "P", dte: 31 }, plan: { quantity: 1, limitPrice: 0.8, notional: 4_420, fullSizeQuantity: 1 }, buyEveryShare: false, reasons: ["CC + Put Ladder."], scoresSnapshot: {} });
    expect(result).toEqual({ outcome: "blocked", orderId: "o9", detail: `confirm refused: ${reason}` });
    expect(post).toHaveBeenCalledWith("/positions/orders/o9/cancel", {});
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
  });
});
