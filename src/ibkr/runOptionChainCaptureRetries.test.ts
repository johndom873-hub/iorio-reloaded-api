import { describe, expect, it, vi } from "vitest";
import { captureAttemptsPerTicker } from "../lib/captureRetryQueue.js";
import { buildCaptureRetryJobOutcome, runCaptureRetryRounds, type CaptureRetryDependencies } from "./runOptionChainCaptureRetries.js";

function retryDependencies(queuesByCall: string[][], overrides: Partial<CaptureRetryDependencies> = {}) {
  const order: string[] = [];
  const release = vi.fn(async () => {
    order.push("release");
  });
  let call = 0;
  const clock = { nowMs: 0 };
  const dependencies: CaptureRetryDependencies = {
    findSymbolsToRetry: vi.fn(async () => queuesByCall[Math.min(call++, queuesByCall.length - 1)]!),
    holdLines: vi.fn(async () => {
      order.push("hold");
      return release;
    }),
    waitForPoolShedding: vi.fn(async () => {
      order.push("wait for pool");
    }),
    recapture: vi.fn(async (symbols: string[], _round: { attempt: number; linesHeldSince: number }) => {
      order.push(`recapture ${symbols.join(",")}`);
      return null;
    }),
    refit: vi.fn(async (_tradingDate: string, symbols: string[]) => {
      order.push(`refit ${symbols.join(",")}`);
    }),
    now: () => clock.nowMs,
    ...overrides,
  };
  return { dependencies, order, release, clock };
}

describe("runCaptureRetryRounds", () => {
  it("does nothing, and never reserves lines, when no ticker needs a retry", async () => {
    const { dependencies } = retryDependencies([[]]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(result).toEqual({ roundSymbols: [], roundErrors: [], stillFailingSymbols: [], roundLineUsage: [], lineHold: null });
    expect(dependencies.holdLines).not.toHaveBeenCalled();
  });

  it("makes 3 attempts in all: the first pass plus two retry rounds, waiting for the pool to shed once, with no pause between rounds", async () => {
    const { dependencies, order } = retryDependencies([["HOOD", "INTC"], ["HOOD", "INTC"], ["HOOD"]]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(captureAttemptsPerTicker).toBe(3);
    expect(order).toEqual(["hold", "wait for pool", "recapture HOOD,INTC", "refit HOOD,INTC", "recapture HOOD,INTC", "refit HOOD,INTC", "release"]);
    expect(result).toMatchObject({ roundSymbols: [["HOOD", "INTC"], ["HOOD", "INTC"]], roundErrors: [], stillFailingSymbols: ["HOOD"], roundLineUsage: [null, null] });
  });

  it("retries only the tickers still failing, and stops as soon as the queue is empty", async () => {
    const { dependencies, order } = retryDependencies([["HOOD", "INTC"], ["HOOD"], []]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(order).toEqual(["hold", "wait for pool", "recapture HOOD,INTC", "refit HOOD,INTC", "recapture HOOD", "refit HOOD", "release"]);
    expect(result.stillFailingSymbols).toEqual([]);

    const recovered = retryDependencies([["HOOD"], []]);
    await runCaptureRetryRounds("2026-10-01", recovered.dependencies);
    expect(recovered.dependencies.recapture).toHaveBeenCalledTimes(1);
  });

  it("holds the lines once across rounds and releases them even if a refit blows up", async () => {
    const { dependencies, release } = retryDependencies([["HOOD"]], {
      refit: vi.fn(async () => {
        throw new Error("database down");
      }),
    });
    await expect(runCaptureRetryRounds("2026-10-01", dependencies)).rejects.toThrow("database down");
    expect(dependencies.holdLines).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("splits the time the lines were held into the pool wait, capturing, refitting and choosing the next queue, and passes each round its attempt and hold start", async () => {
    const phaseMs = { wait: 2_000, recapture: 20_000, refit: 5_000, find: 1_000 };
    let clockMs = 100_000;
    const advance = (milliseconds: number) => {
      clockMs += milliseconds;
    };
    const roundUsage = { label: "Capture retry attempt 2" } as never;
    let findCalls = 0;
    const recapture = vi.fn(async () => {
      advance(phaseMs.recapture);
      return roundUsage;
    });
    const { dependencies } = retryDependencies([], {
      now: () => clockMs,
      findSymbolsToRetry: vi.fn(async () => {
        if (findCalls++ > 0) advance(phaseMs.find);
        return findCalls < 2 ? ["HOOD"] : [];
      }),
      waitForPoolShedding: vi.fn(async () => advance(phaseMs.wait)),
      recapture,
      refit: vi.fn(async () => advance(phaseMs.refit)),
    });
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(recapture).toHaveBeenCalledWith(["HOOD"], { attempt: 2, linesHeldSince: 100_000 });
    expect(result.roundLineUsage).toEqual([roundUsage]);
    expect(result.lineHold).toEqual({ totalHeldMs: 28_000, poolWaitMs: 2_000, capturingMs: 20_000, refittingMs: 5_000, choosingNextQueueMs: 1_000 });
  });

  it("records a failed round capture (a dropped connection) and still runs the next round", async () => {
    const recapture = vi.fn(async () => {
      throw new Error("IBKR connection lost mid-run");
    });
    const { dependencies } = retryDependencies([["HOOD"], ["HOOD"], ["HOOD"]], { recapture });
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(recapture).toHaveBeenCalledTimes(2);
    expect(result.roundErrors).toEqual(["attempt 2: IBKR connection lost mid-run", "attempt 3: IBKR connection lost mid-run"]);
    expect(result.roundLineUsage).toEqual([null, null]);
    expect(result.stillFailingSymbols).toEqual(["HOOD"]);
  });
});

describe("buildCaptureRetryJobOutcome", () => {
  const retryResult = { roundSymbols: [["HOOD", "INTC", "SMCI"]], roundErrors: [], stillFailingSymbols: [], roundLineUsage: [], lineHold: null };

  it("is empty when nothing is left failing", () => {
    expect(buildCaptureRetryJobOutcome(retryResult)).toEqual({});
    expect(buildCaptureRetryJobOutcome({ ...retryResult, roundSymbols: [] })).toEqual({});
  });

  it("completes with errors when some retried tickers are still failing, naming them and any round errors", () => {
    const outcome = buildCaptureRetryJobOutcome({ ...retryResult, roundErrors: ["attempt 2: gateway down"], stillFailingSymbols: ["HOOD", "INTC"] });
    expect(outcome.failureMessage).toBeUndefined();
    expect(outcome.completedWithErrors!.errorCount).toBe(3);
    expect(outcome.completedWithErrors!.message).toBe("2 tickers still have fewer than half of their expiries fitted after 3 attempts: HOOD, INTC; retry capture errors: attempt 2: gateway down; 1 of 3 retried tickers fixed");
    expect(outcome.completedWithErrors!.message).not.toContain("): ");
  });

  it("completes with errors when a round threw but every ticker ended usable", () => {
    expect(buildCaptureRetryJobOutcome({ ...retryResult, roundErrors: ["attempt 2: gateway down"] })).toEqual({ completedWithErrors: { errorCount: 1, message: "retry capture errors: attempt 2: gateway down; 3 of 3 retried tickers fixed" } });
  });

  it("fails when the retries fixed nothing", () => {
    expect(buildCaptureRetryJobOutcome({ ...retryResult, stillFailingSymbols: ["HOOD", "INTC", "SMCI"] })).toEqual({ failureMessage: "3 tickers still have fewer than half of their expiries fitted after 3 attempts: HOOD, INTC, SMCI" });
  });
});
