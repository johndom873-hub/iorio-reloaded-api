import { ensureBacktestLlmWorkingDirectory, readBacktestClaudeCliPath } from "../backtestClaudeCli.js";
import { callClaudeSubscriptionModel, type ClaudeSubscriptionCallResult } from "../llm/claudeSubscriptionModelClient.js";
import type { AnalysisBacktestFigures } from "./analysisBacktest.js";
import type { AnalysisFigureValues, AnalysisFigures } from "./analysisFigures.js";
import { fitByDay } from "./analysisPotSizing.js";
import { median } from "./analysisPriceFigures.js";
import type { AnalysisSessionRow } from "./analysisSessions.js";

// The Analyse window's Summary and Recommendation from Claude (Marcelo 2026-10-15): Claude reads a digest of the
// figures, the analysis backtest and the ticker's other backtests as they stand, through the subscription CLI, and
// answers a summary plus settings values with reasons and a verdict on the ticker for the CC + Put Ladder.

export const analysisSummaryPromptVersion = 3;
const summaryTimeoutSeconds = 240;

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

const systemPrompt = `You analyse one stock for an options strategy called the CC + Put Ladder, for two people: a developer and a trader who is not a developer. Write plain English, short sentences, concrete numbers from the data given. Never invent a figure that is not in the data.

The strategy: a pot of cash is split into a share level p (the share of the pot that buys shares at the start, then sells Covered Calls on every lot held) and a reserve (1 − p) split into n rungs. Each rung sells cash-secured Puts below a cap: rung k's cap = the cycle's peak price × (1 − S × k ÷ n), where S is the shock (the rule takes the stock's Max drawdown over the lookback, kept between its floor and ceiling, or a fixed value). Contracts must pass the filters: |delta| range, days-to-expiry range, spread limit (% of the mid), a fixed minimum bid of $0.05 and a fixed volume limit of 20% of the previous session's volume. There is no minimum yield. Each order sells the best contract first and moves down the ranking when the volume limit cuts it, which gives up yield.

Numbers in the data: every ratio, yield, share, volatility and return is a fraction (0.513 means 51.3%, 0.902 means 90.2%); dollar amounts are dollars; days are counts. Convert fractions to percentages when you write them.

Terms: always say "Max drawdown" (never "worst fall"), "Covered Calls" (never "buy-write"), "Excess Calmar" = (CAGR − T-bill CAGR) ÷ |Max drawdown|. Write contracts as "HOOD $85 Put · 20 Nov (37DTE)". Percentages: one decimal at most.

Answer with:
- headline: one sentence on what kind of stock this is for the strategy.
- paragraphs: 2 to 4 short paragraphs: liquidity of Calls and of Puts under the first rung's cap, volatility and what followed, Max drawdown and the shock, how the pot fits (potSize: the smallest pot that fits the lot and a rung on 80% of days, the largest whose orders fit the best contract's volume limit on 80% of sale days, per window; lead with the last 12 months, say when the two windows differ and why), earnings moves, and what the backtests showed.
- caveats: data limits that matter (short history, missing data, thin years); empty when none.
- recommendation: a verdict (qualifies, borderline, does_not_qualify) with a one-sentence reason, and one entry per setting key (potDollars, ladderSharesPct, ladderRungs, ladderShockPct, minAbsDelta, maxAbsDelta, minDte, maxDte, maxSpreadPctOfMid) with the value you recommend and a reason citing the figures. ladderShockPct null means keep the rule. Recommend the current value when you have no evidence to change it, and say so. These values are your judgement; they have not been tested.`;

const round = (value: number | null | undefined, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? null : +value.toFixed(digits));

function percentile(sortedAscending: readonly number[], fraction: number): number | null {
  if (sortedAscending.length === 0) return null;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(fraction * sortedAscending.length) - 1))]!;
}

