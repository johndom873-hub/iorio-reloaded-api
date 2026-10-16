import { ensureBacktestLlmWorkingDirectory, readBacktestClaudeCliPath } from "../backtestClaudeCli.js";
import { callClaudeSubscriptionModel, type ClaudeSubscriptionCallResult } from "../llm/claudeSubscriptionModelClient.js";
import type { AnalysisBacktestFigures } from "./analysisBacktest.js";
import type { AnalysisFigureValues, AnalysisFigures } from "./analysisFigures.js";
import { fitByDay, largestPotOfDay, potOnDayFrom } from "./analysisPotSizing.js";
import { median } from "./analysisPriceFigures.js";
import { backtestEngineVersion } from "../backtestTypes.js";
import { ladderSettingsOf, type AnalysisSessionLadderSettings, type AnalysisSessionRow } from "./analysisSessions.js";

// The Analyse window's Summary and Recommendation from Claude (Marcelo 2026-10-15): Claude reads a digest of the
// figures, the analysis backtest and the ticker's other backtests as they stand, through the subscription CLI, and
// answers a summary plus settings values with reasons and a verdict on the ticker for the CC + Put Ladder.

export const analysisSummaryPromptVersion = 5;
const summaryTimeoutSeconds = 600;
// Opus 5.5 at extra-high effort (Marcelo 2026-10-16); the backtests' decisions keep backtestClaudeModel.
const analysisSummaryClaudeModel = "claude-opus-5-5";
const analysisSummaryReasoningEffort = "xhigh";

export const analysisRecommendationKeys = ["potDollars", "ladderSharesPct", "ladderRungs", "ladderShockPct", "minAbsDelta", "maxAbsDelta", "minDte", "maxDte", "maxSpreadPctOfMid"] as const;
export type AnalysisRecommendationKey = (typeof analysisRecommendationKeys)[number];

export interface AnalysisSummary {
  headline: string;
  paragraphs: string[];
  caveats: string[];
  recommendation: {
    verdict: "qualifies" | "borderline" | "does_not_qualify";
    verdictReason: string;
    /** One per setting; value null for the shock means "keep the rule". */
    values: { key: AnalysisRecommendationKey; value: number | null; reason: string }[];
  };
}

