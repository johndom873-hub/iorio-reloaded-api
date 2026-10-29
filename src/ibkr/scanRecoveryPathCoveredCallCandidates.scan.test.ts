import { OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionQuote } from "./fetchOptionChain.js";

const mocks = vi.hoisted(() => ({
  storedChain: { expirations: [] as string[], strikesByExpiry: new Map<string, number[]>(), fetchedAt: null as Date | null },
  closeImpliedVolatility: null as number | null,
  impliedVolatilityTickerIds: [] as string[][],
  quoteRequests: [] as { symbol: string; contracts: { expiry: string; strike: number; right: string }[] }[],
  quotesToReturn: [] as unknown[],
  calendarContext: { resolved: true, events: [] as { eventType: "earnings" | "ex_dividend"; eventDate: string }[] },
  calendarTickerIds: [] as string[],
}));

vi.mock("../lib/volatilityScreen.js", () => ({
  loadCloseImpliedVolatilities: async (tickerIds: string[]) => {
    mocks.impliedVolatilityTickerIds.push(tickerIds);
    return new Map(mocks.closeImpliedVolatility === null ? [] : tickerIds.map((tickerId) => [tickerId, mocks.closeImpliedVolatility!]));
  },
}));
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRate: async () => 0 }));
// Every weekday from the faked day a session: what the yields are annualized over.
vi.mock("../lib/liveTradingSessions.js", async () => {
  const { sessionsHeldAmong } = await import("../lib/tradingSessionsHeld.js");
  return {
    loadLiveTradingSessions: async (now: Date = new Date()) => {
      const saleSessionIso = now.toISOString().slice(0, 10);
      const openDays = Array.from({ length: 60 }, (_, index) => new Date(now.getTime() + index * 86_400_000).toISOString().slice(0, 10)).filter((dateIso) => ![0, 6].includes(new Date(`${dateIso}T12:00:00Z`).getUTCDay()));
      return { saleSessionIso, openDays, sessionsHeldTo: (expiryIso: string) => sessionsHeldAmong(openDays, saleSessionIso, expiryIso) };
    },
  };
});
vi.mock("./fetchOptionChain.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetchOptionChain.js")>()),
  loadStoredOptionChain: async () => mocks.storedChain,
}));
vi.mock("./quoteContracts.js", () => ({
  quoteContracts: async (_ib: unknown, symbol: string, contracts: { expiry: string; strike: number; right: string }[]) => {
    mocks.quoteRequests.push({ symbol, contracts });
    return mocks.quotesToReturn;
  },
}));
vi.mock("./calendarConflict.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./calendarConflict.js")>()),
  fetchCalendarConflictContext: async (tickerId: string) => {
    mocks.calendarTickerIds.push(tickerId);
    return mocks.calendarContext;
  },
}));

import { scanRecoveryPathCoveredCallCandidates } from "./scanRecoveryPathCoveredCallCandidates.js";

const ib = {} as never;
const window = { deltaTargetMin: 0.2, deltaTargetMax: 0.3, dteTargetMin: 7, dteTargetMax: 45 };

