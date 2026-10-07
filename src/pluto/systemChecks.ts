import { db } from "../db/connection.js";
import { reconciliationRunFailedPrefix } from "../ibkr/checkIbkrHealthJob.js";
import { fetchPlutoAccountSummary } from "./accountSummaryCache.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { computeMarketSessionStatus, easternInstant, type MarketSessionState } from "../lib/marketSessionStatus.js";
import { fetchTradingHalt } from "../lib/platformControls.js";
import { classifyTradingStatus } from "../lib/tradingGate.js";
import { countTrailingModelFailures, loadPlutoTodayCounters, type PlutoTodayCounters } from "./counters.js";
import type { PlutoSystemCheck } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";
import { resolvePlutoSession, type PlutoSession } from "./sessionSchedule.js";
import { describePlutoBlock, loadPlutoState, type PlutoState } from "./stateStore.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Pre-model system gates (design round 3, item 19, approved 2026-09-28). Every check runs and is
// recorded on the pass row, so the screen shows the whole board, not just the first failure;
// any failure means no model call. Fail closed: a check that cannot be evaluated fails.

/**
 * The health-check job runs at :10, :20, :40 and :50 (it skips the :00/:30 Scheduler slots), so
 * gaps are already up to 20 minutes: 35 tolerates one missed run and fails on two (Marcelo 2026-09-29).
 */
export const reconciliationMaxAgeMinutes = 35;

export interface PlutoSystemCheckContext {
  state: PlutoState;
  marketState: MarketSessionState;
  netLiquidationValue: number | null;
  totalCashValue: number | null;
  counters: PlutoTodayCounters;
  todayEasternIso: string;
  session: PlutoSession;
}

export interface PlutoSystemChecksResult {
  ok: boolean;
  checks: Record<string, PlutoSystemCheck>;
  failures: string[];
  context: PlutoSystemCheckContext;
}

