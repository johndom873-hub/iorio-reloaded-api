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
  lastCompletedSession: "2026-09-30",
  latestBarDateBySymbol: { AAA: "2026-09-30", BBB: "2026-09-30" },
  riskFreeRateFetchedAt: new Date("2026-09-19T12:00:00Z"),
  marketCalendarDaysAhead: 14,
  latestTickerCalendarCapturedAt: new Date("2026-09-30T20:00:00Z"),
  latestMajorMacroEventsCapturedAt: new Date("2026-09-30T20:00:00Z"),
  earningsDatesBySymbol: { AAA: ["2026-09-10", "2026-12-09"], BBB: ["2026-10-28"] },
  earningsReportDatesBySymbol: { AAA: { lastReportIso: "2026-09-10", nextReportIso: "2026-12-09" }, BBB: { lastReportIso: "2026-07-29", nextReportIso: "2026-10-28" } },
  todayEasternIso: "2026-10-01",
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

  it("flags an empty universe and stale or missing bars, and has no Day Signals pool check (the seed job warns on an empty pool)", () => {
    const inputs = healthyInputs();
    inputs.latestBarDateBySymbol = { AAA: "2026-09-29", BBB: null };
    expect(evaluateDataInvariants(healthyInputs()).some((result) => result.name === "Day Signals pool")).toBe(false);
    expect(failing(inputs).find((problem) => problem.name === "Daily price bars")?.detail).toBe("behind 2026-09-30: AAA (2026-09-29), BBB (none)");
    expect(failing({ ...healthyInputs(), universeSymbols: [], snapshots: [] }).some((problem) => problem.name === "Capture universe")).toBe(true);
  });

  it("flags a risk-free rate older than 25 days or never stored", () => {
    expect(failing({ ...healthyInputs(), riskFreeRateFetchedAt: new Date("2026-09-05T00:00:00Z") })[0]?.name).toBe("Risk-free rate");
    expect(failing({ ...healthyInputs(), riskFreeRateFetchedAt: null })[0]?.detail).toContain("no rate stored");
  });

  it("flags short market-calendar coverage and stale or missing calendar data", () => {
    const problems = failing({ ...healthyInputs(), marketCalendarDaysAhead: 13, latestTickerCalendarCapturedAt: new Date("2026-09-29T00:00:00Z"), latestMajorMacroEventsCapturedAt: null });
    expect(problems.map((problem) => problem.name)).toEqual(["Market calendar", "Ticker calendar (earnings, dividends)", "Major macro events"]);
  });

  it("flags a ticker with two earnings dates less than 45 days apart (a moved date left behind)", () => {
    const problems = failing({ ...healthyInputs(), earningsDatesBySymbol: { AAA: ["2026-09-10", "2026-12-09"], HOOD: ["2026-11-04", "2026-10-27"] } });
    expect(problems).toEqual([{ name: "Earnings dates", ok: false, detail: "two earnings dates within 45 days: HOOD (2026-10-27 and 2026-11-04)" }]);
    expect(failing({ ...healthyInputs(), earningsDatesBySymbol: { AAA: ["2026-09-10", "2026-10-25"] } })).toEqual([]); // exactly 45 days
    // Two sources a day apart about a report already past: harmless, not flagged.
    expect(failing({ ...healthyInputs(), earningsDatesBySymbol: { WDC: ["2026-09-04", "2026-09-05", "2026-11-04"] } })).toEqual([]);
  });

  it("flags a next earnings date far past the last report, and a missing one long after it (NBIS, 2026-10-27)", () => {
    const problems = failing({
      ...healthyInputs(),
      earningsReportDatesBySymbol: {
        AAA: { lastReportIso: "2026-09-10", nextReportIso: "2026-12-09" },
        NBIS: { lastReportIso: "2026-08-12", nextReportIso: "2027-02-16" },
        MU: { lastReportIso: "2026-07-01", nextReportIso: null },
        GS: { lastReportIso: "2026-09-20", nextReportIso: null },
      },
    });
    expect(problems).toEqual([
      {
        name: "Next earnings date",
        ok: false,
        detail: "doubtful (more than 150 days after the last report, or none 60 days after it), so unresolved in Signals and Pluto won't open: NBIS (last 2026-08-12, next 2027-02-16), MU (last 2026-07-01, next none)",
      },
    ]);
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
