import { describe, expect, it } from "vitest";
import { describeSessionVolumeCaptureOutcome, isSessionVolumeQuoteSettled, planSessionVolumeContracts } from "./runOptionSessionVolumeCapture.js";
import { ladderRequoteBand } from "../pluto/ladderRequoteBand.js";
import type { CapturedOptionQuote } from "./captureOptionQuoteBatch.js";

const settings = { ladderMinDte: 1, ladderMaxDte: 45 };
const band = ladderRequoteBand({ ladderMinAbsDelta: 0.05, ladderMaxAbsDelta: 0.3 }, true);
// Captured on Wed 14 Oct 2026 after the close, for Thu 15 Oct.
const nextSessionIso = "2026-10-15";
const expirations = ["20261015", "20261016", "20261120", "20261130", "20261218"];
const strikesByExpiry = new Map<string, number[]>([
  ["20261015", [100]],
  ["20261016", [80, 95, 100, 105, 130]],
  ["20261120", [100]],
  ["20261130", [100]],
  ["20261218", [100]],
]);

describe("planSessionVolumeContracts", () => {
  it("with no IV known (the first night), quotes every strike of both rights in the ladder's days to expiry, counted from the next session", () => {
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, settings, band, stockPrice: 100, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: new Map() });
    // 15 Oct is 0 DTE and 18 Dec is 64 DTE on 15 Oct: out. 16 Oct (1), 20 Nov (36), 30 Nov (46): 30 Nov is out too.
    expect(plan.contracts.map((contract) => contract.expiry)).toEqual(expect.arrayContaining(["20261016", "20261120"]));
    expect(new Set(plan.contracts.map((contract) => contract.expiry))).toEqual(new Set(["20261016", "20261120"]));
    expect(plan.universeCount).toBe(12);
    expect(plan.unknownIvCount).toBe(12);
    expect(plan.contracts).toHaveLength(12);
  });

  it("with IVs known, quotes the first-look band only (0.02–0.45 for 0.05–0.30), plus any contract still without an IV", () => {
    const iv = 0.5;
    const lastSeen = new Map<string, number>();
    for (const strike of [80, 95, 100, 105, 130]) for (const right of ["C", "P"]) lastSeen.set(`2026-10-16|${strike}|${right}`, iv);
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, settings, band, stockPrice: 100, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: lastSeen });
    const tomorrow = plan.contracts.filter((contract) => contract.expiry === "20261016").map((contract) => `${contract.strike}${contract.right}`).sort();
    // 1 DTE at 50% IV: the $95 Put and $105 Call sit near |delta| 0.2, at the money (~0.5) is out, $80 and $130 are far out (~0).
    expect(tomorrow).toEqual(["105C", "95P"]);
    // 20 Nov has no IV yet: both rights quoted whatever the band.
    expect(plan.contracts.filter((contract) => contract.expiry === "20261120")).toHaveLength(2);
    expect(plan.unknownIvCount).toBe(2);
  });

  it("without a stock price, quotes the whole universe", () => {
    const lastSeen = new Map([["2026-10-16|130|C", 0.5]]);
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, settings, band, stockPrice: null, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: lastSeen });
    expect(plan.contracts).toHaveLength(12);
  });
});

describe("isSessionVolumeQuoteSettled", () => {
  const quote = (fields: Partial<CapturedOptionQuote>) => ({ volume: null, impliedVolatility: null, errorCode: null, ...fields }) as CapturedOptionQuote;
  it("waits for both the volume and the IV, or an error", () => {
    expect(isSessionVolumeQuoteSettled(quote({ volume: 120 }))).toBe(false);
    expect(isSessionVolumeQuoteSettled(quote({ impliedVolatility: 0.4 }))).toBe(false);
    expect(isSessionVolumeQuoteSettled(quote({ volume: 0, impliedVolatility: 0.4 }))).toBe(true);
    expect(isSessionVolumeQuoteSettled(quote({ errorCode: 200 }))).toBe(true);
  });
});

describe("describeSessionVolumeCaptureOutcome", () => {
  const ticker = (symbol: string, error: string | null) => ({ symbol, universe: 10, requested: 10, unknownIv: 0, withVolume: error ? 0 : 10, withImpliedVolatility: 10, stockPrice: 100, error });
  const result = (tickers: ReturnType<typeof ticker>[]) => ({ sessionDateIso: "2026-10-14", nextSessionIso: "2026-10-15", tickers, concurrency: 40, elapsedSeconds: 60 });
  it("fails when no ticker was captured, completes with errors when some were not", () => {
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", null), ticker("SMCI", null)]))).toEqual({});
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", null), ticker("SMCI", "no stored option chain")]))).toEqual({ completedWithErrors: { errorCount: 1, message: "no option volume for SMCI (no stored option chain): the ladder sells nothing on them tomorrow" } });
    expect(describeSessionVolumeCaptureOutcome(result([ticker("SMCI", "no stored option chain")])).failureMessage).toMatch(/no ticker's option volume was captured/);
    expect(describeSessionVolumeCaptureOutcome(result([]))).toEqual({});
  });
});
