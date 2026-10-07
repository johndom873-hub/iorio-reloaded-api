import type { IBApi } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";

// Audit D (2026-10-07): the Day Signals loop's look bookkeeping (first sight, 15-minute gap, hourly re-check) driven with fakes,
// the same way daySignalsLoop.test.ts drives it. Telegram is mocked in case anything reaches it.
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { blackScholesPriceOnForward, sviTotalVariance } = await import("./impliedVolatilitySurface.js");
const { DaySignalsLoop } = await import("./daySignalsLoop.js");
import type { RawSviParameters } from "./impliedVolatilitySurface.js";
import type { DaySignalsLoopDependencies } from "./daySignalsLoop.js";
import type { WindowContract, WindowQuote } from "../ibkr/daySignalsQuoteWindow.js";
import type { SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";
import type { DayRerankState } from "./daySignalsStore.js";
import type { DayTickerContractContext, DayTrackedTicker } from "./daySignalsContractContextStore.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const expiry = "2026-10-21";
const tradingDateIso = "2026-09-24";
const startIso = "2026-09-24T15:00:00Z";
const slice: SignalSurfaceSlice = { expiry, status: "ok", parameters: params, kMin: -0.4, kMax: 0.4, yearsToExpiry: years30, forwardPrice: forward, pointCount: 20, rmseVolatility: 0.01, minButterflyDensity: 0.8, droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 }, calendarChecks: 0, calendarViolations: 0 };
const surfaceIvAt = (strike: number) => Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years30);
const strikes: [number, "C" | "P"][] = [[80, "P"], [85, "P"], [90, "P"], [95, "P"], [105, "C"], [110, "C"]];
const listedStrikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
const settings = { minAnnualizedYieldPct: 0, deltaTargetMin: 0, deltaTargetMax: 1, recoveryDteMin: 1, recoveryDteMax: 14, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0, commissionWarnSharePctOfPremium: 5, priceCheckMaxDeviationPct: 10, priceCheckMinToleranceDollars: 0.05, spreadCostChargedPct: 100, orderUnfilledCancelMinutes: 15 };

