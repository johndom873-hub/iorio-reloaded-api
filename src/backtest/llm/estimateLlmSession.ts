import { weekdaysBetweenInclusive } from "../jobs/backtestJobRules.js";

// What the New session screen shows before an LLM-mode session starts (docs/backtesting/FULL-FIDELITY-DESIGN.md §5):
// calls = looks per day × trading days × 1 to 2 (a forced round after an order ends can ask again). One call covers every
// symbol of the session, as live. Model time at the 2026-10-12 measurement (Sonnet 5.5, medium effort, through the CLI);
// a session's own calls cannot overlap, each decision changes the book. An upper bound: live asks only when a ticker's
// candidates changed, and the cache answers anything asked before.

export const measuredSecondsPerClaudeCall = 4.8;

export interface LlmSessionEstimate {
  tradingDays: number;
  callsLow: number;
  callsHigh: number;
  modelHoursLow: number;
  modelHoursHigh: number;
}

export function estimateLlmSession(startDate: string, endDate: string, looksPerDay: number): LlmSessionEstimate {
  const tradingDays = weekdaysBetweenInclusive(startDate, endDate);
  const callsLow = tradingDays * looksPerDay;
  const callsHigh = callsLow * 2;
  const hours = (calls: number) => Math.round(((calls * measuredSecondsPerClaudeCall) / 3600) * 10) / 10;
  return { tradingDays, callsLow, callsHigh, modelHoursLow: hours(callsLow), modelHoursHigh: hours(callsHigh) };
}
