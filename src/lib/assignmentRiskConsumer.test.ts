import { describe, expect, it, vi } from "vitest";
import type { AssignmentRiskAlertState, HeldShortLeg } from "./assignmentRiskAlerts.js";
import { createAssignmentRiskConsumer, type AssignmentRiskConsumerDependencies } from "./assignmentRiskConsumer.js";
import type { QuoteLoopCycle, QuoteLoopOptionQuote } from "./marketQuoteLoop.js";

const leg: HeldShortLeg = { legId: "leg-1", positionId: "pos-1", tickerId: "t1", symbol: "AAA", strategyKey: "cash_secured_put", expiry: "2026-11-06", strike: 100, right: "P" };
const cycle = (spot: number): QuoteLoopCycle => ({ tradingDateIso: "2026-10-27", cycleNumber: 1, now: new Date("2026-10-27T15:00:00Z"), spotByTicker: new Map([["t1", spot]]), impliedVolatilityByTicker: new Map() });
const putQuote = (bid: number, ask: number): QuoteLoopOptionQuote => ({ contract: { tickerId: "t1", symbol: "AAA", expiry: leg.expiry, strike: leg.strike, right: "P" }, bid, ask, last: null, errorCode: null, quotedAt: new Date("2026-10-27T15:00:00Z") });

function setup(state: AssignmentRiskAlertState) {
  const deps: AssignmentRiskConsumerDependencies = {
    loadHeldShortLegs: async () => [leg],
    loadAlertStates: async () => new Map([[leg.legId, state]]),
    recordAlert: vi.fn(async () => {}),
    rearmAlert: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    riskFreeRate: async () => 0.04,
    sessionCloseMinutesEt: async () => 16 * 60,
  };
  return { deps, consumer: createAssignmentRiskConsumer(deps) };
}

describe("assignment-risk consumer", () => {
  it("quotes every held short leg and alerts one whose own delta reached 0.50", async () => {
    const { deps, consumer } = setup({ notifiedAt: null, lastAlertTradingDateIso: null });
    expect(await consumer.tickers("2026-10-27", new Date())).toEqual([{ tickerId: "t1", symbol: "AAA" }]);
    expect(await consumer.contracts(cycle(98))).toEqual([{ tickerId: "t1", symbol: "AAA", expiry: "2026-11-06", strike: 100, right: "P" }]);
    // Spot $98 under a $100 Put with 10 days left, priced deep enough that its delta is past -0.50.
    await consumer.onCycleComplete!([putQuote(3.2, 3.4)], cycle(98));
    expect(deps.recordAlert).toHaveBeenCalledWith("leg-1", "2026-10-27");
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAA", leg: expect.objectContaining({ legId: "leg-1", dte: 10 }) }));
  });

  it("stays quiet for a far out-of-the-money leg and re-arms a flagged one that fell back", async () => {
    const { deps, consumer } = setup({ notifiedAt: "2026-10-26T15:00:00Z", lastAlertTradingDateIso: "2026-10-26" });
    await consumer.tickers("2026-10-27", new Date());
    await consumer.onCycleComplete!([putQuote(0.2, 0.25)], cycle(110));
    expect(deps.rearmAlert).toHaveBeenCalledWith("leg-1");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("skips a leg with no two-sided quote", async () => {
    const { deps, consumer } = setup({ notifiedAt: null, lastAlertTradingDateIso: null });
    await consumer.tickers("2026-10-27", new Date());
    await consumer.onCycleComplete!([{ ...putQuote(3.2, 3.4), bid: null }], cycle(98));
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