export const analysisSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "paragraphs", "caveats", "recommendation"],
  properties: {
    headline: { type: "string" },
    paragraphs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
    caveats: { type: "array", items: { type: "string" }, maxItems: 4 },
    recommendation: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "verdictReason", "values"],
      properties: {
        verdict: { type: "string", enum: ["qualifies", "borderline", "does_not_qualify"] },
        verdictReason: { type: "string" },
        values: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value", "reason"],
            properties: { key: { type: "string", enum: [...analysisRecommendationKeys] }, value: { type: ["number", "null"] }, reason: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

// Prompt version 5 (approved by Marcelo 2026-10-16): who reads it and what they decide, the verdict and the evidence a
// changed value needs both computed in code (verdictTests, settingEvidence), the data's units and fields explained.
const systemPrompt = `You write the Summary and the Recommendation in the Analyse window: one stock, judged for the CC + Put Ladder. Two people read it: Marcelo, the developer, and Juan, a trader who is not a developer. They use it to decide whether to run the ladder on this stock, and with which values for it. "Try these values" copies your values into the window and "Backtest these values" tests them, so every value you change sends them to a backtest.

<strategy>
Each stock gets a pot of money. The share level (ladderSharesPct) of the pot buys shares, 100 at a time, each lot with a Covered Call sold on it (the Covered Call entry). Calls on shares already held are sold only at or above the cycle's break-even. The rest of the pot is a cash reserve split into rungs (ladderRungs). Each rung sells cash-secured Puts below a cap that steps down from the break-even to the floor, the shares' average cost × (1 − S), where S is the shock: by the rule, the stock's Max drawdown over the lookback kept between a floor and a ceiling, or a fixed value (ladderShockPct). With nothing committed, the first rung's cap is the price × (1 − S ÷ rungs). When the best ladder Put pays a higher premium yield than the best Call on free shares, the Put is sold instead. Unused cash earns T-bill interest.
Every contract must pass the filters: a days-to-expiry range, a spread limit (% of the mid), a minimum bid of $0.05 and a volume limit of 20% of the previous session's volume. There is no minimum yield. An order takes the best contract first and moves down the ranking when the volume limit cuts it, giving up yield. The pot follows the account.
The |delta| range (minAbsDelta, maxAbsDelta; valuesUsed.callsAbsDelta) is the Calls' only. When valuesUsed.putsAbsDelta is "none" the ladder's Puts have no |delta| range: the rung's cap bounds their strike. A backtest whose Puts kept a |delta| range ran a different configuration, and its differsFrom says so.
</strategy>

<how_to_judge>
The ladder is meant to carry less risk than owning the stock: a smaller Max drawdown than buy and hold, with a return that still pays for that risk. The measure is Excess Calmar = (CAGR − T-bill CAGR) ÷ |Max drawdown|, the analysis backtest's against buy and hold's over the same period. A lower CAGR than buy and hold is expected and is not a failure on its own.
The verdict comes from verdictTests, computed from the figures: does_not_qualify when a blocking test fails, qualifies when every test passes, borderline otherwise. Report that verdict and name the test that decided it. If you see something the tests miss, say so in the caveats; do not change the verdict.
</how_to_judge>

<changing_values>
Recommend one value for each setting key. A single stock's backtests run on one price path, so small differences between them are noise. settingEvidence lists, for each key, the backtests that differ from a same-period reference run in that setting alone, and whether each beat it by the margin (excessCalmarMargin).
- Change a value only to one whose test clears the margin. Call it "worth testing", not "better": they will backtest it before using it.
- When tested values did not clear the margin, keep the current value and say the difference was too small.
- When no backtest varied the setting, keep the current value and say it is untested.
- potDollars comes from the pot-size figures: keep the configured pot when it lies inside the last 12 months' range; otherwise recommend the nearer end of that range, rounded to $10,000.
- ladderShockPct: null keeps the rule.
</changing_values>

<reading_the_data>
- Keys ending in Pct are percentages already (50 = 50%). Dollar amounts are in dollars and days are counts. Every other ratio, yield, share, volatility or return is a fraction (0.513 = 51.3%): write it as a percentage, one decimal at most.
- liquidity: by year and days-to-expiry band, the share of days on which at least one contract passed the filters and the median best premium yield (annualised), for Calls and for Puts under the first rung's cap. lastDay is the latest day in detail.
- potSize, for the last 12 months and all history: smallestPot fits the lot and a rung on 80% of days; largestPot keeps each day's orders within the best contracts' volume limits on 80% of days, each day's limit the smaller of the Put side (the best Put under the first rung's cap) and the Call side (the best Call for a new Covered Call entry). Days with no qualifying Put or Call are counted apart (daysWithoutQualifyingPut, daysWithoutQualifyingCall) and left out of largestPot: on those days no ladder sale could be placed. lotFitsShare and rungFitsShare test the configured pot as it followed the analysis backtest's account.
- volatility.impliedMinusWhatFollowed: implied volatility against the realised volatility of the days that followed; shareAbove is how often implied was higher.
- backtests: this stock's CC + Put Ladder backtests on the current engine, each with its settings, period and the settings that differ from the analysis backtest (differsFrom). Runs with identical results are merged (sameResultAs). olderEngineRunsLeftOut counts the runs of earlier engines, whose results do not compare.
</reading_the_data>

<style>
Plain English, short sentences, concrete numbers. Every number you write is in the data or simple arithmetic on it (a difference, a ratio); never invent one. When a number could come from more than one run, name the run. Say "Max drawdown" (never "worst fall") and "Covered Calls" (never "buy-write"). Write contracts as "HOOD $85 Put · 20 Nov (37DTE)".
</style>

<answer>
- headline: one sentence: what kind of stock this is for the ladder, and the main reason for the verdict.
- paragraphs: up to 4, in this order: liquidity of the Calls and of the Puts under the first rung's cap; volatility and what followed, Max drawdown and the shock, earnings moves; how the pot fits (lead with the last 12 months, and say when all history differs and why); the analysis backtest against buy and hold, then what the other backtests changed.
- caveats: limits that change how far the figures can be trusted (short history, missing data, thin years, few sales behind a result); empty when none.
- recommendation: the verdict from verdictTests, a one-sentence reason naming the deciding test, and one entry per setting key with the value and a reason citing the figures, or saying "untested" or "difference too small".
Before you answer, check every number against the data and every changed value against settingEvidence.
</answer>`;

const round = (value: number | null | undefined, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? null : +value.toFixed(digits));

function percentile(sortedAscending: readonly number[], fraction: number): number | null {
  if (sortedAscending.length === 0) return null;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(fraction * sortedAscending.length) - 1))]!;
}

