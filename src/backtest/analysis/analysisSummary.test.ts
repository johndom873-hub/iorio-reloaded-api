import { describe, expect, it } from "vitest";
import { backtestEngineVersion } from "../backtestTypes.js";
import type { AnalysisSessionLadderSettings } from "./analysisSessions.js";
import { analysisSummaryUserMessage, differingSettings, settingEvidenceFrom, verdictFromTests, type AnalysisVerdictTest } from "./analysisSummary.js";

const current: AnalysisSessionLadderSettings = { potDollars: 200_000, ladderSharesPct: 50, ladderRungs: 5, ladderShockPct: null, callsAbsDelta: [0.05, 0.3], putsAbsDelta: "none", minDte: 1, maxDte: 45, maxSpreadPctOfMid: 50, ladderPutVersusCall: "higher_yield" };
const test = (blocking: boolean, passed: boolean | null): AnalysisVerdictTest => ({ test: "a test", blocking, passed, detail: "" });

describe("verdictFromTests", () => {
  it("does not qualify on a failed blocking test, qualifies when every test passes, else is borderline", () => {
    expect(verdictFromTests([test(true, false), test(false, true)])).toBe("does_not_qualify");
    expect(verdictFromTests([test(true, true), test(false, true)])).toBe("qualifies");
    expect(verdictFromTests([test(true, true), test(false, false)])).toBe("borderline");
    // A test without the figures to decide it (a trial has no analysis backtest) does not pass, and does not block.
    expect(verdictFromTests([test(true, null), test(false, true)])).toBe("borderline");
  });
});

describe("differingSettings", () => {
  it("compares the Calls' range end by end, and the Puts' range as a whole", () => {
    expect(differingSettings(current, { ...current })).toEqual([]);
    expect(differingSettings(current, { ...current, callsAbsDelta: [0.05, 0.4] })).toEqual(["maxAbsDelta"]);
    expect(differingSettings(current, { ...current, putsAbsDelta: [0.05, 0.3], ladderSharesPct: 30 })).toEqual(["ladderSharesPct", "putsAbsDelta"]);
  });
});

describe("settingEvidenceFrom", () => {
  const run = (name: string, settings: Partial<AnalysisSessionLadderSettings>, excessCalmar: number, overrides: { startDate?: string; symbols?: string[]; engineVersion?: number | null } = {}) => ({
    name,
    startDate: overrides.startDate ?? "2020-01-02",
    endDate: "2026-10-09",
    symbols: overrides.symbols ?? ["CSCO"],
    cagr: 0.08,
    maxDrawdown: -0.17,
    excessCalmar,
    engineVersion: overrides.engineVersion === undefined ? backtestEngineVersion : overrides.engineVersion,
    ladderSettings: { ...current, ...settings },
  });

  it("pairs each run that differs in one setting with a same-period reference on the analysis's values, and checks the margin", () => {
    const evidence = settingEvidenceFrom(
      [
        run("reference", {}, 0.3),
        run("30% shares", { ladderSharesPct: 30 }, 0.36),
        run("70% shares", { ladderSharesPct: 70 }, 0.33),
        run("Calls 0.40", { callsAbsDelta: [0.05, 0.4] }, 0.31),
        // Not evidence: two settings changed; another period; several tickers; an older engine.
        run("30% shares, 4 rungs", { ladderSharesPct: 30, ladderRungs: 4 }, 0.5),
        run("other period", { ladderSharesPct: 30 }, 0.5, { startDate: "2021-01-04" }),
        run("two tickers", { ladderSharesPct: 30 }, 0.5, { symbols: ["CSCO", "HOOD"] }),
        run("older engine", { ladderSharesPct: 30 }, 0.5, { engineVersion: null }),
      ],
      current,
    );
    expect(evidence.excessCalmarMargin).toBe(0.05);
    expect(evidence.bySetting.ladderSharesPct.current).toBe(50);
    expect(evidence.bySetting.ladderSharesPct.tested.map((entry) => [entry.value, entry.excessCalmarChange, entry.clearsMargin])).toEqual([
      [30, 0.06, true],
      [70, 0.03, false],
    ]);
    expect(evidence.bySetting.maxAbsDelta.tested).toMatchObject([{ value: 0.4, referenceRun: "reference", clearsMargin: false }]);
    expect(evidence.bySetting.ladderRungs.tested).toEqual([]);
  });

  it("finds nothing without a reference run on the analysis's values (here every run kept a Puts' |delta| range)", () => {
    const evidence = settingEvidenceFrom([run("Puts on a range", { putsAbsDelta: [0.05, 0.3] }, 0.3), run("Puts on a range, 30% shares", { putsAbsDelta: [0.05, 0.3], ladderSharesPct: 30 }, 0.5)], current);
    expect(Object.values(evidence.bySetting).every((entry) => entry.tested.length === 0)).toBe(true);
  });
});

describe("analysisSummaryUserMessage", () => {
  it("puts the data in tags first and the request after it", () => {
    const message = analysisSummaryUserMessage({ symbol: "CSCO" } as Parameters<typeof analysisSummaryUserMessage>[0]);
    expect(message).toBe('<analysis_data>\n{"symbol":"CSCO"}\n</analysis_data>\n\nWrite the Summary and the Recommendation for CSCO from the data above.');
  });
});
