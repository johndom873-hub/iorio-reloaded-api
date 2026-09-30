import { describe, expect, it } from "vitest";
import { selectSymbolsToRetry, type CaptureRetryCandidateRow } from "./captureRetryQueue.js";

const row = (symbol: string, snapshotStatus: string | null, okExpiryCount: number, fittableExpiryCount: number): CaptureRetryCandidateRow => ({ symbol, snapshotStatus, okExpiryCount, fittableExpiryCount });

describe("selectSymbolsToRetry", () => {
  it("retries a ticker with no snapshot or a failed one", () => {
    expect(selectSymbolsToRetry([row("NONE", null, 0, 0), row("BAD", "failed", 0, 0), row("FINE", "complete", 6, 8)])).toEqual(["NONE", "BAD"]);
  });

  it("retries when fewer than half of the fittable expiries are ok, and not at exactly half", () => {
    expect(selectSymbolsToRetry([row("HOOD", "complete", 0, 8), row("INTC", "complete", 2, 12), row("HALF", "complete", 4, 8), row("ODD_LOW", "complete", 3, 7), row("ODD_OK", "complete", 4, 7), row("LOW", "complete", 3, 8)])).toEqual(["HOOD", "INTC", "ODD_LOW", "LOW"]);
  });

  it("does not retry a chain the fit had no points for (nothing fittable), nor a fully fitted one", () => {
    expect(selectSymbolsToRetry([row("THIN", "complete", 0, 0), row("GOOD", "partial", 8, 8)])).toEqual([]);
  });
});
