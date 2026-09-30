import type { IBApi } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { DaySignalsLoop, daySignalsLoopLineHolder, type DaySignalsLoopDependencies } from "./daySignalsLoop.js";
import type { WindowContract, WindowQuote } from "../ibkr/daySignalsQuoteWindow.js";
import type { SignalGrade, SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";
import { rollCandidateKey } from "./rollSignalCandidates.js";
import { scoreTicker } from "./signalsLiveScoring.js";
import { assignmentRiskAlertAbsoluteDelta, assignmentRiskRearmAbsoluteDelta, clearsNotificationHysteresis } from "./daySignalsNotifications.js";
import type { AssignmentRiskAlertState, DayRerankState } from "./daySignalsStore.js";
import type { DayContractRef } from "./daySignalsContractSet.js";
import type { DayTickerContractContext, DayTrackedTicker } from "./daySignalsContractContextStore.js";

const forward = 100;
const rate = 0.04;
const params: RawSviParameters = { a: 0.004, b: 0.06, rho: -0.35, m: 0.01, sigma: 0.12 };
const years30 = 30 / 365;
const expiry = "2026-10-21";
const tradingDateIso = "2026-09-24";
const slice: SignalSurfaceSlice = { expiry, status: "ok", parameters: params, kMin: -0.4, kMax: 0.4, yearsToExpiry: years30, forwardPrice: forward, pointCount: 20, rmseVolatility: 0.01, minButterflyDensity: 0.8, droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 }, calendarChecks: 0, calendarViolations: 0 };
const surfaceIvAt = (strike: number) => Math.sqrt(sviTotalVariance(params, Math.log(strike / forward)) / years30);
function quoteAt(strike: number, right: "C" | "P", volatility = surfaceIvAt(strike)): SignalQuote {
  const mid = blackScholesPriceOnForward(forward, strike, years30, rate, volatility, right === "C");
  return { expiry, strike, right, bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
}
const strikes: [number, "C" | "P"][] = [[80, "P"], [85, "P"], [90, "P"], [95, "P"], [105, "C"], [110, "C"]];
const settings = { maxDeltaDriftPct: 100, minAnnualizedYieldPct: 0, maxNetDelta: 1, maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 };

function inputsFor(dayQuotes: TickerSignalsInputs["dayQuotes"]): TickerSignalsInputs {
  return {
    tickerId: "t1",
    symbol: "AAA",
    companyName: null,
    sector: null,
    header: { snapshotId: "s1", tradingDateIso, capturedAt: `${tradingDateIso}T14:00:00Z`, underlyingPrice: forward, riskFreeRatePercent: rate * 100 },
    slices: [slice],
    quotes: strikes.map(([strike, right]) => quoteAt(strike, right)),
    dayQuotes,
    // Forecast just under the surface: every candidate starts Weak at snapshot quotes.
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

interface Harness {
  deps: DaySignalsLoopDependencies;
  loop: DaySignalsLoop;
  calls: { reserve: number; release: number; windows: WindowContract[][]; writes: number; notified: string[]; emitted: string[]; heartbeats: string[]; grades: SignalGrade[][]; rollGrades: SignalGrade[][]; rollNotified: string[]; assignmentAlerts: string[]; assignmentRearms: string[]; spotPasses: string[][]; prunes: { tickerId: string; keep: DayContractRef[] }[]; poolReplacements: { tickerId: string; snapshotId: string; expiries: string[] }[] };
  state: { marketOpen: boolean; pool: boolean; linesOk: boolean; lastGrades: Map<string, SignalGrade | null>; lastRollGrades: Map<string, SignalGrade>; openShortLegs: TickerSignalsInputs["openShortLegs"]; dayQuotes: TickerSignalsInputs["dayQuotes"]; windowResult: { disconnected: boolean }; nowIso: string; assignmentRiskStates: Map<string, AssignmentRiskAlertState>; spot: number; contexts: Map<string, DayTickerContractContext>; rerankStates: Map<string, DayRerankState>; unpooledTickers: DayTrackedTicker[] };
}

/** The window fake answers every option with a two-sided quote at `impliedVolatility` and the stock with last = 100, synchronously. */
function createHarness(impliedVolatilityShift = 0): Harness {
  const calls: Harness["calls"] = { reserve: 0, release: 0, windows: [], writes: 0, notified: [], emitted: [], heartbeats: [], grades: [], rollGrades: [], rollNotified: [], assignmentAlerts: [], assignmentRearms: [], spotPasses: [], prunes: [], poolReplacements: [] };
  const state: Harness["state"] = { marketOpen: true, pool: true, linesOk: true, lastGrades: new Map(), lastRollGrades: new Map(), openShortLegs: [], dayQuotes: [], windowResult: { disconnected: false }, nowIso: "2026-09-24T15:00:00Z", assignmentRiskStates: new Map(), spot: 100, contexts: new Map(), rerankStates: new Map(), unpooledTickers: [] };
  let ticks = 0;
  const deps: DaySignalsLoopDependencies = {
    now: () => new Date(state.nowIso),
    isMarketOpen: async () => state.marketOpen,
    loadPool: async () => (state.pool ? [{ tickerId: "t1", symbol: "AAA", expiry, tradingDateIso, snapshotId: "s1", rank: 1 }] : []),
    loadUniverse: async () => strikes.map(([strike, right]) => ({ tickerId: "t1", symbol: "AAA", expiry, strike, right })),
    reserveLines: async () => {
      calls.reserve += 1;
      return state.linesOk ? { ok: true, availableLines: 80, priorityLinesHeld: 0 } : { ok: false, availableLines: 3, priorityLinesHeld: 50 };
    },
    releaseLines: async () => {
      calls.release += 1;
    },
    borrowLiveConnection: async () => ({ ib: {} as IBApi }),
    allocateReqId: () => 1,
    runQuoteWindow: async (contracts, options) => {
      calls.windows.push(contracts);
      const quotedAt = new Date("2026-09-24T15:01:00Z");
      for (const contract of contracts) {
        const quote: WindowQuote =
          contract.legType === "stock"
            ? { bid: null, ask: null, last: 100, errorCode: null, timedOut: false, settledAt: quotedAt }
            : (() => {
                const mid = blackScholesPriceOnForward(forward, contract.strike!, years30, rate, surfaceIvAt(contract.strike!) + impliedVolatilityShift, contract.right === "C");
                return { bid: mid * 0.98, ask: mid * 1.02, last: null, errorCode: null, timedOut: false, settledAt: quotedAt };
              })();
        options.onSettled(contract, quote);
      }
      return { settled: contracts.length, ...state.windowResult, aborted: false };
    },
    runSpotPass: async (contracts, options) => {
      calls.spotPasses.push(contracts.map((contract) => contract.key));
      for (const contract of contracts) options.onSettled(contract, { bid: null, ask: null, last: state.spot, errorCode: null, timedOut: false, settledAt: new Date("2026-09-24T15:00:30Z") });
      return { settled: contracts.length, disconnected: false, aborted: false };
    },
    loadContractContexts: async () => state.contexts,
    loadRerankStates: async () => new Map(state.rerankStates),
    saveRerankState: async (tickerId, _tradingDateIso, saved) => {
      state.rerankStates.set(tickerId, saved);
    },
    pruneDayQuotes: async (tickerId, keep) => {
      calls.prunes.push({ tickerId, keep });
    },
    loadUnpooledTickers: async () => state.unpooledTickers,
    replaceTickerPool: async (tickerId, _tradingDateIso, snapshotId, expiries) => {
      calls.poolReplacements.push({ tickerId, snapshotId, expiries: expiries.map((entry) => entry.expiry) });
      return true;
    },
    upsertDayQuotes: async (writes) => {
      calls.writes += writes.length;
      // The loop re-reads the ticker's day quotes after a flush; mirror the writes into what it will read
      // (a freshly written row has no grade yet, exactly like day_signal_quotes.last_grade).
      state.dayQuotes = writes.map((write) => ({ expiry: write.expiry, strike: write.strike, right: write.right, bid: write.bid, ask: write.ask, quotedAt: write.quotedAt.toISOString() }));
      for (const write of writes) {
        const key = `${write.expiry}|${write.strike}|${write.right}`;
        if (!state.lastGrades.has(key)) state.lastGrades.set(key, null);
      }
    },
    loadTickerSignalsInputs: async () => ({ ...inputsFor(state.dayQuotes), openShortLegs: state.openShortLegs }),
    loadAccountContext: async () => ({ freeCash: 1_000_000 }),
    loadSignalSettings: async () => settings,
    loadLastRollGrades: async () => state.lastRollGrades,
    upsertRollGrades: async (_tickerId, _tradingDateIso, grades) => {
      calls.rollGrades.push(grades.map((entry) => entry.grade));
      for (const entry of grades) state.lastRollGrades.set(`${entry.legId}|${entry.expiry}|${entry.strike}|${entry.right}`, entry.grade);
    },
    notifyRollUpgrade: async (upgrade) => {
      calls.rollNotified.push(`${upgrade.roll.legId}:${upgrade.roll.replacement.strike}:${upgrade.previousGrade}->${upgrade.roll.grade}`);
    },
    loadLastGrades: async () => new Map(state.lastGrades),
    updateDayQuoteGrades: async (_tickerId, grades) => {
      calls.grades.push(grades.map((grade) => grade.grade));
      for (const grade of grades) state.lastGrades.set(`${grade.expiry}|${grade.strike}|${grade.right}`, grade.grade);
    },
    notifyUpgrade: async (upgrade) => {
      calls.notified.push(`${upgrade.candidate.strike}${upgrade.candidate.strategyKey === "covered_call" ? "C" : "P"}:${upgrade.previousGrade}->${upgrade.candidate.grade}`);
    },
    loadAssignmentRiskAlertStates: async (legIds) => new Map(legIds.flatMap((legId) => (state.assignmentRiskStates.has(legId) ? [[legId, { ...state.assignmentRiskStates.get(legId)! }] as const] : []))),
    recordAssignmentRiskAlert: async (legId, alertTradingDateIso) => {
      state.assignmentRiskStates.set(legId, { notifiedAt: state.nowIso, lastAlertTradingDateIso: alertTradingDateIso });
    },
    rearmAssignmentRiskAlert: async (legId) => {
      calls.assignmentRearms.push(legId);
      state.assignmentRiskStates.set(legId, { ...state.assignmentRiskStates.get(legId)!, notifiedAt: null });
    },
    notifyAssignmentRisk: async (alert) => {
      calls.assignmentAlerts.push(`${alert.leg.legId}:${alert.leg.strike}${alert.leg.right}`);
    },
    emitUpdated: (tickerId) => {
      calls.emitted.push(tickerId);
    },
    writeHeartbeat: async (status) => {
      calls.heartbeats.push(status.state);
    },
    sleep: async () => {
      // Each idle tick sleeps; stop after the second evaluation so a test sees one full state decision.
      ticks += 1;
      if (ticks >= 2) loop.stop();
    },
  };
  const loop = new DaySignalsLoop(deps);
  return { deps, loop, calls, state };
}

describe("DaySignalsLoop", () => {
  it("stays idle while the market is closed and releases nothing it never reserved", async () => {
    const harness = createHarness();
    harness.state.marketOpen = false;
    await harness.loop.start();
    expect(harness.calls.reserve).toBe(0);
    expect(harness.calls.windows).toHaveLength(0);
    expect(harness.calls.heartbeats).toContain("idle");
    expect(harness.loop.getStatus()).toMatchObject({ state: "disabled", reason: "stopped" });
  });

  describe("reports failures that were only logged before", () => {
    const stopAfterFirstWindow = (harness: Harness) => {
      const originalWindow = harness.deps.runQuoteWindow;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        const result = await originalWindow(contracts, options);
        harness.loop.stop();
        return result;
      };
    };

    it("alerts when a quote write fails, with the source and the error text", async () => {
      const harness = createHarness();
      const reports: { source: string; message: string }[] = [];
      harness.deps.reportFailure = (source, message) => reports.push({ source, message });
      harness.deps.upsertDayQuotes = async () => {
        throw new Error("connection terminated");
      };
      stopAfterFirstWindow(harness);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await harness.loop.start();
      expect(reports.find((report) => report.source === "day-signals:quote-write")?.message).toContain("connection terminated");
    });

    it("alerts when a cycle throws, and announces recovery once a later cycle completes", async () => {
      const harness = createHarness();
      const reports: string[] = [];
      const recoveries: string[] = [];
      harness.deps.reportFailure = (source) => reports.push(source);
      harness.deps.reportRecovery = (source) => {
        recoveries.push(source);
        harness.loop.stop();
      };
      let attempts = 0;
      const originalLoadUniverse = harness.deps.loadUniverse;
      harness.deps.loadUniverse = async (tradingDateIso) => {
        if (++attempts === 1) throw new Error("database is down");
        return originalLoadUniverse(tradingDateIso);
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      await harness.loop.start();
      expect(reports).toContain("day-signals:cycle");
      expect(recoveries).toContain("day-signals:cycle");
    });

    it("alerts when a re-score fails", async () => {
      const harness = createHarness();
      const reports: { source: string; message: string }[] = [];
      harness.deps.reportFailure = (source, message) => reports.push({ source, message });
      harness.deps.loadTickerSignalsInputs = async () => {
        throw new Error("no snapshot");
      };
      stopAfterFirstWindow(harness);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await harness.loop.start();
      expect(reports.find((report) => report.source === "day-signals:rescore")?.message).toContain("AAA");
    });
  });

  it("stays idle until today's pool exists, and when the lines cannot be reserved", async () => {
    const noPool = createHarness();
    noPool.state.pool = false;
    await noPool.loop.start();
    expect(noPool.calls.windows).toHaveLength(0);

    const noLines = createHarness();
    noLines.state.linesOk = false;
    await noLines.loop.start();
    expect(noLines.calls.reserve).toBeGreaterThan(0);
    expect(noLines.calls.windows).toHaveLength(0);
  });

  it("runs a cycle: reserves 10 lines, walks every pooled contract then the ticker's stock slot, writes quotes, records grades as a baseline and emits", async () => {
    const harness = createHarness();
    // Stop after the first cycle: the loop calls sleep only when a tick did not run a cycle, so stop from the window instead.
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      const result = await originalWindow(contracts, options);
      harness.loop.stop();
      return result;
    };
    await harness.loop.start();
    expect(harness.calls.reserve).toBe(1);
    expect(harness.calls.windows).toHaveLength(1);
    const keys = harness.calls.windows[0]!.map((contract) => contract.key);
    expect(keys).toEqual([...strikes.map(([strike, right]) => `t1|${expiry}|${strike}|${right}`), "t1|stock"]);
    expect(harness.calls.windows[0]![0]).toMatchObject({ legType: "option", expiry: "20261021" });
    expect(harness.calls.writes).toBe(6);
    expect(harness.calls.grades).toHaveLength(1);
    expect(harness.calls.grades[0]).toHaveLength(6);
    expect(harness.calls.notified).toEqual([]); // first score = baseline, no previous grade
    expect(harness.calls.emitted).toEqual(["t1"]);
    expect(harness.calls.release).toBe(1);
    expect(harness.loop.getStatus()).toMatchObject({ cycleNumber: 1, contractsInPool: 6, tradingDateIso });
  });

  describe("tracking the live spot", () => {
    const listedStrikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
    function contextAt(overrides: Partial<DayTickerContractContext> = {}): DayTickerContractContext {
      return {
        tickerId: "t1",
        symbol: "AAA",
        snapshotId: "s1",
        snapshotSpotPrice: 100,
        atmImpliedVolatility: 0.3,
        strikesByExpiry: new Map([[expiry, listedStrikes]]),
        heldContracts: [],
        previousContracts: strikes.map(([strike, right]) => ({ expiry, strike, right })),
        ...overrides,
      };
    }
    /** Runs exactly `cycleCount` full cycles (each ends in its main quote window). */
    async function runCycles(harness: Harness, cycleCount: number): Promise<void> {
      let mainWindows = 0;
      const originalWindow = harness.deps.runQuoteWindow;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        const result = await originalWindow(contracts, options);
        if (contracts.some((contract) => contract.key.endsWith("|stock"))) {
          mainWindows += 1;
          if (mainWindows === cycleCount) harness.loop.stop();
        }
        return result;
      };
      await harness.loop.start();
    }

    it("quotes the capture's rule at the live spot: follows a rally, drops far ITM contracts, keeps one strike step of buffer, and prunes what it dropped", async () => {
      const harness = createHarness();
      harness.state.spot = 112;
      // snapshotSpotPrice equal to the spot keeps the re-rank out of this test.
      harness.state.contexts = new Map([["t1", contextAt({ snapshotSpotPrice: 112 })]]);
      await runCycles(harness, 1);
      // Window at 112 with 27 DTE and 30% IV is 95.1..132. Puts below spot inside it, both rights at 110 (nearest strike), calls above spot.
      // 95P was captured and sits under the lower bound by less than one strike step (kept); 80P/85P/90P and the ITM 105C are gone.
      const expected = ["95P", "100P", "105P", "110C", "110P", "115C", "120C"];
      expect(harness.calls.windows.at(-1)!.map((contract) => contract.key)).toEqual([...expected.map((label) => `t1|${expiry}|${label.slice(0, -1)}|${label.slice(-1)}`), "t1|stock"]);
      expect(harness.calls.prunes).toHaveLength(1);
      expect(harness.calls.prunes[0]!.keep.map((contract) => `${contract.strike}${contract.right}`)).toEqual(expected);
      expect(harness.calls.poolReplacements).toEqual([]);
      expect(harness.loop.getStatus().contractsInPool).toBe(7);
    });

    it("always quotes an open leg's contract, even far in the money", async () => {
      const harness = createHarness();
      harness.state.spot = 112;
      harness.state.contexts = new Map([["t1", contextAt({ snapshotSpotPrice: 112, heldContracts: [{ expiry, strike: 85, right: "P" }] })]]);
      await runCycles(harness, 1);
      expect(harness.calls.windows.at(-1)!.map((contract) => contract.key)).toContain(`t1|${expiry}|85|P`);
    });

    it("stays on the snapshot's contracts for a ticker with no context or no usable spot, and never prunes it", async () => {
      const noContext = createHarness();
      await runCycles(noContext, 1);
      expect(noContext.calls.windows.at(-1)!.map((contract) => contract.key)).toEqual([...strikes.map(([strike, right]) => `t1|${expiry}|${strike}|${right}`), "t1|stock"]);
      expect(noContext.calls.prunes).toEqual([]);

      const noIv = createHarness();
      noIv.state.contexts = new Map([["t1", contextAt({ atmImpliedVolatility: null })]]);
      noIv.state.spot = 112;
      await runCycles(noIv, 1);
      expect(noIv.calls.windows.at(-1)!.map((contract) => contract.key)).toHaveLength(7);
      expect(noIv.calls.prunes).toEqual([]);
    });

    it("runs the spot pass before the contract window each cycle, one stock per pooled ticker", async () => {
      const harness = createHarness();
      await runCycles(harness, 2);
      expect(harness.calls.spotPasses).toEqual([["t1|stock"], ["t1|stock"]]);
    });

    it("re-ranks a ticker once when its spot moves past the trigger (2.5% at 80% IV), quoting all its fitted expiries at the new spot, and not again until it moves that far again", async () => {
      const harness = createHarness(0.05);
      harness.state.spot = 110; // +10% vs the 100 snapshot spot
      harness.state.contexts = new Map([["t1", contextAt({ atmImpliedVolatility: 0.8 })]]);
      await runCycles(harness, 3);
      const discoveryWindows = harness.calls.windows.filter((window) => !window.some((contract) => contract.key.endsWith("|stock")));
      expect(discoveryWindows).toHaveLength(1);
      expect(discoveryWindows[0]!.every((contract) => contract.legType === "option")).toBe(true);
      expect(harness.calls.poolReplacements).toEqual([{ tickerId: "t1", snapshotId: "s1", expiries: [expiry] }]);
    });

    it("persists the re-rank state: a restarted loop neither repeats a re-rank nor resets the daily cap", async () => {
      const harness = createHarness(0.05);
      harness.state.spot = 110;
      harness.state.contexts = new Map([["t1", contextAt({ atmImpliedVolatility: 0.8 })]]);
      await runCycles(harness, 1);
      expect(harness.state.rerankStates.get("t1")).toEqual({ referenceSpotPrice: 110, reranks: 1 });
      const discoveryCount = () => harness.calls.windows.filter((window) => !window.some((contract) => contract.key.endsWith("|stock"))).length;
      expect(discoveryCount()).toBe(1);

      // A fresh loop instance on the same stored state: the 9:30 spot (100) is no longer the reference, so 110 is not a new move.
      const restarted = new DaySignalsLoop(harness.deps);
      let cycles = 0;
      const originalWindow = harness.deps.runQuoteWindow;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        const result = await originalWindow(contracts, options);
        if (contracts.some((contract) => contract.key.endsWith("|stock")) && (cycles += 1) === 1) restarted.stop();
        return result;
      };
      await restarted.start();
      expect(discoveryCount()).toBe(1);

      // A stored count at the cap blocks any further re-rank however far the price has moved since.
      harness.state.rerankStates.set("t1", { referenceSpotPrice: 100, reranks: 3 });
      const capped = new DaySignalsLoop(harness.deps);
      cycles = 0;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        const result = await originalWindow(contracts, options);
        if (contracts.some((contract) => contract.key.endsWith("|stock")) && (cycles += 1) === 1) capped.stop();
        return result;
      };
      await capped.start();
      expect(discoveryCount()).toBe(1);
    });

    it("re-ranks a ticker the 9:30 seed left without a pool when it jumps, creating its pool on the snapshot it was scored from", async () => {
      const harness = createHarness(0.05);
      harness.state.spot = 110;
      harness.state.unpooledTickers = [{ tickerId: "t2", symbol: "BBB", snapshotId: "s2" }];
      harness.state.contexts = new Map([["t2", contextAt({ tickerId: "t2", symbol: "BBB", snapshotId: "s2", atmImpliedVolatility: 0.8, previousContracts: [] })]]);
      await runCycles(harness, 1);
      expect(harness.calls.spotPasses[0]).toEqual(["t1|stock", "t2|stock"]);
      const discovery = harness.calls.windows.find((window) => !window.some((contract) => contract.key.endsWith("|stock")))!;
      expect(discovery.every((contract) => contract.key.startsWith("t2|"))).toBe(true);
      expect(harness.calls.poolReplacements).toEqual([{ tickerId: "t2", snapshotId: "s2", expiries: [expiry] }]);
      expect(harness.state.rerankStates.get("t2")).toEqual({ referenceSpotPrice: 110, reranks: 1 });
    });

    it("leaves an unpooled ticker alone while it stays under the trigger", async () => {
      const harness = createHarness(0.05);
      harness.state.spot = 101;
      harness.state.unpooledTickers = [{ tickerId: "t2", symbol: "BBB", snapshotId: "s2" }];
      harness.state.contexts = new Map([["t2", contextAt({ tickerId: "t2", symbol: "BBB", snapshotId: "s2", atmImpliedVolatility: 0.8, previousContracts: [] })]]);
      await runCycles(harness, 1);
      expect(harness.calls.poolReplacements).toEqual([]);
      expect(harness.calls.windows.filter((window) => !window.some((contract) => contract.key.endsWith("|stock")))).toHaveLength(0);
    });

    it("does not re-rank a move under the trigger, nor after the daily cap", async () => {
      const small = createHarness(0.05);
      small.state.spot = 102; // +2% < 2.52%
      small.state.contexts = new Map([["t1", contextAt({ atmImpliedVolatility: 0.8 })]]);
      await runCycles(small, 1);
      expect(small.calls.windows.filter((window) => !window.some((contract) => contract.key.endsWith("|stock")))).toHaveLength(0);

      const capped = createHarness(0.05);
      capped.state.contexts = new Map([["t1", contextAt({ atmImpliedVolatility: 0.8 })]]);
      let cycle = 0;
      const originalSpotPass = capped.deps.runSpotPass;
      capped.deps.runSpotPass = async (contracts, options) => {
        cycle += 1;
        capped.state.spot = 100 * 1.1 ** cycle; // +10% every cycle: always past the trigger
        return originalSpotPass(contracts, options);
      };
      await runCycles(capped, 6);
      expect(capped.calls.poolReplacements).toHaveLength(3);
    });
  });

  it("notifies upward transitions only, against the last recorded grade", async () => {
    // Quotes come back 8 vol points richer than the surface: shift +8vp lifts every candidate from Weak to Good/Strong.
    const harness = createHarness(0.08);
    for (const [strike, right] of strikes) harness.state.lastGrades.set(`${expiry}|${strike}|${right}`, "weak");
    harness.state.lastGrades.set(`${expiry}|80|P`, "strong"); // already above: must not notify
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      const result = await originalWindow(contracts, options);
      harness.loop.stop();
      return result;
    };
    await harness.loop.start();
    expect(harness.calls.notified.length).toBeGreaterThan(0);
    expect(harness.calls.notified.every((entry) => entry.includes("weak->"))).toBe(true);
    expect(harness.calls.notified.some((entry) => entry.startsWith("80P:"))).toBe(false);
  });

  it("notifies a contract the loop only just started quoting (price moved) from Avoid, while the first cycle after the seed stays a baseline", async () => {
    const stopAfterMainWindow = (harness: Harness) => {
      const originalWindow = harness.deps.runQuoteWindow;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        const result = await originalWindow(contracts, options);
        harness.loop.stop();
        return result;
      };
    };
    const contextWithPrevious = (previous: [number, "C" | "P"][]): DayTickerContractContext => ({
      tickerId: "t1",
      symbol: "AAA",
      snapshotId: "s1",
      snapshotSpotPrice: 100,
      atmImpliedVolatility: 0.3,
      strikesByExpiry: new Map([[expiry, [80, 85, 90, 95, 100, 105, 110]]]),
      heldContracts: [],
      previousContracts: previous.map(([strike, right]) => ({ expiry, strike, right })),
    });

    // Quotes 8 vol points rich. Only 90P/95P were quoted last cycle; every other contract of today's set is new to the loop.
    const midDay = createHarness(0.08);
    midDay.state.contexts = new Map([["t1", contextWithPrevious([[90, "P"], [95, "P"]])]]);
    stopAfterMainWindow(midDay);
    await midDay.loop.start();
    expect(midDay.calls.notified.length).toBeGreaterThan(0);
    expect(midDay.calls.notified.every((entry) => entry.includes("avoid->"))).toBe(true);
    expect(midDay.calls.notified.some((entry) => entry.startsWith("90P:") || entry.startsWith("95P:"))).toBe(false); // known contracts: no recorded grade is still a baseline

    // Nothing stored yet (the first cycle after the seed): everything is a baseline, nothing notifies.
    const firstCycle = createHarness(0.08);
    firstCycle.state.contexts = new Map([["t1", contextWithPrevious([])]]);
    stopAfterMainWindow(firstCycle);
    await firstCycle.loop.start();
    expect(firstCycle.calls.notified).toEqual([]);
  });

  it("withholds a notification that reaches Weak without clearing the hysteresis margin, while still recording the grade", async () => {
    // At shift 0 every candidate scores Weak (per inputsFor's comment); pick a real one whose net Edge
    // doesn't clear Weak's notification margin (2vp) and give it an Avoid baseline, so isGradeUpgrade
    // alone would fire but the margin should withhold it -- this reproduces the HOOD $116 put boundary
    // flap from staging (2026-09-24): a contract barely crossing a grade line should not notify on the
    // crossing alone.
    const harness = createHarness(0);
    // Freeze the ticker's inputs (empty day quotes) so the pre-loop check below matches exactly what
    // the loop's own re-score sees on cycle 1 -- the default harness wiring merges the cycle's just-settled
    // day quotes into loadTickerSignalsInputs, which shifts net Edge by a fraction of a vp and would make
    // a margin-sensitive assertion like this one nondeterministic.
    harness.deps.loadTickerSignalsInputs = async () => inputsFor([]);
    const expected = scoreTicker(inputsFor([]), { freeCash: 1_000_000 }, settings, { spotPrice: 100, priceSource: "live" });
    const weakBelowMargin = expected.candidates.find((candidate) => candidate.grade === "weak" && !clearsNotificationHysteresis("weak", candidate.netEdge));
    expect(weakBelowMargin).toBeDefined();
    const key = `${weakBelowMargin!.expiry}|${weakBelowMargin!.strike}|${weakBelowMargin!.strategyKey === "covered_call" ? "C" : "P"}`;
    for (const [strike, right] of strikes) harness.state.lastGrades.set(`${expiry}|${strike}|${right}`, "weak");
    harness.state.lastGrades.set(key, "avoid");
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      const result = await originalWindow(contracts, options);
      harness.loop.stop();
      return result;
    };
    await harness.loop.start();
    // The grade itself is still recorded as Weak for the next cycle's comparison; only the notification is withheld.
    expect(harness.state.lastGrades.get(key)).toBe("weak");
    expect(harness.calls.notified.some((entry) => entry.startsWith(`${weakBelowMargin!.strike}${weakBelowMargin!.strategyKey === "covered_call" ? "C" : "P"}:`))).toBe(false);
  });

  it("suppresses a repeat notification for the same contract inside the cooldown window, then allows it once the cooldown has elapsed", async () => {
    // Same setup as "notifies upward transitions only": +8vp lifts every candidate from Weak comfortably past the hysteresis margin.
    const harness = createHarness(0.08);
    for (const [strike, right] of strikes) harness.state.lastGrades.set(`${expiry}|${strike}|${right}`, "weak");
    let cycles = 0;
    // notifiedCountBeforeCycle[i] = calls.notified.length as of just before cycle i+2 starts, i.e. the
    // fully-settled total after cycle i+1 (each cycle's own rescore/notify has completed by the time the
    // loop's *next* runQuoteWindow call happens, since runCycle fully awaits it before the tick returns).
    const notifiedCountBeforeCycle: number[] = [];
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      cycles += 1;
      notifiedCountBeforeCycle.push(harness.calls.notified.length);
      // Force a fresh "weak" baseline before every cycle from the second on (as if quote noise dropped
      // grades back down between cycles without a notify-worthy downgrade being recorded), so only the
      // cooldown -- not isGradeUpgrade -- can explain a suppressed repeat notification.
      if (cycles >= 2) for (const [strike, right] of strikes) harness.state.lastGrades.set(`${expiry}|${strike}|${right}`, "weak");
      if (cycles === 2) harness.state.nowIso = "2026-09-24T15:05:00Z"; // 5 minutes after cycle 1: still inside the 10-minute cooldown
      if (cycles === 3) harness.state.nowIso = "2026-09-24T15:11:00Z"; // 11 minutes after cycle 1: cooldown has elapsed
      const result = await originalWindow(contracts, options);
      if (cycles === 3) harness.loop.stop();
      return result;
    };
    await harness.loop.start();
    expect(cycles).toBe(3);
    const [countBeforeCycle1, countBeforeCycle2, countBeforeCycle3] = notifiedCountBeforeCycle;
    expect(countBeforeCycle1).toBe(0);
    expect(countBeforeCycle2).toBeGreaterThan(0); // cycle 1 notified
    expect(countBeforeCycle3).toBe(countBeforeCycle2); // cycle 2 (5 min later) was suppressed by the cooldown
    expect(harness.calls.notified.length).toBeGreaterThan(countBeforeCycle3!); // cycle 3 (11 min later) notified again
  });

  it("notifies roll upgrades per (held leg, replacement) against the recorded roll grade, and records the grades (Roll Signals)", async () => {
    const harness = createHarness();
    // A 60-day slice with the same IV at every log-moneyness (total variance doubled) so a 30-day held 95 put
    // has credit, lower-delta replacements out in time; the same-expiry puts are debits or riskier.
    const expiry60 = "2026-11-20";
    const slice60: SignalSurfaceSlice = { ...slice, expiry: expiry60, yearsToExpiry: 60 / 365, parameters: { ...params, a: params.a * 2, b: params.b * 2 } };
    const quotes60: SignalQuote[] = [80, 85, 90, 95].map((strike) => {
      const mid = blackScholesPriceOnForward(forward, strike, 60 / 365, rate, surfaceIvAt(strike), false);
      return { expiry: expiry60, strike, right: "P", bid: mid * 0.98, ask: mid * 1.02, source: "snapshot" };
    });
    const heldLeg = { legId: "leg-1", positionId: "pos-1", strategyKey: "cash_secured_put" as const, expiry, strike: 95, right: "P" as const, quantity: 1, entryPrice: 2, entryAtIso: "2026-09-10T14:00:00Z" };
    // Empty day quotes (not harness.state.dayQuotes): keeps this test's pre-loop `expected` computation
    // identical to what the loop's own cycle-1 re-score sees, so the hysteresis-margin check below isn't
    // thrown off by the day-quote merge shifting net roll Edge by a fraction of a vp between the two.
    const withRoll = (): TickerSignalsInputs => ({ ...inputsFor([]), slices: [slice, slice60], quotes: [...inputsFor([]).quotes, ...quotes60], openShortLegs: [heldLeg] });
    harness.deps.loadTickerSignalsInputs = async () => withRoll();
    const expected = scoreTicker(withRoll(), { freeCash: 1_000_000 }, settings, { spotPrice: 100, priceSource: "live" });
    expect(expected.rolls.length).toBeGreaterThan(0);
    expect(expected.rolls.every((roll) => roll.replacement.expiry === expiry60)).toBe(true);
    // Baseline: every roll recorded as Avoid, so each roll graded above Avoid is one upgrade.
    for (const roll of expected.rolls) harness.state.lastRollGrades.set(rollCandidateKey(roll), "avoid");
    let cycles = 0;
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      cycles += 1;
      if (cycles === 2) harness.loop.stop();
      return originalWindow(contracts, options);
    };
    await harness.loop.start();
    const upgraded = expected.rolls.filter((roll) => roll.grade !== "avoid");
    expect(upgraded.length).toBeGreaterThan(0);
    // First cycle notifies the rolls above Avoid that also clear the notification hysteresis margin
    // (a roll graded just barely above Avoid does not); the second cycle sees the recorded grade and stays quiet.
    const notifiable = upgraded.filter((roll) => clearsNotificationHysteresis(roll.grade, roll.netRollEdge));
    expect(notifiable.length).toBeGreaterThan(0);
    expect(harness.calls.rollNotified.sort()).toEqual(notifiable.map((roll) => `leg-1:${roll.replacement.strike}:avoid->${roll.grade}`).sort());
    expect(harness.calls.rollGrades).toHaveLength(2);
    expect(harness.calls.rollGrades[0]).toEqual(expected.rolls.map((roll) => roll.grade));
    expect(harness.state.lastRollGrades.get(rollCandidateKey(upgraded[0]!))).toBe(upgraded[0]!.grade);
  });

  it("backs off and keeps going after the connection drops mid-cycle", async () => {
    const harness = createHarness();
    harness.state.windowResult = { disconnected: true };
    let cycles = 0;
    const originalWindow = harness.deps.runQuoteWindow;
    harness.deps.runQuoteWindow = async (contracts, options) => {
      cycles += 1;
      if (cycles === 2) harness.loop.stop();
      return originalWindow(contracts, options);
    };
    const sleeps: number[] = [];
    harness.deps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    await harness.loop.start();
    expect(cycles).toBe(2);
    expect(sleeps).toContain(5_000);
    expect(harness.loop.getStatus().lastError).toBe("IBKR live connection dropped mid-cycle");
  });

  describe("assignment-risk alerts", () => {
    // One held short put (leg-1) whose strike is swapped per cycle to move its surface delta: the 105 put is in
    // the money (|delta| >= 0.50), the 100 put sits between the re-arm and alert thresholds, the 90 put is well below.
    const heldPut = (strike: number) => ({ legId: "leg-1", positionId: "pos-1", strategyKey: "cash_secured_put" as const, expiry, strike, right: "P" as const, quantity: 1, entryPrice: 2, entryAtIso: "2026-09-10T14:00:00Z" });
    function inputsWithHeldPut(strike: number, dayIso: string): TickerSignalsInputs {
      const base = inputsFor([]);
      return { ...base, header: { ...base.header!, tradingDateIso: dayIso }, todayEasternIso: dayIso, quotes: [...base.quotes.filter((quote) => !(quote.strike === strike && quote.right === "P")), quoteAt(strike, "P")], openShortLegs: [heldPut(strike)] };
    }
    const heldDelta = (strike: number) => scoreTicker(inputsWithHeldPut(strike, tradingDateIso), { freeCash: 1_000_000 }, settings, { spotPrice: 100, priceSource: "live" }).heldLegs[0]!.delta!;

    /** Runs one loop cycle per step; returns the assignment alerts sent in each cycle. */
    async function runSteps(harness: Harness, steps: { strike: number; nowIso: string }[]): Promise<string[][]> {
      const alertsPerCycle: string[][] = [];
      let cycles = 0;
      let currentStep = steps[0]!;
      harness.state.nowIso = currentStep.nowIso;
      harness.deps.loadTickerSignalsInputs = async () => inputsWithHeldPut(currentStep.strike, currentStep.nowIso.slice(0, 10));
      const originalWindow = harness.deps.runQuoteWindow;
      harness.deps.runQuoteWindow = async (contracts, options) => {
        if (cycles > 0) alertsPerCycle.push(harness.calls.assignmentAlerts.splice(0));
        currentStep = steps[cycles]!;
        cycles += 1;
        const result = await originalWindow(contracts, options);
        if (cycles === steps.length) harness.loop.stop();
        else harness.state.nowIso = steps[cycles]!.nowIso; // the next tick reads its trading date before its window runs
        return result;
      };
      await harness.loop.start();
      alertsPerCycle.push(harness.calls.assignmentAlerts.splice(0));
      return alertsPerCycle;
    }

    const day1 = "2026-09-24T15:00:00Z";
    const day1Later = "2026-09-24T16:00:00Z";
    const day2 = "2026-09-25T15:00:00Z";

    it("uses strikes on the intended side of each threshold", () => {
      expect(Math.abs(heldDelta(105))).toBeGreaterThanOrEqual(assignmentRiskAlertAbsoluteDelta);
      expect(Math.abs(heldDelta(100))).toBeGreaterThanOrEqual(assignmentRiskRearmAbsoluteDelta);
      expect(Math.abs(heldDelta(100))).toBeLessThan(assignmentRiskAlertAbsoluteDelta);
      expect(Math.abs(heldDelta(90))).toBeLessThan(assignmentRiskRearmAbsoluteDelta);
    });

    it("alerts once when |delta| crosses 0.50, and not again while it stays at or above 0.45", async () => {
      const harness = createHarness();
      harness.state.assignmentRiskStates.set("leg-1", { notifiedAt: null, lastAlertTradingDateIso: null });
      const alerts = await runSteps(harness, [
        { strike: 100, nowIso: day1 },
        { strike: 105, nowIso: day1 },
        { strike: 105, nowIso: day1 },
        { strike: 100, nowIso: day1 },
        { strike: 105, nowIso: day2 },
      ]);
      expect(alerts).toEqual([[], ["leg-1:105P"], [], [], []]);
      expect(harness.state.assignmentRiskStates.get("leg-1")).toMatchObject({ lastAlertTradingDateIso: "2026-09-24" });
      expect(harness.state.assignmentRiskStates.get("leg-1")!.notifiedAt).not.toBeNull();
      expect(harness.calls.assignmentRearms).toEqual([]);
    });

    it("re-arms once |delta| falls below 0.45, then alerts on the next crossing (on a later trading day)", async () => {
      const harness = createHarness();
      harness.state.assignmentRiskStates.set("leg-1", { notifiedAt: null, lastAlertTradingDateIso: null });
      const alerts = await runSteps(harness, [
        { strike: 105, nowIso: day1 },
        { strike: 90, nowIso: day1Later },
        { strike: 105, nowIso: day2 },
      ]);
      expect(alerts).toEqual([["leg-1:105P"], [], ["leg-1:105P"]]);
      expect(harness.calls.assignmentRearms).toEqual(["leg-1"]);
      expect(harness.state.assignmentRiskStates.get("leg-1")).toMatchObject({ lastAlertTradingDateIso: "2026-09-25" });
    });

    it("sends at most one alert per leg per Eastern trading day, even after re-arming", async () => {
      const harness = createHarness();
      harness.state.assignmentRiskStates.set("leg-1", { notifiedAt: null, lastAlertTradingDateIso: null });
      const alerts = await runSteps(harness, [
        { strike: 105, nowIso: day1 },
        { strike: 90, nowIso: day1 },
        { strike: 105, nowIso: day1Later },
        { strike: 105, nowIso: day2 },
      ]);
      expect(alerts).toEqual([["leg-1:105P"], [], [], ["leg-1:105P"]]);
    });

    it("skips a held leg with no delta (unscored) and one with no position_legs row", async () => {
      const unscored = createHarness();
      unscored.state.assignmentRiskStates.set("leg-1", { notifiedAt: null, lastAlertTradingDateIso: null });
      // No slice for the held leg's expiry: it scores as unscored (delta null).
      const originalInputs = inputsWithHeldPut(105, tradingDateIso);
      unscored.deps.loadTickerSignalsInputs = async () => ({ ...originalInputs, openShortLegs: [{ ...heldPut(105), expiry: "2026-12-18" }] });
      const window = unscored.deps.runQuoteWindow;
      unscored.deps.runQuoteWindow = async (contracts, options) => {
        const result = await window(contracts, options);
        unscored.loop.stop();
        return result;
      };
      await unscored.loop.start();
      expect(unscored.calls.assignmentAlerts).toEqual([]);

      const noRow = createHarness();
      const alerts = await runSteps(noRow, [{ strike: 105, nowIso: day1 }]);
      expect(alerts).toEqual([[]]);
    });
  });

  it("uses the agreed holder name for its reservation", () => {
    expect(daySignalsLoopLineHolder).toBe("daySignalsLoop");
  });
});
