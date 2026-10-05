import { describe, expect, it } from "vitest";
import { evaluateDataInvariants, type DataInvariantInputs, type SnapshotFacts } from "./dataInvariants.js";

const now = new Date("2026-10-01T14:16:00Z");
const snapshot = (symbol: string, overrides: Partial<SnapshotFacts> = {}): SnapshotFacts => ({
  symbol,
  status: "complete",
  riskFreeRatePercent: 3.72,
  contractsRequested: 100,
  contractsWithTwoSidedQuote: 95,
  contractsWithImpliedVolatility: 90,
  okFitCount: 6,
  ...overrides,
});
const healthyInputs = (): DataInvariantInputs => ({
  now,
  universeSymbols: ["AAA", "BBB"],
  snapshots: [snapshot("AAA"), snapshot("BBB")],
  dayPoolExpiryCount: 5,
  lastCompletedSession: "2026-09-30",
  latestBarDateBySymbol: { AAA: "2026-09-30", BBB: "2026-09-30" },
  riskFreeRateFetchedAt: new Date("2026-09-19T12:00:00Z"),
  marketCalendarDaysAhead: 14,
  latestTickerCalendarCapturedAt: new Date("2026-09-30T20:00:00Z"),
  latestEconomicCalendarCapturedAt: new Date("2026-09-30T20:00:00Z"),
});
const failing = (inputs: DataInvariantInputs) => evaluateDataInvariants(inputs).filter((result) => !result.ok);

describe("evaluateDataInvariants", () => {
  it("passes on a healthy morning", () => {
    expect(failing(healthyInputs())).toEqual([]);
  });

  it("flags a universe ticker with no snapshot and a snapshot that is not complete", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA", { status: "partial" })];
    const [problem] = failing(inputs);
    expect(problem?.detail).toBe("not complete: BBB (missing), AAA (partial)");
  });

  it("flags a missing risk-free rate on a snapshot (the 2026-09-30 prod failure)", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA", { riskFreeRatePercent: null }), snapshot("BBB", { riskFreeRatePercent: null })];
    expect(failing(inputs).map((problem) => problem.name)).toEqual(["Risk-free rate on snapshots"]);
  });

  it("flags quote and IV coverage below the floors, but not at the floor", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA", { contractsWithTwoSidedQuote: 75, contractsWithImpliedVolatility: 70 }), snapshot("BBB", { contractsWithTwoSidedQuote: 74, contractsWithImpliedVolatility: 69 })];
    const problems = failing(inputs);
    expect(problems.map((problem) => problem.name)).toEqual(["Two-sided quote coverage", "Implied volatility coverage"]);
    expect(problems[0]?.detail).toBe("below 75%: BBB 74%");
  });

  it("flags snapshots with no fitted expiry, ignoring failed snapshots (already reported as not complete)", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA", { okFitCount: 0 }), snapshot("BBB", { status: "failed", okFitCount: 0 })];
    expect(failing(inputs).map((problem) => problem.name)).toEqual(["Today's option-chain snapshots", "Surface fits"]);
    expect(failing(inputs).find((problem) => problem.name === "Surface fits")?.detail).toBe("no fitted expiry for: AAA");
  });

  it("flags an empty Day Signals pool, an empty universe and stale or missing bars", () => {
    const inputs = healthyInputs();
    inputs.dayPoolExpiryCount = 0;
    inputs.latestBarDateBySymbol = { AAA: "2026-09-29", BBB: null };
    const names = failing(inputs).map((problem) => problem.name);
    expect(names).toContain("Day Signals pool");
    expect(failing(inputs).find((problem) => problem.name === "Daily price bars")?.detail).toBe("behind 2026-09-30: AAA (2026-09-29), BBB (none)");
    expect(failing({ ...healthyInputs(), universeSymbols: [], snapshots: [] }).some((problem) => problem.name === "Capture universe")).toBe(true);
  });

  it("flags a risk-free rate older than 25 days or never stored", () => {
    expect(failing({ ...healthyInputs(), riskFreeRateFetchedAt: new Date("2026-09-05T00:00:00Z") })[0]?.name).toBe("Risk-free rate");
    expect(failing({ ...healthyInputs(), riskFreeRateFetchedAt: null })[0]?.detail).toContain("no rate stored");
  });

  it("flags short market-calendar coverage and stale or missing calendar data", () => {
    const problems = failing({ ...healthyInputs(), marketCalendarDaysAhead: 13, latestTickerCalendarCapturedAt: new Date("2026-09-29T00:00:00Z"), latestEconomicCalendarCapturedAt: null });
    expect(problems.map((problem) => problem.name)).toEqual(["Market calendar", "Ticker calendar (earnings, dividends)", "Economic calendar"]);
  });

  it("does not repeat a failed snapshot as a missing rate or thin coverage (it is already reported as not complete)", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA"), snapshot("BBB", { status: "failed", riskFreeRatePercent: null, contractsRequested: 0, contractsWithTwoSidedQuote: 0, contractsWithImpliedVolatility: 0, okFitCount: 0 })];
    expect(failing(inputs).map((problem) => problem.name)).toEqual(["Today's option-chain snapshots"]);
  });

  it("counts only complete universe snapshots in the healthy detail line", () => {
    const inputs = healthyInputs();
    inputs.snapshots = [snapshot("AAA"), snapshot("BBB"), snapshot("EXTRA")];
    expect(evaluateDataInvariants(inputs)[0]?.detail).toBe("2 of 2 complete");
  });
});