function storeChain(strikesByExpiry: Record<string, number[]>, expirations = Object.keys(strikesByExpiry)): void {
  mocks.storedChain = { expirations, strikesByExpiry: new Map(Object.entries(strikesByExpiry)), fetchedAt: new Date() };
}
const callQuote = (expiry: string, strike: number, overrides: Partial<OptionQuote> = {}): OptionQuote => ({
  expiry, strike, right: OptionType.Call, bid: 1.0, ask: 1.2, last: 1.05, impliedVolatility: 0.4, delta: 0.25, gamma: 0.02, vega: 0.1, theta: -0.05, ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  // 11:00 Eastern on 2026-10-06: 2026-10-16 is 10 days out, 2026-10-23 is 17, 2026-11-20 is 45, 2026-11-21 is 46.
  vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  mocks.storedChain = { expirations: [], strikesByExpiry: new Map(), fetchedAt: null };
  mocks.closeImpliedVolatility = null;
  mocks.impliedVolatilityTickerIds.length = 0;
  mocks.quoteRequests.length = 0;
  mocks.quotesToReturn = [];
  mocks.calendarContext = { resolved: true, events: [] };
  mocks.calendarTickerIds.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scanRecoveryPathCoveredCallCandidates: which contracts get quoted", () => {
  it("returns nothing and warns when no strike grids are stored", async () => {
    expect(await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("AAPL: option chain not prepared yet (no stored strike grids) — no covered-call candidates.");
    expect(mocks.quoteRequests).toEqual([]);
  });

  it("quotes only the two nearest expiries inside the DTE window, ascending", async () => {
    storeChain({
      "20261009": [105, 110], // 3 days: below the 7-day minimum
      "20261030": [105], // 24
      "20261016": [105], // 10
      "20261023": [105], // 17
      "20261120": [105], // 45: inside, but the third nearest
      "20261121": [105], // 46: outside
    });
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);
    expect(mocks.quoteRequests[0]!.contracts.map((contract) => contract.expiry)).toEqual(["20261016", "20261023"]);
  });

  it("includes an expiry exactly at the minimum and the maximum DTE", async () => {
    storeChain({ "20261013": [105], "20261120": [105] }); // 7 and 45 days
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);
    expect(mocks.quoteRequests[0]!.contracts.map((contract) => contract.expiry)).toEqual(["20261013", "20261120"]);
  });

  it("takes expiries from the stored expiration list: an expiry without a stored grid is dropped", async () => {
    storeChain({ "20261016": [105] }, ["20261016", "20261023"]);
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);
    expect(mocks.quoteRequests[0]!.contracts.map((contract) => contract.expiry)).toEqual(["20261016"]);
  });

  it("quotes only calls out of the money: strikes above spot up to 40% above, ascending, spot itself excluded", async () => {
    storeChain({ "20261016": [140.01, 140, 130, 100, 99, 101, 105, 120] });
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);
    expect(mocks.quoteRequests[0]!.contracts).toEqual([101, 105, 120, 130, 140].map((strike) => ({ expiry: "20261016", strike, right: OptionType.Call })));
  });

  it("caps the strikes per expiry at the 50 nearest", async () => {
    storeChain({ "20261016": Array.from({ length: 80 }, (_, index) => 100.5 + index * 0.25) });
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);
    const strikes = mocks.quoteRequests[0]!.contracts.map((contract) => contract.strike);
    expect(strikes).toHaveLength(50);
    expect(strikes[0]).toBe(100.5);
    expect(strikes[49]).toBe(100.5 + 49 * 0.25);
  });

  it("drops an expiry with no out-of-the-money strike and quotes nothing when none is left", async () => {
    storeChain({ "20261016": [90, 95, 100], "20261023": [90] });
    expect(await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window)).toEqual([]);
    expect(mocks.quoteRequests).toEqual([]);
  });

  it("trims the strikes by deltas estimated at the ticker's 30-day IV, quoting the full band without one", async () => {
    storeChain({ "20261016": [101, 103, 105, 107, 110] });
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "ticker-9", 100, window);
    expect(mocks.quoteRequests[0]!.contracts.map((contract) => contract.strike)).toEqual([101, 103, 105, 107, 110]);
    expect(mocks.impliedVolatilityTickerIds).toEqual([["ticker-9"]]);
    // At 40% IV, 10 days out, spot 100, no rate: call |delta| ≈ 0.45, 0.34, 0.24, 0.16, 0.08. Band 0.2-0.3 with the 0.1
    // margin keeps 0.1..0.4: 101 and 110 are dropped.
    mocks.closeImpliedVolatility = 0.4;
    mocks.quoteRequests.length = 0;
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "ticker-9", 100, window);
    expect(mocks.quoteRequests[0]!.contracts.map((contract) => contract.strike)).toEqual([103, 105, 107]);
  });

  it("quotes the symbol once for all expiries, and loads the calendar for the ticker", async () => {
    storeChain({ "20261016": [105], "20261023": [105] });
    await scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "ticker-9", 100, window);
    expect(mocks.quoteRequests).toHaveLength(1);
    expect(mocks.quoteRequests[0]!.symbol).toBe("AAPL");
    expect(mocks.calendarTickerIds).toEqual(["ticker-9"]);
  });
});