/** What Claude reads: the figures cut to what a summary needs, at the values given. */
export function buildAnalysisSummaryDigest(input: { figures: AnalysisFigures; values: AnalysisFigureValues; backtest: AnalysisBacktestFigures | null; sessions: readonly AnalysisSessionRow[] }) {
  const { figures, values, backtest } = input;
  const baseline = values.baseline;
  const fixedShock = baseline.ladderShock === "fixed" ? baseline.ladderShockPct / 100 : null;
  const fit = fitByDay(figures.fitDays.map(([date, price, shock]) => ({ date, price, shock })), { potDollars: values.potDollars, shares: baseline.ladderSharesPct / 100, rungs: baseline.ladderRungs, fixedShock });
  const lastYearFrom = `${Number(figures.optionLastDate.slice(0, 4)) - 1}${figures.optionLastDate.slice(4)}`;
  const largestByDay = backtest?.dailyLargestPot ?? [];
  // As the Pot size card shows it at 80%: smallest = the 80% point of the daily smallest pots from below, largest = the
  // 80% point of the daily largest pots from above; a range only when smallest ≤ largest.
  const potRange = (fromExclusive: string | null) => {
    const days = fit.filter((row) => fromExclusive === null || row.date > fromExclusive);
    const smallest = percentile(days.map((row) => row.smallestPot).sort((a, b) => a - b), 0.8);
    const sales = largestByDay.filter(([date]) => fromExclusive === null || date > fromExclusive).map(([, pot]) => pot);
    const largest = percentile([...sales].sort((a, b) => a - b), 0.2);
    return {
      days: days.length,
      lotFitsShare: round(days.filter((row) => row.lotFits).length / Math.max(1, days.length)),
      rungFitsShare: round(days.filter((row) => row.rungFits).length / Math.max(1, days.length)),
      smallestPot: round(smallest, 0),
      saleDays: sales.length,
      largestPot: round(largest, 0),
      noPotSuits: smallest !== null && largest !== null && smallest > largest,
      configuredPotInside: smallest !== null && largest !== null && values.potDollars >= smallest && values.potDollars <= largest,
    };
  };
  const grid = (view: "C" | "Pcap") =>
    Object.fromEntries(Object.entries(figures.chains.grid[view]).map(([year, ranges]) => [year, Object.fromEntries(Object.entries(ranges).map(([range, cell]) => [range, { shareOfDaysPassing: round(cell.daysWithPassing / Math.max(1, cell.days)), medianBestYield: round(cell.medianBestYield) }]))]));
  const byExcessCalmar = [...input.sessions].sort((a, b) => (b.excessCalmar ?? -Infinity) - (a.excessCalmar ?? -Infinity));
  return {
    symbol: figures.symbol,
    valuesUsed: { potDollars: values.potDollars, ladderSharesPct: baseline.ladderSharesPct, ladderRungs: baseline.ladderRungs, shock: baseline.ladderShock === "fixed" ? `fixed ${baseline.ladderShockPct}%` : `rule: Max drawdown over ${baseline.ladderShockLookbackYears} years kept in ${baseline.ladderShockMinPct}–${baseline.ladderShockMaxPct}%`, absDelta: [baseline.minAbsDelta, baseline.maxAbsDelta], dte: [baseline.minDte, baseline.maxDte], maxSpreadPctOfMid: baseline.maxSpreadPctOfMid },
    data: { optionDays: figures.dataQuality.completeDays, from: figures.dataQuality.firstDate, to: figures.dataQuality.lastDate, missingWeekdays: figures.dataQuality.missingWeekdays, daysWithoutPrice: figures.dataQuality.daysWithoutPrice, dailyBars: figures.dataQuality.bars.count, barChecks: figures.dataQuality.barChecks },
    price: { maxDrawdown: Object.fromEntries(Object.entries(figures.maxDrawdown).map(([range, value]) => [range, value && { depth: round(value.depth), peak: value.peakDate, trough: value.troughDate, recovered: value.recoveredOn }])), profileAll: figures.profile.all, profileTwoYears: figures.profile.twoYear },
    volatility: { impliedNow: round(figures.volatility.impliedNow), yangZhang21Now: round(figures.volatility.yangZhang21Now), impliedMinusWhatFollowed: { all: figures.volatility.impliedVersusRealised.all, lastYear: figures.volatility.impliedVersusRealised.lastYear } },
    shock: figures.shock,
    liquidity: { callsByYearAndDte: grid("C"), putsUnderFirstCapByYearAndDte: grid("Pcap"), lastDay: figures.chains.lastDay, spreadShareUnder25: round(figures.chains.spreadShareUnder25) },
    potSize: { lastTwelveMonths: potRange(lastYearFrom), allHistory: potRange(null), callOrdersWithoutLargestPot: backtest?.callOrdersWithoutCost ?? null },
    ordersTooLarge: backtest && { saleDays: backtest.saleDays, ordersOverOneStrike: backtest.ordersOverOneStrike, ordersPartlyUnsold: backtest.ordersPartlyUnsold, byYear: backtest.byYear },
    analysisBacktest: backtest && { name: backtest.name, from: backtest.startDate, to: backtest.endDate, cagr: round(backtest.metrics?.cagr), maxDrawdown: round(backtest.metrics?.maxDrawdown), buyAndHoldCagr: round(backtest.buyAndHoldMetrics?.cagr), buyAndHoldMaxDrawdown: round(backtest.buyAndHoldMetrics?.maxDrawdown) },
    earnings: { reports: figures.earnings.reports.length, medianAbsMoveTwoSessions: round(figures.earnings.medianAbsMove), largest: figures.earnings.largest, medianImpliedMove: round(figures.earnings.medianImpliedMove), beyondImplied: `${figures.earnings.beyondImplied} of ${figures.earnings.withImplied}`, next: figures.earnings.next },
    correlation: figures.correlation.rows.filter((row) => row.window === 252 && row.correlation !== null).sort((a, b) => b.correlation! - a.correlation!).slice(0, 6).map((row) => ({ symbol: row.symbol, correlation: round(row.correlation, 2), beta: round(row.beta, 2) })),
    backtests: byExcessCalmar.slice(0, 20).map((row) => ({ name: row.name, from: row.startDate, to: row.endDate, tickers: row.symbols.length, sharesPct: row.sharesPct, rungs: row.rungs, ladder: row.ladder, cagr: round(row.cagr), maxDrawdown: round(row.maxDrawdown), excessCalmar: round(row.excessCalmar, 2), buyAndHoldCagr: round(row.buyAndHoldCagr) })),
    backtestCount: input.sessions.length,
  };
}

