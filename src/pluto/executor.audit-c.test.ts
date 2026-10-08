import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit C (2026-10-07): the pessimistic fill figure is gone; the fill-slippage breaker must behave exactly as before.
// watchPlutoOrder runs against a fake order API and a fake trades read; ledger, breaker and Telegram are mocked.

const fillRows: { side: string; quantity: number; price: string; multiplier: number }[] = [];
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

const { compareFillsWithReference, watchPlutoOrder, executePlutoClose } = await import("./executor.js");
const { updatePlutoAction } = await import("./ledger.js");
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

describe("executePlutoClose — route refusals", () => {
  const closeInput = { actionId: "a1", symbol: "AUD", positionId: "p1", legs: [{ legId: "l1", limitPrice: 0.53 }], description: "Buy back", reasons: ["automatic close: Formula P3"] };
  it("a 409 from the close route (close gate, active order) is a blocked action, not a breaker", async () => {
    const api = { post: vi.fn(async () => { throw new InternalApiError(409, "An order for this position is already in progress"); }) } as never;
    const result = await executePlutoClose(api, settings, closeInput);
    expect(result.outcome).toBe("blocked");
    expect(tripPlutoBreaker).not.toHaveBeenCalled();
  });
  it("a 500 from the close route trips order_error", async () => {
    const api = { post: vi.fn(async () => { throw new InternalApiError(500, "boom"); }) } as never;
    const result = await executePlutoClose(api, settings, closeInput);
    expect(result.outcome).toBe("error");
    expect(tripPlutoBreaker).toHaveBeenCalledWith("order_error", expect.stringContaining("build failed"));
  });
});