describe("scanRecoveryPathCoveredCallCandidates: ranking the quotes", () => {
  beforeEach(() => storeChain({ "20261016": [105], "20261023": [105] }));
  const scan = () => scanRecoveryPathCoveredCallCandidates(ib, "AAPL", "t1", 100, window);

  it("builds a candidate from the mid, with the yield premium / (spot − premium) × 252 / sessions held", async () => {
    // Tuesday 6 October to Friday 16 October: 9 sessions.
    mocks.quotesToReturn = [callQuote("20261016", 105, { bid: 1.0, ask: 1.4, delta: 0.25 })];
    const [candidate] = await scan();
    expect(candidate).toEqual({
      expiry: "2026-10-16",
      strike: 105,
      right: "call",
      delta: 0.25,
      premium: 1.2,
      bid: 1.0,
      ask: 1.4,
      dte: 10,
      annualizedYield: (1.2 / (100 - 1.2)) * (252 / 9),
      spotPrice: 100,
      calendarUnverified: false,
    });
  });

  it("uses the last price when the quote is not two-sided, and reports bid and ask as stored", async () => {
    mocks.quotesToReturn = [callQuote("20261016", 105, { bid: null, ask: 1.3, last: 0.9 })];
    const [candidate] = await scan();
    expect(candidate).toMatchObject({ premium: 0.9, bid: null, ask: 1.3 });
  });

  it("skips quotes with no usable premium: no last when one-sided, a zero or negative mid", async () => {
    mocks.quotesToReturn = [
      callQuote("20261016", 105, { bid: null, ask: null, last: null }),
      callQuote("20261016", 106, { bid: 0, ask: 0, last: 0.5 }),
      callQuote("20261016", 107, { bid: null, ask: null, last: 0 }),
      callQuote("20261016", 108, { bid: -0.2, ask: 0.1, last: 0.5 }),
    ];
    expect(await scan()).toEqual([]);
  });

  it("filters by |delta| inside the target band, ends included, and skips a missing delta", async () => {
    mocks.quotesToReturn = [
      callQuote("20261016", 101, { delta: 0.2 }),
      callQuote("20261016", 102, { delta: 0.3 }),
      callQuote("20261016", 103, { delta: 0.1999 }),
      callQuote("20261016", 104, { delta: 0.3001 }),
      callQuote("20261016", 105, { delta: null }),
      callQuote("20261016", 106, { delta: -0.25 }),
    ];
    expect((await scan()).map((candidate) => candidate.strike).sort()).toEqual([101, 102, 106]);
  });

  it("ignores puts", async () => {
    mocks.quotesToReturn = [callQuote("20261016", 105, { right: OptionType.Put })];
    expect(await scan()).toEqual([]);
  });

  it("skips a quote whose expiry is today or past", async () => {
    mocks.quotesToReturn = [callQuote("20261006", 105), callQuote("20261005", 106)];
    expect(await scan()).toEqual([]);
  });

  it("ranks by annualized yield, highest first, so a nearer cheaper contract can outrank a farther dearer one", async () => {
    mocks.quotesToReturn = [
      callQuote("20261023", 105, { bid: 2.0, ask: 2.2 }), // 2.1 / 97.9 × 252/14 = 0.386
      callQuote("20261016", 104, { bid: 1.0, ask: 1.2 }), // 1.1 / 98.9 × 252/9 = 0.311
      callQuote("20261016", 106, { bid: 1.5, ask: 1.7 }), // 1.6 / 98.4 × 252/9 = 0.455
    ];
    expect((await scan()).map((candidate) => candidate.strike)).toEqual([106, 105, 104]);
  });

  it("drops an expiry that spans an earnings date on or before it, for calls also an ex-dividend date", async () => {
    mocks.calendarContext = { resolved: true, events: [{ eventType: "earnings", eventDate: "2026-10-20" }, { eventType: "ex_dividend", eventDate: "2026-10-12" }] };
    mocks.quotesToReturn = [callQuote("20261016", 105), callQuote("20261023", 105)];
    // 10-16 is crossed by the 10-12 ex-dividend; 10-23 by both: nothing survives.
    expect(await scan()).toEqual([]);
  });

  it("keeps an expiry that ends before the next event", async () => {
    mocks.calendarContext = { resolved: true, events: [{ eventType: "earnings", eventDate: "2026-10-20" }] };
    mocks.quotesToReturn = [callQuote("20261016", 105), callQuote("20261023", 105)];
    expect((await scan()).map((candidate) => candidate.expiry)).toEqual(["2026-10-16"]);
  });

  it("flags every candidate as calendar-unverified, without excluding any, when the ticker has no TradingView symbol", async () => {
    mocks.calendarContext = { resolved: false, events: [] };
    mocks.quotesToReturn = [callQuote("20261016", 105)];
    expect((await scan()).map((candidate) => candidate.calendarUnverified)).toEqual([true]);
  });

  it("returns an empty list when no quote is usable", async () => {
    mocks.quotesToReturn = [];
    expect(await scan()).toEqual([]);
  });
});
