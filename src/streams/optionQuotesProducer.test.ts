import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamedOptionQuote } from "../ibkr/streamOptionQuotes.js";

const mocks = vi.hoisted(() => ({
  pushStock: null as ((quote: { last: number | null; bid: number | null; ask: number | null }) => void) | null,
  pushOptions: null as ((quotes: StreamedOptionQuote[]) => void) | null,
}));

vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: async (_contract: unknown, push: (quote: { last: number | null; bid: number | null; ask: number | null }) => void) => {
    mocks.pushStock = push;
    return () => {};
  },
}));
vi.mock("../ibkr/streamOptionQuotes.js", () => ({
  streamOptionQuotes: (_symbol: string, _contracts: unknown, onUpdate: (quotes: StreamedOptionQuote[]) => void, signal: AbortSignal) => {
    mocks.pushOptions = onUpdate;
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  },
}));
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRate: async () => 0.04 }));
vi.mock("../lib/marketSessionStatus.js", () => ({ loadTradingSessionsBetween: async () => [{ closeMinutesEt: 16 * 60 }] }));

import { optionQuotesProducer } from "./optionQuotesProducer.js";

describe("optionQuotesProducer", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-28T15:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("sends each contract's bid and ask sizes with its prices, null when IBKR sent none", async () => {
    const emit = vi.fn();
    const controller = new AbortController();
    const parameters = optionQuotesProducer.parseParameters({ symbol: "SMCI", contracts: ["2027-04-16|90|C", "2027-04-16|80|P"] });
    const running = optionQuotesProducer.run(parameters, { userId: "user" }, emit, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    mocks.pushStock!({ last: 88.55, bid: null, ask: null });
    mocks.pushOptions!([
      { expiry: "2027-04-16", strike: 90, right: "C", bid: 12.8, ask: 16.8, bidSize: 6, askSize: 10, delta: 0.5 },
      { expiry: "2027-04-16", strike: 80, right: "P", bid: null, ask: null, bidSize: null, askSize: null, delta: null },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    const frame = emit.mock.calls.at(-1)![0];
    expect(frame).toMatchObject({ type: "optionQuotes", spotPrice: 88.55 });
    expect(frame.quotes["2027-04-16|90|C"]).toMatchObject({ bid: 12.8, ask: 16.8, bidSize: 6, askSize: 10 });
    expect(frame.quotes["2027-04-16|80|P"]).toMatchObject({ bid: null, ask: null, bidSize: null, askSize: null });

    controller.abort();
    await running;
  });
});
