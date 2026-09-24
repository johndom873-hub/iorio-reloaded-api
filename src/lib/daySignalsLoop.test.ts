import type { IBApi } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, sviTotalVariance, type RawSviParameters } from "./impliedVolatilitySurface.js";
import { DaySignalsLoop, daySignalsLoopLineHolder, type DaySignalsLoopDependencies } from "./daySignalsLoop.js";
import type { WindowContract, WindowQuote } from "../ibkr/daySignalsQuoteWindow.js";
import type { SignalGrade, SignalQuote, SignalSurfaceSlice } from "./signalCandidates.js";
import type { TickerSignalsInputs } from "./signalsTypes.js";
import { rollCandidateKey } from "./rollSignalCandidates.js";
import { scoreTicker } from "./signalsLiveScoring.js";

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
  calls: { reserve: number; release: number; windows: WindowContract[][]; writes: number; notified: string[]; emitted: string[]; heartbeats: string[]; grades: SignalGrade[][]; rollGrades: SignalGrade[][]; rollNotified: string[] };
  state: { marketOpen: boolean; pool: boolean; linesOk: boolean; lastGrades: Map<string, SignalGrade | null>; lastRollGrades: Map<string, SignalGrade>; openShortLegs: TickerSignalsInputs["openShortLegs"]; dayQuotes: TickerSignalsInputs["dayQuotes"]; windowResult: { disconnected: boolean } };
}

/** The window fake answers every option with a two-sided quote at `impliedVolatility` and the stock with last = 100, synchronously. */
function createHarness(impliedVolatilityShift = 0): Harness {
  const calls: Harness["calls"] = { reserve: 0, release: 0, windows: [], writes: 0, notified: [], emitted: [], heartbeats: [], grades: [], rollGrades: [], rollNotified: [] };
  const state: Harness["state"] = { marketOpen: true, pool: true, linesOk: true, lastGrades: new Map(), lastRollGrades: new Map(), openShortLegs: [], dayQuotes: [], windowResult: { disconnected: false } };
  let ticks = 0;
  const deps: DaySignalsLoopDependencies = {
    now: () => new Date("2026-09-24T15:00:00Z"),
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
    const withRoll = (): TickerSignalsInputs => ({ ...inputsFor(harness.state.dayQuotes), slices: [slice, slice60], quotes: [...inputsFor([]).quotes, ...quotes60], openShortLegs: [heldLeg] });
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
    // First cycle notifies exactly the rolls above Avoid; the second cycle sees the recorded grade and stays quiet.
    expect(harness.calls.rollNotified.sort()).toEqual(upgraded.map((roll) => `leg-1:${roll.replacement.strike}:avoid->${roll.grade}`).sort());
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

  it("uses the agreed holder name for its reservation", () => {
    expect(daySignalsLoopLineHolder).toBe("daySignalsLoop");
  });
});
