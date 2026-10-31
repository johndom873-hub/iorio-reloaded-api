import { describe, expect, it } from "vitest";
import { describeSessionVolumeCaptureOutcome, isSessionVolumeQuoteSettled, planSessionVolumeContracts } from "./runOptionSessionVolumeCapture.js";
import { optionRequoteBand } from "../pluto/optionRequoteBand.js";
import type { CapturedOptionQuote } from "./captureOptionQuoteBatch.js";

const expiryRule = { kind: "days_to_expiry_range", minDte: 1, maxDte: 45 } as const;
const band = optionRequoteBand({ minAbsDelta: 0.05, maxAbsDelta: 0.3 }, true);
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
  it("with no IV known (the first night), quotes every Call and every Put below the price in the ladder's days to expiry, counted from the next session", () => {
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, expiryRule, band, stockPrice: 100, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: new Map() });
    // 15 Oct is 0 DTE and 18 Dec is 64 DTE on 15 Oct: out. 16 Oct (1), 20 Nov (36), 30 Nov (46): 30 Nov is out too.
    expect(plan.contracts.map((contract) => contract.expiry)).toEqual(expect.arrayContaining(["20261016", "20261120"]));
    expect(new Set(plan.contracts.map((contract) => contract.expiry))).toEqual(new Set(["20261016", "20261120"]));
    expect(plan.universeCount).toBe(12);
    expect(plan.unknownIvCount).toBe(12);
    // The ladder's Puts are below the price (under the rung's cap): the $100, $105 and $130 Puts of 16 Oct and the $100 Put of 20 Nov are not quoted.
    expect(plan.contracts).toHaveLength(8);
    expect(plan.contracts.filter((contract) => contract.right === "P").map((contract) => contract.strike)).toEqual([80, 95]);
  });

  it("with IVs known, quotes the Calls in the first-look band (0.02–0.45 for 0.05–0.30) and every Put below the price, plus any Call still without an IV", () => {
    const iv = 0.5;
    const lastSeen = new Map<string, number>();
    for (const strike of [80, 95, 100, 105, 130]) for (const right of ["C", "P"]) lastSeen.set(`2026-10-16|${strike}|${right}`, iv);
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, expiryRule, band, stockPrice: 100, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: lastSeen });
    const tomorrow = plan.contracts.filter((contract) => contract.expiry === "20261016").map((contract) => `${contract.strike}${contract.right}`).sort();
    // 1 DTE at 50% IV: the $105 Call sits near |delta| 0.2, the $100 and $130 Calls are out of the band; the Puts have no
    // |delta| range, so the $80 (far out, ~0) and $95 Puts are quoted, not the $100 and $105 at or above the price.
    expect(tomorrow).toEqual(["105C", "80P", "95P"]);
    // 20 Nov has no IV yet: its Call is quoted whatever the band, its $100 Put (at the price) is not.
    expect(plan.contracts.filter((contract) => contract.expiry === "20261120").map((contract) => contract.right)).toEqual(["C"]);
    expect(plan.unknownIvCount).toBe(2);
  });

  it("for a Vol Farmer v2 ticker, covers only the next listed expiry after the next session", () => {
    // On Thu 15 Oct, the next listed expiry after the session is Fri 16 Oct; 15 Oct itself expires that session.
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, expiryRule: { kind: "next_listed_expiry" }, band, stockPrice: 100, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: new Map() });
    expect(new Set(plan.contracts.map((contract) => contract.expiry))).toEqual(new Set(["20261016"]));
    expect(plan.universeCount).toBe(10);
  });

  it("without a stock price, quotes the whole universe", () => {
    const lastSeen = new Map([["2026-10-16|130|C", 0.5]]);
    const plan = planSessionVolumeContracts({ expirations, strikesByExpiry, nextSessionIso, expiryRule, band, stockPrice: null, riskFreeRate: 0.04, lastSeenImpliedVolatilityByContract: lastSeen });
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
  const ticker = (symbol: string, error: string | null, enabled = true) => ({ symbol, enabled, universe: 10, requested: 10, unknownIv: 0, withVolume: error ? 0 : 10, withImpliedVolatility: 10, stockPrice: 100, error });
  const result = (tickers: ReturnType<typeof ticker>[]) => ({ sessionDateIso: "2026-10-14", nextSessionIso: "2026-10-15", tickers, concurrency: 40, elapsedSeconds: 60 });
  it("fails when no enabled ticker was captured, completes with errors when some were not; the 20% rule is off for them at the next session", () => {
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", null), ticker("SMCI", null)]))).toEqual({});
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", null), ticker("SMCI", "no stored option chain")]))).toEqual({ completedWithErrors: { errorCount: 1, message: "no option volume for SMCI (no stored option chain): the 20% volume rule is off for them on Thu 15 Oct" } });
    expect(describeSessionVolumeCaptureOutcome(result([ticker("SMCI", "no stored option chain")]))).toEqual({ failureMessage: "no enabled ticker's option volume was captured, so the 20% volume rule is off for them on Thu 15 Oct: SMCI (no stored option chain)" });
    expect(describeSessionVolumeCaptureOutcome(result([]))).toEqual({});
  });

  it("names the next session: after a Friday, the Monday", () => {
    const friday = { ...result([ticker("HOOD", null), ticker("SMCI", "timeout")]), sessionDateIso: "2026-10-30", nextSessionIso: "2026-11-02" };
    expect(describeSessionVolumeCaptureOutcome(friday).completedWithErrors?.message).toBe("no option volume for SMCI (timeout): the 20% volume rule is off for them on Mon 2 Nov");
  });

  it("only logs a shortlisted ticker Pluto is not enabled on", () => {
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", null), ticker("GOOG", "no stored option chain", false)]))).toEqual({});
    expect(describeSessionVolumeCaptureOutcome(result([ticker("GOOG", "no stored option chain", false)]))).toEqual({});
    expect(describeSessionVolumeCaptureOutcome(result([ticker("HOOD", "timeout"), ticker("GOOG", null, false)])).failureMessage).toMatch(/^no enabled ticker's option volume was captured/);
  });
});
