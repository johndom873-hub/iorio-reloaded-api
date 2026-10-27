import { db } from "../db/connection.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { computeMarketSessionStatus } from "./marketSessionStatus.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// Liveness of the market quote loop (2026-10-27, replacing the Day Signals loop's), checked by the 10-minute IBKR
// health-check job. The loop heartbeats into worker_health as "market_quote_loop" every minute whatever its state
// (marketQuoteLoop.ts), and is legitimately idle whenever nothing needs quotes, so the only failure is a stale
// heartbeat: the loop (or the web dyno) died. Only checked while the market is open and the loop is enabled in this
// environment. State-based alerting (throttledAlert.ts): one message when it goes down, hourly reminders, one when it recovers.

export const marketQuoteLoopHeartbeatStaleAfterMs = 5 * 60_000;
const downAlertKey = "market_quote_loop_down";
const downReminderIntervalMs = 60 * 60_000;

export interface MarketQuoteLoopLivenessInput {
  now: Date;
  marketOpen: boolean;
  loopEnabled: boolean;
  heartbeatUpdatedAt: Date | null;
}

/** Pure: the problem to report, or null when the loop is fine or not expected to run right now. */
export function evaluateMarketQuoteLoopLiveness(input: MarketQuoteLoopLivenessInput): string | null {
  if (!input.marketOpen || !input.loopEnabled) return null;
  if (input.heartbeatUpdatedAt === null) return "The market quote loop has never reported a heartbeat although the market is open (is the web dyno running?).";
  const ageMs = input.now.getTime() - input.heartbeatUpdatedAt.getTime();
  if (ageMs > marketQuoteLoopHeartbeatStaleAfterMs) return `The market quote loop's heartbeat is over ${marketQuoteLoopHeartbeatStaleAfterMs / 60_000} min old: the loop is not running, so the CC + Put Ladder, the assignment-risk alert and the Volatility screen get no live quotes.`;
  return null;
}

/** Runs the check against worker_health and sends/clears the throttled alert. Returns the problem text, if any. */
export async function reportMarketQuoteLoopLiveness(now: Date = new Date()): Promise<string | null> {
  const [session, heartbeatRow] = await Promise.all([computeMarketSessionStatus(now), db("worker_health").where({ process_name: "market_quote_loop" }).first("updated_at")]);
  const problem = evaluateMarketQuoteLoopLiveness({
    now,
    marketOpen: session.state === "open",
    loopEnabled: process.env.MARKET_QUOTE_LOOP_ENABLED === "true",
    heartbeatUpdatedAt: heartbeatRow ? new Date(heartbeatRow.updated_at) : null,
  });
  if (problem) {
    await notifyDownThrottled(downAlertKey, `⚠️ ${problem}`, downReminderIntervalMs);
  } else {
    const downForMs = await clearDownState(downAlertKey);
    if (downForMs !== null) await notifyTelegram(`✅ The market quote loop is running again (was down ~${formatDurationHuman(downForMs)}).`);
  }
  return problem;
}