function minutesOfDay(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/** Pure: is `now` inside [windowStart, windowEnd) on Eastern clock time. */
export function isInsideTradingWindow(now: Date, todayEasternIso: string, windowStartEt: string, windowEndEt: string): boolean {
  const start = easternInstant(todayEasternIso, Math.floor(minutesOfDay(windowStartEt) / 60), minutesOfDay(windowStartEt) % 60).getTime();
  const end = easternInstant(todayEasternIso, Math.floor(minutesOfDay(windowEndEt) / 60), minutesOfDay(windowEndEt) % 60).getTime();
  return now.getTime() >= start && now.getTime() < end;
}

export interface HealthCheckRunForReconciliation {
  started_at: Date | string;
  details: { reconciliationProblems?: unknown } | null;
}

/**
 * Pure: the reconciliation check from the newest *successful* health-check run. A running or
 * failed run carries no reconciliation result, so it must never count as "IBKR and the book agree".
 * The "discrepancy" detail prefix is what trips the reconciliation breaker in the pass runner; a
 * reconciliation that could not run only fails the check (Marcelo 2026-09-29) and lifts on the next good run.
 */
export function evaluateReconciliationCheck(latestSuccessfulRun: HealthCheckRunForReconciliation | undefined, now: Date): PlutoSystemCheck {
  if (!latestSuccessfulRun) return { ok: false, detail: "no successful health-check run recorded" };
  const ageMinutes = (now.getTime() - new Date(latestSuccessfulRun.started_at).getTime()) / 60_000;
  if (ageMinutes > reconciliationMaxAgeMinutes) return { ok: false, detail: `last successful health check ${Math.round(ageMinutes)} min ago (limit ${reconciliationMaxAgeMinutes})` };
  const problems = latestSuccessfulRun.details?.reconciliationProblems;
  if (!Array.isArray(problems)) return { ok: false, detail: "the last successful health check recorded no reconciliation result" };
  const discrepancies = problems.map(String).filter((problem) => !problem.startsWith(reconciliationRunFailedPrefix));
  if (discrepancies.length > 0) return { ok: false, detail: `discrepancy: ${discrepancies.join("; ")}` };
  if (problems.length > 0) return { ok: false, detail: `reconciliation did not run: ${problems.map(String).join("; ")}` };
  return { ok: true, detail: `IBKR and the book agree (checked ${Math.round(ageMinutes)} min ago)` };
}

/** Pure: the daily-loss breaker input — today's move against last night's net liquidation value. */
export function dailyLossPercent(netLiquidationValue: number | null, previousNetLiquidationValue: number | null): number | null {
  if (netLiquidationValue === null || previousNetLiquidationValue === null || !(previousNetLiquidationValue > 0)) return null;
  return ((netLiquidationValue - previousNetLiquidationValue) / previousNetLiquidationValue) * 100;
}

export async function runPlutoSystemChecks(settings: PlutoSettings, now: Date = new Date()): Promise<PlutoSystemChecksResult> {
  const todayEasternIso = easternIsoDate(now);
  const checks: Record<string, PlutoSystemCheck> = {};
  const record = (name: string, ok: boolean, detail: string) => {
    checks[name] = { ok, detail };
  };

  const state = await loadPlutoState();
  const stateBlock = describePlutoBlock(state);
  record("pluto_state", stateBlock === null, stateBlock ?? "on, not paused, no breaker tripped");

  try {
    const halt = await fetchTradingHalt();
    record("trading_halt", !halt.enabled, halt.enabled ? `trading halted${halt.setByDisplayName ? ` by ${halt.setByDisplayName}` : ""}${halt.reason ? `: ${halt.reason}` : ""}` : "not halted");
  } catch (error) {
    record("trading_halt", false, `could not read the halt switch: ${error instanceof Error ? error.message : String(error)}`);
  }

  let marketState: MarketSessionState = "closed";
  try {
    marketState = (await computeMarketSessionStatus(now)).state;
    record("market_session", marketState === "open", `regular session is ${marketState}`);
  } catch (error) {
    record("market_session", false, `could not resolve the session: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The close must be known from IBKR's liquid hours (or the fallback list on a known half day):
  // assuming 16:00 on an unread day is how orders get stranded into a 13:00 close.
  const session = await resolvePlutoSession(now, settings);
  const closeKnown = session.closeSource !== "regular" || session.closeReadAt !== null;
  record("session_close", closeKnown, `closes ${session.closeTimeEt} ET (${session.closeSource === "ibkr_liquid_hours" ? "IBKR liquid hours" : session.closeSource === "fallback_list" ? "fallback list, IBKR not read yet" : "assumed regular, IBKR not read yet"})`);
  const inWindow = isInsideTradingWindow(now, todayEasternIso, session.windowStartEt, session.windowEndEt);
  record("trading_window", inWindow, `${inWindow ? "inside" : "outside"} ${session.windowStartEt}–${session.windowEndEt} ET${session.windowEndEt !== settings.windowEndEt ? ` (configured end ${settings.windowEndEt}, pulled in by the ${session.closeTimeEt} close)` : ""}`);

  try {
    const workerRow = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first();
    const trading = classifyTradingStatus(workerRow, readAppEnvironment(), now.getTime());
    record("trading_worker", trading.state === "ok", trading.reason ?? "worker bound and fresh");
  } catch (error) {
    record("trading_worker", false, `could not read worker health: ${error instanceof Error ? error.message : String(error)}`);
  }

  let netLiquidationValue: number | null = null;
  let totalCashValue: number | null = null;
  try {
    const account = await fetchPlutoAccountSummary();
    netLiquidationValue = account.netLiquidationValue;
    totalCashValue = account.totalCashValue;
    record("account_data", netLiquidationValue !== null && netLiquidationValue > 0, netLiquidationValue !== null ? `NLV ${netLiquidationValue.toFixed(0)}` : "net liquidation value unavailable");
  } catch (error) {
    record("account_data", false, `account summary failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const previous = await db("account_pnl_snapshots").where("snapshot_date", "<", todayEasternIso).orderBy("snapshot_date", "desc").first("net_liquidation_value", db.raw(`snapshot_date::text as snapshot_date_iso`));
    const lossPct = dailyLossPercent(netLiquidationValue, previous ? Number(previous.net_liquidation_value) : null);
    if (lossPct === null) record("daily_loss", false, "cannot compute today's move: no previous snapshot or no live NLV");
    else record("daily_loss", lossPct > -settings.dailyLossBreakerPct, `${lossPct >= 0 ? "+" : ""}${lossPct.toFixed(2)}% vs ${previous?.snapshot_date_iso} close (breaker at -${settings.dailyLossBreakerPct}%)`);
  } catch (error) {
    record("daily_loss", false, `could not read the P&L snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  const counters = await loadPlutoTodayCounters(now);
  record("cost_ceiling", counters.costTodayUsd < settings.dailyCostCeilingUsd, `$${counters.costTodayUsd.toFixed(3)} of $${settings.dailyCostCeilingUsd} today`);
  record("actions_cap", counters.actionsToday < settings.maxActionsPerSession, `${counters.actionsToday} of ${settings.maxActionsPerSession} actions today`);
  // Position reconciliation: the health-check job compares IBKR's holdings with the book and
  // stores what it found in job_runs.details.reconciliationProblems.
  try {
    const latestSuccessfulRun = await db("job_runs").where({ job_name: "ibkr_health_check", status: "success" }).orderBy("started_at", "desc").first("started_at", "details");
    const reconciliation = evaluateReconciliationCheck(latestSuccessfulRun, now);
    record("reconciliation", reconciliation.ok, reconciliation.detail);
  } catch (error) {
    record("reconciliation", false, `could not read the health check: ${error instanceof Error ? error.message : String(error)}`);
  }

  const trailingFailures = await countTrailingModelFailures(now);
  record("model_failures", trailingFailures < settings.consecutiveModelFailuresBreaker, `${trailingFailures} consecutive model failure(s), breaker at ${settings.consecutiveModelFailuresBreaker}`);

  const failures = Object.entries(checks).filter(([, check]) => !check.ok).map(([name, check]) => `${name}: ${check.detail}`);
  return { ok: failures.length === 0, checks, failures, context: { state, marketState, netLiquidationValue, totalCashValue, counters, todayEasternIso, session } };
}