export type AnalysisSummaryOutcome =
  | { status: "written"; summary: AnalysisSummary; call: ClaudeSubscriptionCallResult }
  | { status: "not_configured"; error: string }
  | { status: "usage_limit" | "failed"; error: string; call: ClaudeSubscriptionCallResult | null };

export async function writeAnalysisSummary(digest: ReturnType<typeof buildAnalysisSummaryDigest>): Promise<AnalysisSummaryOutcome> {
  const cliPath = readBacktestClaudeCliPath();
  if (cliPath === null) return { status: "not_configured", error: "BACKTEST_CLAUDE_CLI_PATH is not set in the API's .env: Claude's summary needs the Claude Code CLI." };
  const call = await callClaudeSubscriptionModel({ cliPath, workingDirectory: ensureBacktestLlmWorkingDirectory(), timeoutSeconds: summaryTimeoutSeconds, systemPrompt, userPayload: JSON.stringify(digest), jsonSchema: analysisSummaryJsonSchema });
  if (!call.ok || call.rawText === null) return { status: call.usageLimitReached ? "usage_limit" : "failed", error: call.error ?? "Claude gave no answer.", call };
  try {
    return { status: "written", summary: JSON.parse(call.rawText) as AnalysisSummary, call };
  } catch {
    return { status: "failed", error: "Claude's answer was not JSON.", call };
  }
}
