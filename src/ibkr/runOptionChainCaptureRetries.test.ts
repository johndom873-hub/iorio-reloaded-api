import { describe, expect, it, vi } from "vitest";
import { captureAttemptsPerTicker, captureRetryDelayMs } from "../lib/captureRetryQueue.js";
import { buildCaptureRetryFailureMessage, runCaptureRetryRounds, type CaptureRetryDependencies } from "./runOptionChainCaptureRetries.js";

function retryDependencies(queuesByCall: string[][], overrides: Partial<CaptureRetryDependencies> = {}) {
  const order: string[] = [];
  const release = vi.fn(async () => {
    order.push("release");
  });
  let call = 0;
  const dependencies: CaptureRetryDependencies = {
    findSymbolsToRetry: vi.fn(async () => queuesByCall[Math.min(call++, queuesByCall.length - 1)]!),
    holdLines: vi.fn(async () => {
      order.push("hold");
      return release;
    }),
    sleep: vi.fn(async (milliseconds: number) => {
      order.push(`sleep ${milliseconds}`);
    }),
    recapture: vi.fn(async (symbols: string[]) => {
      order.push(`recapture ${symbols.join(",")}`);
    }),
    refit: vi.fn(async (_tradingDate: string, symbols: string[]) => {
      order.push(`refit ${symbols.join(",")}`);
    }),
    ...overrides,
  };
  return { dependencies, order, release };
}

describe("runCaptureRetryRounds", () => {
  it("does nothing, and never reserves lines, when no ticker needs a retry", async () => {
    const { dependencies } = retryDependencies([[]]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(result).toEqual({ roundSymbols: [], roundErrors: [], stillFailingSymbols: [] });
    expect(dependencies.holdLines).not.toHaveBeenCalled();
  });

  it("makes 3 attempts in all: the first pass plus two retry rounds, one pause per round for the whole queue", async () => {
    const { dependencies, order } = retryDependencies([["HOOD", "INTC"], ["HOOD", "INTC"], ["HOOD"]]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(captureAttemptsPerTicker).toBe(3);
    expect(order).toEqual(["hold", `sleep ${captureRetryDelayMs}`, "recapture HOOD,INTC", "refit HOOD,INTC", `sleep ${captureRetryDelayMs}`, "recapture HOOD,INTC", "refit HOOD,INTC", "release"]);
    expect(result).toEqual({ roundSymbols: [["HOOD", "INTC"], ["HOOD", "INTC"]], roundErrors: [], stillFailingSymbols: ["HOOD"] });
  });

  it("retries only the tickers still failing, and stops as soon as the queue is empty", async () => {
    const { dependencies, order } = retryDependencies([["HOOD", "INTC"], ["HOOD"], []]);
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(order).toEqual(["hold", `sleep ${captureRetryDelayMs}`, "recapture HOOD,INTC", "refit HOOD,INTC", `sleep ${captureRetryDelayMs}`, "recapture HOOD", "refit HOOD", "release"]);
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

  it("records a failed round capture (a dropped connection) and still runs the next round", async () => {
    const recapture = vi.fn(async () => {
      throw new Error("IBKR connection lost mid-run");
    });
    const { dependencies } = retryDependencies([["HOOD"], ["HOOD"], ["HOOD"]], { recapture });
    const result = await runCaptureRetryRounds("2026-10-01", dependencies);
    expect(recapture).toHaveBeenCalledTimes(2);
    expect(result.roundErrors).toEqual(["attempt 2: IBKR connection lost mid-run", "attempt 3: IBKR connection lost mid-run"]);
    expect(result.stillFailingSymbols).toEqual(["HOOD"]);
  });
});

describe("buildCaptureRetryFailureMessage", () => {
  it("is undefined when nothing is left failing", () => {
    expect(buildCaptureRetryFailureMessage({ roundSymbols: [["HOOD"]], roundErrors: [], stillFailingSymbols: [] })).toBeUndefined();
  });

  it("names the tickers still failing and any round errors, without a colon-parenthesis pair the Telegram summary truncates at", () => {
    const message = buildCaptureRetryFailureMessage({ roundSymbols: [["HOOD"]], roundErrors: ["attempt 2: gateway down"], stillFailingSymbols: ["HOOD", "INTC"] })!;
    expect(message).toContain("2 tickers still have fewer than half of their expiries fitted after 3 attempts: HOOD, INTC");
    expect(message).toContain("attempt 2: gateway down");
    expect(message).not.toContain("): ");
  });
});
