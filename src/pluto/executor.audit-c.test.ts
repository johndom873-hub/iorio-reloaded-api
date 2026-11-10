import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit C (2026-10-07): the pessimistic fill figure is gone; the fill-slippage breaker must behave exactly as before.
// watchPlutoOrder runs against a fake order API and a fake trades read; ledger, breaker and Telegram are mocked.

const fillRows: { side: string; quantity: number; price: string; multiplier: number; executed_at?: Date }[] = [];
vi.mock("../db/connection.js", () => {
  const chain = {
    join: () => chain,
    where: () => chain,
    select: () => Promise.resolve(fillRows),
  };
  return { db: () => chain };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("./ledger.js", () => ({ recordPlutoEvent: vi.fn(async () => {}), updatePlutoAction: vi.fn(async () => {}) }));
vi.mock("./stateStore.js", () => ({ tripPlutoBreaker: vi.fn(async () => {}) }));

const { compareFillsWithReference, followTheMidOnce, watchPlutoOrder } = await import("./executor.js");
const { recordPlutoEvent, updatePlutoAction } = await import("./ledger.js");
const { tripPlutoBreaker } = await import("./stateStore.js");
const { notifyPlutoTelegram } = await import("../lib/notifyTelegram.js");
const { InternalApiError } = await import("../lib/internalApiClient.js");

const settings = { maxFillSlippagePct: 5, telegramVerbosity: "all" } as never;

function fakeApi(status = "filled", quantity = 2) {
  return { get: vi.fn(async () => ({ id: "o1", status, errorMessage: null, updatedAt: new Date().toISOString(), payload: { legs: [{ role: "option", action: "BUY", unitPrice: 0.53, quantity }] } })), post: vi.fn(async () => ({})) } as never;
}

beforeEach(() => {
  fillRows.length = 0;
  vi.mocked(updatePlutoAction).mockClear();
  vi.mocked(tripPlutoBreaker).mockClear();
  vi.mocked(notifyPlutoTelegram).mockClear();
});

describe("compareFillsWithReference — slippage after the pessimistic figure's removal", () => {
  const fill = (side: "buy" | "sell", quantity: number, price: number, multiplier = 100) => ({ side, quantity, price, multiplier });
  it("returns only the four documented fields", () => {
    expect(Object.keys(compareFillsWithReference({ price: 1, side: "buy", multiplier: 100 }, [fill("buy", 1, 1.1)])!).sort()).toEqual(["chosenLegFillPrice", "fillNetDollars", "referenceNetDollars", "slippagePct"]);
  });
  it("a buyback filled above its reference is positive slippage; below is negative", () => {
    expect(compareFillsWithReference({ price: 0.53, side: "buy", multiplier: 100 }, [fill("buy", 2, 0.6)])!.slippagePct).toBeCloseTo((0.07 / 0.53) * 100, 6);
    expect(compareFillsWithReference({ price: 0.53, side: "buy", multiplier: 100 }, [fill("buy", 2, 0.5)])!.slippagePct).toBeLessThan(0);
  });
  it("a share sale (multiplier 1) below its reference is positive slippage", () => {
    expect(compareFillsWithReference({ price: 31.12, side: "sell", multiplier: 1 }, [fill("sell", 50, 30, 1)])!.slippagePct).toBeCloseTo((1.12 / 31.12) * 100, 6);
  });
  it("fills of another side or multiplier never count as the chosen leg's", () => {
    expect(compareFillsWithReference({ price: 0.53, side: "buy", multiplier: 100 }, [fill("sell", 1, 0.6)])).toBeNull();
    expect(compareFillsWithReference({ price: 0.53, side: "buy", multiplier: 100 }, [fill("buy", 100, 0.6, 1)])).toBeNull();
  });
});

describe("watchPlutoOrder — the fill_slippage breaker", () => {
  const input = { actionId: "a1", orderId: "o1", symbol: "AUD", reference: { price: 0.53, side: "buy" as const, multiplier: 100 }, description: "Buy back 2× AUD $50P" };

  it("trips fill_slippage when a buyback fills more than maxFillSlippagePct above its reference", async () => {
    fillRows.push({ side: "BUY", quantity: 2, price: "0.60", multiplier: 100 });
    const result = await watchPlutoOrder(fakeApi(), settings, input, { pollIntervalMs: 0 });
    expect(result.outcome).toBe("filled");
    expect(tripPlutoBreaker).toHaveBeenCalledWith("fill_slippage", expect.stringContaining("filled at 0.60 vs reference 0.53 (13.2% past it, limit 5%)"));
    const update = vi.mocked(updatePlutoAction).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(update).toMatchObject({ outcome: "filled", fillPrice: 0.6 });
    expect(update).not.toHaveProperty("pessimisticPnl");
  });

  it("does not trip at exactly the limit, or on a better fill; tells Telegram instead", async () => {
    // 5% of 2.00 = 0.10: a sell filled at 1.90 is exactly at the limit (strictly greater trips).
    fillRows.push({ side: "SELL", quantity: 1, price: "1.90", multiplier: 100 });
    await watchPlutoOrder(fakeApi("filled", 1), settings, { ...input, reference: { price: 2, side: "sell", multiplier: 100 } }, { pollIntervalMs: 0 });
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
    fillRows.length = 0;
    fillRows.push({ side: "BUY", quantity: 2, price: "0.50", multiplier: 100 });
    await watchPlutoOrder(fakeApi(), settings, input, { pollIntervalMs: 0 });
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
    expect(notifyPlutoTelegram).toHaveBeenCalledWith(expect.stringContaining("avg fill 0.50"));
  });

  it("a partially filled cancel is still checked against the reference", async () => {
    fillRows.push({ side: "BUY", quantity: 1, price: "0.70", multiplier: 100 });
    await watchPlutoOrder(fakeApi("cancelled_partially_filled"), settings, input, { pollIntervalMs: 0 });
    expect(tripPlutoBreaker).toHaveBeenCalledWith("fill_slippage", expect.any(String));
  });

  it("a cancelled order with no fill trips nothing", async () => {
    const result = await watchPlutoOrder(fakeApi("cancelled"), settings, input, { pollIntervalMs: 0 });
    expect(result.outcome).toBe("cancelled");
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
  });
});

describe("watchPlutoOrder — fills recorded after the status (2026-10-08)", () => {
  const input = { actionId: "a1", orderId: "o1", symbol: "AUD", reference: { price: 0.53, side: "buy" as const, multiplier: 100 }, description: "Buy back 2× AUD $50P" };

  it("waits for a new contract's fills, written only at the reconciliation, then records the fill price", async () => {
    // 10-07: the order read filled at 10:14:55 ET, its fills were written at 10:15:38; the old 3-poll wait gave up first.
    const api = fakeApi();
    let polls = 0;
    vi.mocked((api as unknown as { get: () => unknown }).get).mockImplementation(async () => {
      polls += 1;
      if (polls === 6) fillRows.push({ side: "BUY", quantity: 2, price: "0.53", multiplier: 100 });
      return { id: "o1", status: "filled", errorMessage: null, updatedAt: new Date().toISOString(), payload: { legs: [{ role: "option", action: "BUY", unitPrice: 0.53, quantity: 2 }] } };
    });
    await watchPlutoOrder(api, settings, input, { pollIntervalMs: 0 });
    expect(polls).toBe(6);
    expect(vi.mocked(updatePlutoAction).mock.calls.at(-1)![1]).toMatchObject({ outcome: "filled", fillPrice: 0.53 });
  });

  it("fills still incomplete when the wait is over: no fill price, no slippage judgement, a warning instead", async () => {
    const { recordPlutoEvent } = await import("./ledger.js");
    // Half of the order recorded, e.g. a roll's buyback without its new leg: judged on that alone it would read as slippage.
    fillRows.push({ side: "BUY", quantity: 1, price: "0.90", multiplier: 100 });
    let clock = Date.now();
    await watchPlutoOrder(fakeApi(), settings, input, { pollIntervalMs: 0, now: () => (clock += 60_000) });
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
    expect(vi.mocked(updatePlutoAction).mock.calls.at(-1)![1]).toMatchObject({ outcome: "filled", fillPrice: null });
    expect(recordPlutoEvent).toHaveBeenCalledWith("warning", expect.objectContaining({ message: expect.stringContaining("not all recorded") }));
  });
});


describe("follow the mid (Marcelo 2026-11-07)", () => {
  const working = (unitPrice: number, extra: Record<string, unknown> = {}) => ({ id: "o1", status: "submitted", errorMessage: null, payload: { legs: [{ role: "option" as const, action: "SELL", unitPrice, quantity: 3 }], ...extra } });
  const followed = (priceNow: number | null) => ({ actionId: "a1", orderId: "o1", symbol: "NVDA", followTheMid: { priceNow: async () => priceNow } });
  const apiPosting = (post: () => Promise<unknown> = async () => ({})) => ({ get: vi.fn(), post: vi.fn(post) }) as never as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

  beforeEach(() => vi.mocked(recordPlutoEvent).mockClear());

  it("asks for the price now when it is a cent or more from the limit, and records the change", async () => {
    const api = apiPosting();
    expect(await followTheMidOnce(api as never, followed(1.07), working(1.5) as never)).toBe(true);
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/positions/orders/o1/reprice", { limitPrice: 1.07 });
    expect(vi.mocked(recordPlutoEvent)).toHaveBeenCalledWith("order_repriced", { actionId: "a1", orderId: "o1", symbol: "NVDA", from: 1.5, to: 1.07 });
  });

  it("leaves the order alone: same price, no price, a change still waiting for the worker", async () => {
    const api = apiPosting();
    expect(await followTheMidOnce(api as never, followed(1.5), working(1.5) as never)).toBe(true);
    expect(await followTheMidOnce(api as never, followed(null), working(1.5) as never)).toBe(true);
    expect(await followTheMidOnce(api as never, followed(1.4), working(1.5, { limitPriceChangeRequest: { limitPrice: 1.45, requestedAt: "x" } }) as never)).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("stops following after the order's 20th change, or when the route refuses (409)", async () => {
    expect(await followTheMidOnce(apiPosting() as never, followed(1.4), working(1.5, { limitPriceChanges: Array.from({ length: 19 }, () => ({ at: "x", from: 1.5, to: 1.49 })) }) as never)).toBe(true);
    const changes = Array.from({ length: 20 }, () => ({ at: "x", from: 1.5, to: 1.49 }));
    expect(await followTheMidOnce(apiPosting() as never, followed(1.4), working(1.5, { limitPriceChanges: changes }) as never)).toBe(false);
    const refusing = apiPosting(async () => {
      throw new InternalApiError(409, "Trading is halted.");
    });
    expect(await followTheMidOnce(refusing as never, followed(1.4), working(1.5) as never)).toBe(false);
    expect(vi.mocked(recordPlutoEvent)).toHaveBeenCalledWith("warning", expect.objectContaining({ orderId: "o1", message: expect.stringContaining("no longer followed") }));
  });

  it("the watch follows every 30 s, and judges the fill against the limit it filled at", async () => {
    // Sent at 1.50, changed to 1.40 and filled there: 6.7% under the first limit would trip the 5% breaker, 0% under its own does not.
    fillRows.push({ side: "SELL", quantity: 3, price: "1.40", multiplier: 100 });
    const responses = [working(1.5), working(1.4), { ...working(1.4), status: "filled", updatedAt: new Date().toISOString() }];
    const api = { get: vi.fn(async () => responses.shift()), post: vi.fn(async () => ({})) };
    let clock = 0;
    await watchPlutoOrder(api as never, settings, { actionId: "a1", orderId: "o1", symbol: "NVDA", reference: { price: 1.5, side: "sell", multiplier: 100 }, description: "Sell 3× NVDA $190 Call", followTheMid: { priceNow: async () => 1.4 } }, { pollIntervalMs: 0, now: () => (clock += 31_000) });
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/positions/orders/o1/reprice", { limitPrice: 1.4 });
    expect(vi.mocked(tripPlutoBreaker)).not.toHaveBeenCalled();
    const update = vi.mocked(updatePlutoAction).mock.calls.at(-1)![1] as { outcome: string; fillPrice: number };
    expect(update.outcome).toBe("filled");
    expect(update.fillPrice).toBeCloseTo(1.4, 9);
  });
});

describe("a followed order's fills, each against the limit IBKR held when it executed (Marcelo 2026-11-09)", () => {
  const changedAt = Date.parse("2026-11-09T15:03:00.000Z");
  // Sent at 1.05, changed to 1.29 at 15:03:00.
  const changes = [{ at: "2026-11-09T15:03:00.000Z", from: 1.05, to: 1.29 }];
  const filled = (extra: Record<string, unknown> = {}) => ({ id: "o1", status: "filled", errorMessage: null, updatedAt: new Date().toISOString(), payload: { legs: [{ role: "option", action: "SELL", unitPrice: 1.29, quantity: 4 }], limitPriceChanges: changes, ...extra } });
  const watch = (followTheMid: { priceNow: () => Promise<number | null> } | undefined) =>
    watchPlutoOrder({ get: vi.fn(async () => filled()), post: vi.fn(async () => ({})) } as never, settings, { actionId: "a1", orderId: "o1", symbol: "NVDA", reference: { price: 1.04, side: "sell", multiplier: 100 }, description: "Sell 4× NVDA $180 Call", ...(followTheMid ? { followTheMid } : {}) }, { pollIntervalMs: 0 });

  it("2 filled at 1.05 before the change and 2 at 1.29 after it: no slippage, no breaker (against the last limit alone it is 9.3%)", async () => {
    fillRows.push({ side: "SELL", quantity: 2, price: "1.05", multiplier: 100, executed_at: new Date(changedAt - 60_000) });
    fillRows.push({ side: "SELL", quantity: 2, price: "1.29", multiplier: 100, executed_at: new Date(changedAt + 60_000) });
    await watch({ priceNow: async () => null });
    expect(vi.mocked(tripPlutoBreaker)).not.toHaveBeenCalled();
  });

  it("all 4 filled at 1.20 a minute after the change to 1.29: 7.0% under its limit trips the 5% breaker", async () => {
    fillRows.push({ side: "SELL", quantity: 4, price: "1.20", multiplier: 100, executed_at: new Date(changedAt + 60_000) });
    await watch({ priceNow: async () => null });
    expect(vi.mocked(tripPlutoBreaker)).toHaveBeenCalledWith("fill_slippage", expect.stringContaining("vs its limits (average) 1.29 (7.0% past it"));
  });

  it("a fill seconds after the change may have met the limit before it: the kinder limit counts", async () => {
    fillRows.push({ side: "SELL", quantity: 4, price: "1.05", multiplier: 100, executed_at: new Date(changedAt + 5_000) });
    await watch({ priceNow: async () => null });
    expect(vi.mocked(tripPlutoBreaker)).not.toHaveBeenCalled();
  });

  it("an order adopted after a restart is judged against its own limits, not its action's reference", async () => {
    // Sent at 1.29 (the action's reference), moved down to 1.05 with the market and filled there: 18.6% under the
    // reference would trip the breaker, 0% under its own limit does not.
    const movedDown = { ...filled(), payload: { legs: [{ role: "option", action: "SELL", unitPrice: 1.05, quantity: 4 }], limitPriceChanges: [{ at: "2026-11-09T15:03:00.000Z", from: 1.29, to: 1.05 }] } };
    fillRows.push({ side: "SELL", quantity: 4, price: "1.05", multiplier: 100, executed_at: new Date(changedAt + 60_000) });
    await watchPlutoOrder({ get: vi.fn(async () => movedDown), post: vi.fn(async () => ({})) } as never, settings, { actionId: "a1", orderId: "o1", symbol: "NVDA", reference: { price: 1.29, side: "sell", multiplier: 100 }, description: "Sell 4× NVDA $180 Call" }, { pollIntervalMs: 0 });
    expect(vi.mocked(tripPlutoBreaker)).not.toHaveBeenCalled();
    const update = vi.mocked(updatePlutoAction).mock.calls.at(-1)![1] as { outcome: string; fillPrice: number };
    expect(update).toMatchObject({ outcome: "filled", fillPrice: 1.05 });
  });
});