// The verdict's tests and the evidence margin (approved by Marcelo 2026-10-16).
export const analysisVerdictThresholds = { callsPassingBlocking: 0.5, callsPassingQualifies: 0.8, configuredPotFitsShare: 0.95 } as const;
export const analysisExcessCalmarMargin = 0.05;

export interface AnalysisVerdictTest {
  test: string;
  blocking: boolean;
  /** Null when the figures to decide it are missing (no analysis backtest on a trial): it does not pass. */
  passed: boolean | null;
  detail: string;
}

export interface AnalysisVerdictTests {
  verdict: AnalysisSummary["recommendation"]["verdict"];
  tests: AnalysisVerdictTest[];
}

/** Pure: the verdict from the tests: a blocking test failed → does_not_qualify; every test passed → qualifies; else borderline. */
export function verdictFromTests(tests: readonly AnalysisVerdictTest[]): AnalysisVerdictTests["verdict"] {
  if (tests.some((test) => test.blocking && test.passed === false)) return "does_not_qualify";
  return tests.every((test) => test.passed === true) ? "qualifies" : "borderline";
}

/** The settings two runs are compared on, in the window's keys (the Calls' range split into its two ends). */
const comparedSettingKeys = ["potDollars", "ladderSharesPct", "ladderRungs", "ladderShockPct", "minAbsDelta", "maxAbsDelta", "putsAbsDelta", "minDte", "maxDte", "maxSpreadPctOfMid", "ladderPutVersusCall"] as const;
type ComparedSettingKey = (typeof comparedSettingKeys)[number];
/** The keys settingEvidence reports: the recommendation's, but the pot (it comes from the pot-size figures). */
const evidenceKeys = ["ladderSharesPct", "ladderRungs", "ladderShockPct", "minAbsDelta", "maxAbsDelta", "minDte", "maxDte", "maxSpreadPctOfMid"] as const;
type EvidenceKey = (typeof evidenceKeys)[number];

function settingValue(settings: AnalysisSessionLadderSettings, key: ComparedSettingKey): unknown {
  switch (key) {
    case "minAbsDelta":
      return settings.callsAbsDelta[0];
    case "maxAbsDelta":
      return settings.callsAbsDelta[1];
    case "putsAbsDelta":
      return JSON.stringify(settings.putsAbsDelta);
    default:
      return settings[key];
  }
}

/** Pure: the keys on which two runs' settings differ. */
export function differingSettings(a: AnalysisSessionLadderSettings, b: AnalysisSessionLadderSettings): ComparedSettingKey[] {
  return comparedSettingKeys.filter((key) => settingValue(a, key) !== settingValue(b, key));
}

type ComparableRun = Pick<AnalysisSessionRow, "name" | "startDate" | "endDate" | "symbols" | "cagr" | "maxDrawdown" | "excessCalmar" | "engineVersion"> & { ladderSettings: AnalysisSessionLadderSettings };