function quoteAt(strike: number, right: "C" | "P"): SignalQuote {
  const mid = blackScholesPriceOnForward(forward, strike, years30, rate, surfaceIvAt(strike), right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}

function inputsFor(tickerId: string, symbol: string): TickerSignalsInputs {
  return {
    tickerId,
    symbol,
    companyName: null,
    sector: null,
    header: { snapshotId: `s-${tickerId}`, tradingDateIso, capturedAt: `${tradingDateIso}T14:00:00Z`, underlyingPrice: forward, riskFreeRatePercent: rate * 100, fitCompletedAt: "2026-09-24T14:06:00Z", fitIssue: null },
    slices: [slice],
    quotes: strikes.map(([strike, right]) => quoteAt(strike, right)),
    dayQuotes: [],
    forecast: { volatility: surfaceIvAt(100) - 0.02, windowDays: 63 },
    suspectedSplitDateIso: null,
    earningsDatesIso: [],
    earningsCalendarResolved: true,
    macroEvents: [],
    momentum: null,
    elevatedVolatility: null,
    skew: null,
    nextEarningsDateIso: null,
    previousClose: null,
    freeShares: 0,
    openShortLegs: [],
    dailyBarCount: 1000,
    dividendCadenceUnknown: false,
    todayEasternIso: tradingDateIso,
  };
}

function contextFor(tickerId: string, symbol: string, overrides: Partial<DayTickerContractContext> = {}): DayTickerContractContext {
  return { tickerId, symbol, snapshotId: `s-${tickerId}`, snapshotSpotPrice: 100, atmImpliedVolatility: 0.8, strikesByExpiry: new Map([[expiry, listedStrikes]]), heldContracts: [], previousContracts: [], ...overrides };
}

interface AuditHarness {
  deps: DaySignalsLoopDependencies;
  loop: InstanceType<typeof DaySignalsLoop>;
  state: { nowIso: string; spots: Map<string, number | null>; contexts: Map<string, DayTickerContractContext>; rerankStates: Map<string, DayRerankState>; unpooledTickers: DayTrackedTicker[]; loadRerankStatesFails: boolean; saveFails: boolean; discoveryDisconnects: boolean };
  calls: { discoveries: string[]; mainWindows: number; saves: { tickerId: string; state: DayRerankState }[]; failures: string[] };
}

/** t1 (AAA) is pooled; unpooled tickers come from state.unpooledTickers. Stops after `cycles` main windows. */
function createAuditHarness(cycles: number): AuditHarness {
  const state: AuditHarness["state"] = { nowIso: startIso, spots: new Map([["t1", 100]]), contexts: new Map(), rerankStates: new Map(), unpooledTickers: [], loadRerankStatesFails: false, saveFails: false, discoveryDisconnects: false };
  const calls: AuditHarness["calls"] = { discoveries: [], mainWindows: 0, saves: [], failures: [] };
  const symbols = new Map<string, string>([["t1", "AAA"]]);
  const deps: DaySignalsLoopDependencies = {
    now: () => new Date(state.nowIso),
    isMarketOpen: async () => true,
    loadPool: async () => [{ tickerId: "t1", symbol: "AAA", expiry, tradingDateIso, snapshotId: "s-t1", rank: 1 }],
    loadUniverse: async () => strikes.map(([strike, right]) => ({ tickerId: "t1", symbol: "AAA", expiry, strike, right })),
    reserveLines: async () => ({ ok: true, availableLines: 80, priorityLinesHeld: 0 }),
    releaseLines: async () => {},
    borrowLiveConnection: async () => ({ ib: {} as IBApi }),
    allocateReqId: () => 1,
    runSpotPass: async (contracts, options) => {
      for (const contract of contracts) {
        const tickerId = contract.key.split("|")[0]!;
        options.onSettled(contract, { bid: null, ask: null, last: state.spots.get(tickerId) ?? null, errorCode: null, timedOut: false, settledAt: new Date(state.nowIso) });
      }
      return { settled: contracts.length, disconnected: false, aborted: false };
    },
    runQuoteWindow: async (contracts, options) => {
      const isDiscovery = !contracts.some((contract) => contract.key.endsWith("|stock"));
      if (isDiscovery) {
        calls.discoveries.push(contracts[0]!.key.split("|")[0]!);
        if (state.discoveryDisconnects) return { settled: 0, disconnected: true, aborted: false };
      }
      for (const contract of contracts as WindowContract[]) {
        const quote: WindowQuote =
          contract.legType === "stock"
            ? { bid: null, ask: null, last: 100, errorCode: null, timedOut: false, settledAt: new Date(state.nowIso) }
            : (() => {
                const mid = blackScholesPriceOnForward(forward, contract.strike!, years30, rate, surfaceIvAt(contract.strike!) + 0.05, contract.right === "C");
                return { bid: mid * 0.98, ask: mid * 1.02, last: null, errorCode: null, timedOut: false, settledAt: new Date(state.nowIso) };
              })();
        options.onSettled(contract, quote);
      }
      if (!isDiscovery) {
        calls.mainWindows += 1;
        if (calls.mainWindows >= cycles) loop.stop();
      }
      return { settled: contracts.length, disconnected: false, aborted: false };
    },
    upsertDayQuotes: async () => {},
    loadContractContexts: async () => state.contexts,
    loadUnpooledTickers: async () => state.unpooledTickers,
    pruneDayQuotes: async () => {},
    loadRerankStates: async () => {
      if (state.loadRerankStatesFails) throw new Error("canceling statement due to statement timeout");
      return new Map(state.rerankStates);
    },
    saveRerankState: async (tickerId, _date, saved) => {
      if (state.saveFails) throw new Error("connection terminated");
      calls.saves.push({ tickerId, state: saved });
      state.rerankStates.set(tickerId, saved);
    },
    replaceTickerPool: async () => false,
    loadTickerSignalsInputs: async (ticker) => inputsFor(ticker.tickerId, symbols.get(ticker.tickerId) ?? ticker.symbol),
    loadAccountContext: async () => ({ freeCash: 1_000_000 }),
    loadTradingSettings: async () => settings,
    loadLastGrades: async () => new Map(),
    updateDayQuoteGrades: async () => {},
    notifyUpgrade: async () => {},
    loadLastRollGrades: async () => new Map(),
    upsertRollGrades: async () => {},
    notifyRollUpgrade: async () => {},
    loadAssignmentRiskAlertStates: async () => new Map(),
    recordAssignmentRiskAlert: async () => {},
    rearmAssignmentRiskAlert: async () => {},
    notifyAssignmentRisk: async () => {},
    emitUpdated: () => {},
    writeHeartbeat: async () => {},
    reportFailure: (source) => {
      calls.failures.push(source);
    },
    reportRecovery: () => {},
    sleep: async () => {},
  };
  const loop = new DaySignalsLoop(deps);
  const harness: AuditHarness = { deps, loop, state, calls };
  // Unpooled tickers' symbols for the inputs fake.
  const originalUnpooled = deps.loadUnpooledTickers;
  deps.loadUnpooledTickers = async (date) => {
    const tickers = await originalUnpooled(date);
    for (const ticker of tickers) symbols.set(ticker.tickerId, ticker.symbol);
    return tickers;
  };
  return harness;
}

/** Advances the clock before every spot pass: minutesPerCycle[i] is cycle i's offset from startIso. */
function withClock(harness: AuditHarness, minuteOffsets: number[]): void {
  let cycle = 0;
  const originalSpotPass = harness.deps.runSpotPass;
  harness.deps.runSpotPass = async (contracts, options) => {
    harness.state.nowIso = new Date(Date.parse(startIso) + minuteOffsets[Math.min(cycle, minuteOffsets.length - 1)]! * 60_000).toISOString();
    cycle += 1;
    return originalSpotPass(contracts, options);
  };
}

const minutesAgo = (minutes: number) => new Date(Date.parse(startIso) - minutes * 60_000);
const unpooled = (tickerId: string, symbol: string): DayTrackedTicker => ({ tickerId, symbol, snapshotId: `s-${tickerId}` });

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

describe("DaySignalsLoop look bookkeeping — audit D", () => {
  it("first sight is saved once per ticker (pooled and unpooled) and never moved by later cycles", async () => {
    const harness = createAuditHarness(3);
    harness.state.unpooledTickers = [unpooled("t2", "BBB")];
    harness.state.spots.set("t2", 100);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")], ["t2", contextFor("t2", "BBB")]]);
    withClock(harness, [0, 5, 10]);
    await harness.loop.start();
    const firstSightSaves = harness.calls.saves.filter((save) => save.state.lastLookAt === null);
    expect(firstSightSaves.map((save) => save.tickerId).sort()).toEqual(["t1", "t2"]);
    for (const tickerId of ["t1", "t2"]) expect(harness.state.rerankStates.get(tickerId)).toEqual({ referenceSpotPrice: 100, reranks: 0, firstSeenAt: new Date(startIso), lastLookAt: null, lastLookKind: null });
    expect(harness.calls.discoveries).toEqual([]);
  });

  it("a ticker with no spot, no context or no ATM IV is not first-seen (its hourly clock does not start)", async () => {
    const harness = createAuditHarness(1);
    harness.state.unpooledTickers = [unpooled("t2", "BBB"), unpooled("t3", "CCC"), unpooled("t4", "DDD")];
    harness.state.spots.set("t2", null);
    harness.state.spots.set("t3", 100);
    harness.state.spots.set("t4", 100);
    harness.state.contexts = new Map([["t2", contextFor("t2", "BBB")], ["t4", contextFor("t4", "DDD", { atmImpliedVolatility: null })]]);
    await harness.loop.start();
    expect([...harness.state.rerankStates.keys()]).toEqual([]);
  });

  it("a restarted loop keeps the stored first sight, so the hourly re-check is not pushed back by a restart", async () => {
    const harness = createAuditHarness(1);
    harness.state.unpooledTickers = [unpooled("t2", "BBB")];
    harness.state.spots.set("t2", 100);
    harness.state.contexts = new Map([["t2", contextFor("t2", "BBB")]]);
    harness.state.rerankStates.set("t2", { referenceSpotPrice: 100, reranks: 0, firstSeenAt: minutesAgo(61), lastLookAt: null, lastLookKind: null });
    await harness.loop.start();
    expect(harness.calls.discoveries).toEqual(["t2"]);
    expect(harness.state.rerankStates.get("t2")).toMatchObject({ firstSeenAt: minutesAgo(61), lastLookAt: new Date(startIso), lastLookKind: "timed", reranks: 1 });
  });

  it("a row saved before today's migration (no first_seen_at) keeps its reference and count when first seen", async () => {
    const harness = createAuditHarness(1);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")]]);
    harness.state.spots.set("t1", 101); // 1% from the stored reference 100.5... under the 2.52% trigger
    harness.state.rerankStates.set("t1", { referenceSpotPrice: 100.5, reranks: 3, firstSeenAt: null, lastLookAt: null, lastLookKind: null });
    await harness.loop.start();
    expect(harness.state.rerankStates.get("t1")).toEqual({ referenceSpotPrice: 100.5, reranks: 3, firstSeenAt: new Date(startIso), lastLookAt: null, lastLookKind: null });
    expect(harness.calls.discoveries).toEqual([]);
  });

  it("runs every price look at once and at most one timed look in the same cycle", async () => {
    const harness = createAuditHarness(1);
    harness.state.unpooledTickers = [unpooled("t2", "BBB"), unpooled("t3", "CCC"), unpooled("t4", "DDD")];
    harness.state.spots.set("t1", 110); // pooled, past the trigger
    harness.state.spots.set("t2", 110); // unpooled, past the trigger
    harness.state.spots.set("t3", 100); // overdue (90 min)
    harness.state.spots.set("t4", 100); // overdue (70 min)
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")], ["t2", contextFor("t2", "BBB")], ["t3", contextFor("t3", "CCC")], ["t4", contextFor("t4", "DDD")]]);
    harness.state.rerankStates.set("t3", { referenceSpotPrice: 100, reranks: 0, firstSeenAt: minutesAgo(90), lastLookAt: null, lastLookKind: null });
    harness.state.rerankStates.set("t4", { referenceSpotPrice: 100, reranks: 0, firstSeenAt: minutesAgo(70), lastLookAt: null, lastLookKind: null });
    await harness.loop.start();
    expect(harness.calls.discoveries).toEqual(["t1", "t2", "t3"]);
    expect(harness.state.rerankStates.get("t1")!.lastLookKind).toBe("price");
    expect(harness.state.rerankStates.get("t2")!.lastLookKind).toBe("price");
    expect(harness.state.rerankStates.get("t3")!.lastLookKind).toBe("timed");
    expect(harness.state.rerankStates.get("t4")!.lastLookAt).toBeNull();
  });

  it("a connection drop during a look saves the look first: the next cycle (inside 15 minutes) does not look again", async () => {
    const harness = createAuditHarness(1);
    harness.state.spots.set("t1", 110);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")]]);
    harness.state.discoveryDisconnects = true;
    withClock(harness, [0, 1]);
    await harness.loop.start();
    // Cycle 1 dropped inside the discovery (no main window); cycle 2 ran its main window without a second discovery.
    expect(harness.calls.discoveries).toEqual(["t1"]);
    expect(harness.calls.mainWindows).toBe(1);
    expect(harness.state.rerankStates.get("t1")).toMatchObject({ referenceSpotPrice: 110, reranks: 1, lastLookAt: new Date(startIso), lastLookKind: "price" });
  });

  it("a stop during a price look skips the cycle's timed look", async () => {
    const harness = createAuditHarness(5);
    harness.state.unpooledTickers = [unpooled("t3", "CCC")];
    harness.state.spots.set("t1", 110);
    harness.state.spots.set("t3", 100);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")], ["t3", contextFor("t3", "CCC")]]);
    harness.state.rerankStates.set("t3", { referenceSpotPrice: 100, reranks: 0, firstSeenAt: minutesAgo(90), lastLookAt: null, lastLookKind: null });
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      const result = await originalWindow(contracts, options);
      if (!contracts.some((contract) => contract.key.endsWith("|stock"))) harness.loop.stop();
      return result;
    };
    await harness.loop.start();
    expect(harness.calls.discoveries).toEqual(["t1"]);
    expect(harness.state.rerankStates.get("t3")!.lastLookAt).toBeNull();
  });

  // A transient read failure (statement timeout, pool acquire timeout) makes the loop assume no state, then the first-sight
  // branch SAVES that assumption over every ticker's real row: the 15-minute gap and the hourly clock are reset and the
  // reference goes back to the 10:00 spot, so a ticker looked at 5 minutes ago is looked at again at once.
  it("a failed re-rank state read neither overwrites the stored look nor bypasses the 15-minute gap", async () => {
    const harness = createAuditHarness(1);
    harness.state.unpooledTickers = [unpooled("t2", "BBB")];
    harness.state.spots.set("t2", 110); // 10% above the 10:00 spot, 0% from the last look's reference
    harness.state.contexts = new Map([["t2", contextFor("t2", "BBB")]]);
    const stored: DayRerankState = { referenceSpotPrice: 110, reranks: 2, firstSeenAt: minutesAgo(120), lastLookAt: minutesAgo(5), lastLookKind: "price" };
    harness.state.rerankStates.set("t2", stored);
    harness.state.loadRerankStatesFails = true;
    await harness.loop.start();
    expect(harness.calls.failures).toContain("day-signals:rerank-state");
    expect(harness.calls.discoveries).toEqual([]);
    expect(harness.state.rerankStates.get("t2")).toEqual(stored);
  });

  it("a failing save is reported and the cycle still completes", async () => {
    const harness = createAuditHarness(1);
    harness.state.spots.set("t1", 110);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")]]);
    harness.state.saveFails = true;
    await harness.loop.start();
    expect(harness.calls.failures).toContain("day-signals:rerank-state-save");
    expect(harness.calls.mainWindows).toBe(1);
  });

  it("stamps each look with the moment it starts (after the previous look's discovery), so its 15-minute gap is real", async () => {
    const harness = createAuditHarness(1);
    harness.state.unpooledTickers = [unpooled("t2", "BBB")];
    harness.state.spots.set("t1", 110);
    harness.state.spots.set("t2", 110);
    harness.state.contexts = new Map([["t1", contextFor("t1", "AAA")], ["t2", contextFor("t2", "BBB")]]);
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      // Each discovery takes a minute.
      if (!contracts.some((contract) => contract.key.endsWith("|stock"))) harness.state.nowIso = new Date(Date.parse(harness.state.nowIso) + 60_000).toISOString();
      return originalWindow(contracts, options);
    };
    await harness.loop.start();
    expect(harness.calls.discoveries).toEqual(["t1", "t2"]);
    expect(harness.state.rerankStates.get("t2")!.lastLookAt).toEqual(new Date(Date.parse(startIso) + 60_000));
  });
});