export interface AnalysisSettingTest {
  value: number | null;
  run: string;
  referenceRun: string;
  period: string;
  excessCalmar: number | null;
  referenceExcessCalmar: number | null;
  excessCalmarChange: number | null;
  cagrChange: number;
  maxDrawdownChange: number;
  clearsMargin: boolean;
}

/**
 * Pure: for each setting, the one-ticker current-engine runs that differ from a same-period reference run (one whose
 * settings are the analysis's) in that setting alone, and whether each beat the reference's Excess Calmar by the margin.
 */
export function settingEvidenceFrom(runs: readonly ComparableRun[], current: AnalysisSessionLadderSettings): { excessCalmarMargin: number; bySetting: Record<EvidenceKey, { current: number | null; tested: AnalysisSettingTest[] }> } {
  const comparable = runs.filter((run) => run.symbols.length === 1 && run.engineVersion === backtestEngineVersion);
  const references = comparable.filter((run) => differingSettings(run.ladderSettings, current).length === 0);
  const bySetting = Object.fromEntries(evidenceKeys.map((key) => [key, { current: settingValue(current, key) as number | null, tested: [] as AnalysisSettingTest[] }])) as Record<EvidenceKey, { current: number | null; tested: AnalysisSettingTest[] }>;
  const seen = new Set<string>();
  for (const reference of references) {
    for (const run of comparable) {
      if (run === reference || run.startDate !== reference.startDate || run.endDate !== reference.endDate) continue;
      const differences = differingSettings(run.ladderSettings, reference.ladderSettings);
      const key = differences[0];
      if (differences.length !== 1 || !(evidenceKeys as readonly string[]).includes(key!)) continue;
      const value = settingValue(run.ladderSettings, key!) as number | null;
      const excessCalmarChange = run.excessCalmar !== null && reference.excessCalmar !== null ? run.excessCalmar - reference.excessCalmar : null;
      const test: AnalysisSettingTest = {
        value,
        run: run.name,
        referenceRun: reference.name,
        period: `${run.startDate} to ${run.endDate}`,
        excessCalmar: round(run.excessCalmar, 2),
        referenceExcessCalmar: round(reference.excessCalmar, 2),
        excessCalmarChange: round(excessCalmarChange, 3),
        cagrChange: round(run.cagr - reference.cagr)!,
        maxDrawdownChange: round(run.maxDrawdown - reference.maxDrawdown)!,
        clearsMargin: excessCalmarChange !== null && excessCalmarChange >= analysisExcessCalmarMargin - 1e-12,
      };
      const identity = `${key}|${value}|${test.period}|${run.cagr}|${run.maxDrawdown}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      bySetting[key as EvidenceKey].tested.push(test);
    }
  }
  return { excessCalmarMargin: analysisExcessCalmarMargin, bySetting };
}

/** The latest calendar year the data covers in full (its last day from 24 Dec on), else the latest year there is. */
function latestFullYear(years: readonly string[], lastDate: string): { year: string; partial: boolean } | null {
  if (years.length === 0) return null;
  const lastYear = lastDate.slice(0, 4);
  const full = lastDate.slice(5) >= "12-24" ? lastYear : String(Number(lastYear) - 1);
  return years.includes(full) ? { year: full, partial: false } : { year: [...years].sort().at(-1)!, partial: true };
}

/** What Claude reads: the figures cut to what a summary needs, at the values given, with the verdict's tests and the settings' evidence. */
export function buildAnalysisSummaryDigest(input: { figures: AnalysisFigures; values: AnalysisFigureValues; backtest: AnalysisBacktestFigures | null; sessions: readonly AnalysisSessionRow[]; missingWeekdaysLastTwelveMonths: number | null }) {
  const { figures, values, backtest } = input;
  const baseline = values.baseline;
  const fixedShock = baseline.ladderShock === "fixed" ? baseline.ladderShockPct / 100 : null;
  const ladderValues = { shares: baseline.ladderSharesPct / 100, rungs: baseline.ladderRungs, fixedShock };
  const potOnDay = backtest ? potOnDayFrom(backtest.potPath) : null;
  const fit = fitByDay(figures.fitDays.map(([date, price, shock]) => ({ date, price, shock })), ladderValues, potOnDay);
  const lastYearFrom = `${Number(figures.optionLastDate.slice(0, 4)) - 1}${figures.optionLastDate.slice(4)}`;
  const largestByDay = figures.fitDays.map(([date, price, , putVolumeCap, putStrike, callVolumeCap]) => ({ date, putVolumeCap, callVolumeCap, largest: largestPotOfDay({ date, price, putVolumeCap, putStrike, callVolumeCap }, ladderValues) }));
  // As the Pot size card shows it at 80%: smallest = the 80% point of the daily smallest pots from below, largest = the
  // 80% point of the daily largest pots from above; a range only when smallest ≤ largest.
  const potRange = (fromExclusive: string | null) => {
    const days = fit.filter((row) => fromExclusive === null || row.date > fromExclusive);
    const smallest = percentile(days.map((row) => row.smallestPot).sort((a, b) => a - b), 0.8);
    const largestDays = largestByDay.filter((row) => fromExclusive === null || row.date > fromExclusive);
    const counted = largestDays.flatMap((row) => (row.largest === null ? [] : [row.largest]));
    const largest = percentile(counted.map((row) => row.pot).sort((a, b) => a - b), 0.2);
    const share = (fits: (row: (typeof days)[number]) => boolean | null) => (potOnDay === null ? null : round(days.filter((row) => fits(row) === true).length / Math.max(1, days.length)));
    return {
      days: days.length,
      lotFitsShare: share((row) => row.lotFits),
      rungFitsShare: share((row) => row.rungFits),
      smallestPot: round(smallest, 0),
      largestPot: round(largest, 0),
      daysWithoutQualifyingPut: largestDays.filter((row) => row.putVolumeCap === null).length,
      daysWithoutQualifyingCall: largestDays.filter((row) => row.callVolumeCap === null).length,
      callsSetLargest: counted.filter((row) => row.right === "C").length,
      noPotSuits: smallest !== null && largest !== null && smallest > largest,
      configuredPotInside: smallest !== null && largest !== null && values.potDollars >= smallest && values.potDollars <= largest,
    };
  };
  const grid = (view: "C" | "Pcap") =>
    Object.fromEntries(Object.entries(figures.chains.grid[view]).map(([year, ranges]) => [year, Object.fromEntries(Object.entries(ranges).map(([range, cell]) => [range, { shareOfDaysPassing: round(cell.daysWithPassing / Math.max(1, cell.days)), medianBestYield: round(cell.medianBestYield) }]))]));
  const callsGrid = grid("C");
  const potLastTwelveMonths = potRange(lastYearFrom);
  const current = ladderSettingsOf(baseline, values.potDollars);

  // The analysis backtest's row (its Excess Calmar, buy and hold's, the T-bill CAGR over its period).
  const analysisRow = backtest ? (input.sessions.find((row) => row.id === backtest.sessionId) ?? null) : null;
  const analysisMaxDrawdown = backtest?.metrics?.maxDrawdown ?? null;
  const buyAndHoldMaxDrawdown = backtest?.buyAndHoldMetrics?.maxDrawdown ?? null;

  // The verdict's tests.
  const callsYear = latestFullYear(Object.keys(callsGrid), figures.optionLastDate);
  const bestCallsShare = callsYear ? Math.max(0, ...Object.values(callsGrid[callsYear.year] ?? {}).map((cell) => cell.shareOfDaysPassing ?? 0)) : null;
  const callsYearText = callsYear ? `${callsYear.year}${callsYear.partial ? " (partial year)" : ""}` : "no year";
  const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;
  const tests: AnalysisVerdictTest[] = [
    { test: "No missing weekdays in the last 12 months", blocking: true, passed: input.missingWeekdaysLastTwelveMonths === null ? null : input.missingWeekdaysLastTwelveMonths === 0, detail: `${input.missingWeekdaysLastTwelveMonths ?? "unknown"} missing` },
    { test: "Some pot fits the last 12 months", blocking: true, passed: potLastTwelveMonths.smallestPot !== null && potLastTwelveMonths.largestPot !== null && !potLastTwelveMonths.noPotSuits, detail: `smallest ${potLastTwelveMonths.smallestPot ?? "none"}, largest ${potLastTwelveMonths.largestPot ?? "none"}` },
    { test: `Calls pass the filters on at least ${percent(analysisVerdictThresholds.callsPassingBlocking)} of days in the best band, latest full year`, blocking: true, passed: bestCallsShare === null ? null : bestCallsShare >= analysisVerdictThresholds.callsPassingBlocking, detail: `${callsYearText}: ${bestCallsShare === null ? "none" : percent(bestCallsShare)}` },
    { test: "The analysis backtest's Max drawdown is smaller than buy and hold's", blocking: true, passed: analysisMaxDrawdown === null || buyAndHoldMaxDrawdown === null ? null : Math.abs(analysisMaxDrawdown) < Math.abs(buyAndHoldMaxDrawdown), detail: analysisMaxDrawdown === null || buyAndHoldMaxDrawdown === null ? "no analysis backtest" : `${percent(Math.abs(analysisMaxDrawdown))} against ${percent(Math.abs(buyAndHoldMaxDrawdown))}` },
    { test: `The configured pot is inside the last 12 months' range, the lot and a rung fitting on at least ${percent(analysisVerdictThresholds.configuredPotFitsShare)} of days`, blocking: false, passed: potLastTwelveMonths.lotFitsShare === null || potLastTwelveMonths.rungFitsShare === null ? null : potLastTwelveMonths.configuredPotInside && potLastTwelveMonths.lotFitsShare >= analysisVerdictThresholds.configuredPotFitsShare && potLastTwelveMonths.rungFitsShare >= analysisVerdictThresholds.configuredPotFitsShare, detail: `pot ${values.potDollars}, inside: ${potLastTwelveMonths.configuredPotInside}, lot fits ${potLastTwelveMonths.lotFitsShare ?? "unknown"}, rung fits ${potLastTwelveMonths.rungFitsShare ?? "unknown"}` },
    { test: `Calls pass the filters on at least ${percent(analysisVerdictThresholds.callsPassingQualifies)} of days in the best band, latest full year`, blocking: false, passed: bestCallsShare === null ? null : bestCallsShare >= analysisVerdictThresholds.callsPassingQualifies, detail: `${callsYearText}: ${bestCallsShare === null ? "none" : percent(bestCallsShare)}` },
    { test: "The analysis backtest's Excess Calmar is at least buy and hold's", blocking: false, passed: analysisRow?.excessCalmar == null || analysisRow.buyAndHoldExcessCalmar == null ? null : analysisRow.excessCalmar >= analysisRow.buyAndHoldExcessCalmar, detail: analysisRow ? `${round(analysisRow.excessCalmar, 2)} against ${round(analysisRow.buyAndHoldExcessCalmar, 2)}` : "no analysis backtest" },
  ];

  // The backtests: this symbol's ladder runs on the current engine, identical results merged.
  const ladderRuns = input.sessions.filter((row): row is AnalysisSessionRow & { ladderSettings: AnalysisSessionLadderSettings } => row.ladder && row.ladderSettings !== null);
  const currentEngineRuns = ladderRuns.filter((row) => row.engineVersion === backtestEngineVersion);
  const merged = new Map<string, { row: (typeof currentEngineRuns)[number]; sameResultAs: string[] }>();
  for (const row of [...currentEngineRuns].sort((a, b) => (b.excessCalmar ?? -Infinity) - (a.excessCalmar ?? -Infinity))) {
    const resultKey = `${row.startDate}|${row.endDate}|${row.symbols.length}|${round(row.cagr, 6)}|${round(row.maxDrawdown, 6)}`;
    const entry = merged.get(resultKey);
    if (!entry) merged.set(resultKey, { row, sameResultAs: [] });
    // The run closest to the analysis's values speaks for the group.
    else if (differingSettings(row.ladderSettings, current).length < differingSettings(entry.row.ladderSettings, current).length) {
      entry.sameResultAs.push(entry.row.name);
      entry.row = row;
    } else entry.sameResultAs.push(row.name);
  }
  const backtestListLimit = 40;
  const listed = [...merged.values()];

  const earningsNext = figures.earnings.next;
  const profileOf = (profile: AnalysisFigures["profile"]["all"] | null) => profile && { label: profile.label, from: profile.from, to: profile.to, cagr: round(profile.cagr), jumps: profile.jumps, jumpsOnReports: profile.jumpsOnReports, largestJump: profile.largestJump && { date: profile.largestJump.date, move: round(profile.largestJump.move) } };
  return {
    symbol: figures.symbol,
    valuesUsed: { ...current, shock: baseline.ladderShock === "fixed" ? `fixed ${baseline.ladderShockPct}%` : `rule: Max drawdown over ${baseline.ladderShockLookbackYears} years kept in ${baseline.ladderShockMinPct}–${baseline.ladderShockMaxPct}%` },
    data: { optionDays: figures.dataQuality.completeDays, from: figures.dataQuality.firstDate, to: figures.dataQuality.lastDate, missingWeekdays: figures.dataQuality.missingWeekdays, missingWeekdaysLastTwelveMonths: input.missingWeekdaysLastTwelveMonths, daysWithoutPrice: figures.dataQuality.daysWithoutPrice, dailyBars: figures.dataQuality.bars.count, barChecks: figures.dataQuality.barChecks },
    price: { maxDrawdown: Object.fromEntries(Object.entries(figures.maxDrawdown).map(([range, value]) => [range, value && { depth: round(value.depth), peak: value.peakDate, trough: value.troughDate, recovered: value.recoveredOn }])), profileAll: profileOf(figures.profile.all), profileTwoYears: profileOf(figures.profile.twoYear) },
    volatility: { impliedNow: round(figures.volatility.impliedNow), yangZhang21Now: round(figures.volatility.yangZhang21Now), impliedMinusWhatFollowed: { all: figures.volatility.impliedVersusRealised.all, lastYear: figures.volatility.impliedVersusRealised.lastYear } },
    shock: figures.shock,
    liquidity: { callsByYearAndDte: callsGrid, putsUnderFirstCapByYearAndDte: grid("Pcap"), lastDay: figures.chains.lastDay, spreadShareUnder25: round(figures.chains.spreadShareUnder25) },
    potSize: { lastTwelveMonths: potLastTwelveMonths, allHistory: potRange(null), largestPotContractsChosenWithoutVolatilityModel: figures.largestPotWithoutModel },
    ordersTooLarge: backtest && { saleDays: backtest.saleDays, ordersOverOneStrike: backtest.ordersOverOneStrike, ordersPartlyUnsold: backtest.ordersPartlyUnsold, byYear: backtest.byYear },
    analysisBacktest: backtest && {
      name: backtest.name,
      from: backtest.startDate,
      to: backtest.endDate,
      cagr: round(backtest.metrics?.cagr),
      maxDrawdown: round(backtest.metrics?.maxDrawdown),
      excessCalmar: round(analysisRow?.excessCalmar, 2),
      treasuryBillCagr: round(analysisRow?.treasuryBillCagr),
      buyAndHoldCagr: round(backtest.buyAndHoldMetrics?.cagr),
      buyAndHoldMaxDrawdown: round(backtest.buyAndHoldMetrics?.maxDrawdown),
      buyAndHoldExcessCalmar: round(analysisRow?.buyAndHoldExcessCalmar, 2),
    },
    earnings: { reports: figures.earnings.reports.length, medianAbsMoveTwoSessions: round(figures.earnings.medianAbsMove), largest: figures.earnings.largest, medianImpliedMove: round(figures.earnings.medianImpliedMove), beyondImplied: `${figures.earnings.beyondImplied} of ${figures.earnings.withImplied}`, next: earningsNext && { date: earningsNext.date, time: earningsNext.afterClose === true ? "after close" : earningsNext.afterClose === false ? "before open" : "unknown" } },
    correlation: figures.correlation.rows.filter((row) => row.window === 252 && row.correlation !== null).sort((a, b) => b.correlation! - a.correlation!).slice(0, 6).map((row) => ({ symbol: row.symbol, correlation: round(row.correlation, 2), beta: round(row.beta, 2) })),
    verdictTests: { verdict: verdictFromTests(tests), tests },
    settingEvidence: settingEvidenceFrom(currentEngineRuns, current),
    backtests: listed.slice(0, backtestListLimit).map(({ row, sameResultAs }) => ({
      name: row.name,
      from: row.startDate,
      to: row.endDate,
      ranOn: row.createdAt.slice(0, 10),
      tickers: row.symbols.length,
      settings: row.ladderSettings,
      differsFrom: differingSettings(row.ladderSettings, current),
      cagr: round(row.cagr),
      maxDrawdown: round(row.maxDrawdown),
      excessCalmar: round(row.excessCalmar, 2),
      buyAndHoldCagr: round(row.buyAndHoldCagr),
      buyAndHoldExcessCalmar: round(row.buyAndHoldExcessCalmar, 2),
      sameResultAs,
    })),
    backtestsLeftOutOfList: Math.max(0, listed.length - backtestListLimit),
    olderEngineRunsLeftOut: ladderRuns.length - currentEngineRuns.length,
  };
}

export type AnalysisSummaryOutcome =
  | { status: "written"; summary: AnalysisSummary; call: ClaudeSubscriptionCallResult }
  | { status: "not_configured"; error: string }
  | { status: "usage_limit" | "failed"; error: string; call: ClaudeSubscriptionCallResult | null };

/** The data wrapped in tags, the request after it (long input first, the ask last). */
export function analysisSummaryUserMessage(digest: ReturnType<typeof buildAnalysisSummaryDigest>): string {
  return `<analysis_data>\n${JSON.stringify(digest)}\n</analysis_data>\n\nWrite the Summary and the Recommendation for ${digest.symbol} from the data above.`;
}

export async function writeAnalysisSummary(digest: ReturnType<typeof buildAnalysisSummaryDigest>): Promise<AnalysisSummaryOutcome> {
  const cliPath = readBacktestClaudeCliPath();
  if (cliPath === null) return { status: "not_configured", error: "BACKTEST_CLAUDE_CLI_PATH is not set in the API's .env: Claude's summary needs the Claude Code CLI." };
  const call = await callClaudeSubscriptionModel({ cliPath, workingDirectory: ensureBacktestLlmWorkingDirectory(), timeoutSeconds: summaryTimeoutSeconds, systemPrompt, userPayload: analysisSummaryUserMessage(digest), jsonSchema: analysisSummaryJsonSchema, model: analysisSummaryClaudeModel, effort: analysisSummaryReasoningEffort });
  if (!call.ok || call.rawText === null) return { status: call.usageLimitReached ? "usage_limit" : "failed", error: call.error ?? "Claude gave no answer.", call };
  let summary: AnalysisSummary;
  try {
    summary = JSON.parse(call.rawText) as AnalysisSummary;
  } catch {
    return { status: "failed", error: "Claude's answer was not JSON.", call };
  }
  // The verdict is the tests', whatever the answer says.
  summary.recommendation.verdict = digest.verdictTests.verdict;
  return { status: "written", summary, call };
}
