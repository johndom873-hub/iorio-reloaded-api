import { db } from "../db/connection.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { computeMarketSessionStatus, easternDateIso, easternInstant, type MarketSessionState } from "../lib/marketSessionStatus.js";
import { fetchTradingHalt } from "../lib/platformControls.js";
import { classifyTradingStatus } from "../lib/tradingGate.js";
import { countTrailingModelFailures, loadPlutoTodayCounters, type PlutoTodayCounters } from "./counters.js";
import type { PlutoSystemCheck } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";
import { describePlutoBlock, loadPlutoState, type PlutoState } from "./stateStore.js";

// Pre-model system gates (design round 3, item 19, approved 2026-09-28). Every check runs and is
// recorded on the pass row, so the screen shows the whole board, not just the first failure;
// any failure means no model call. Fail closed: a check that cannot be evaluated fails.

// NYSE early closes (13:00 ET). No half-day handling exists in the market calendar yet, so the
// agent carries the list (kept short: this year's and next year's known dates) and skips those days
// entirely, per design round 3 item 49.
export const earlyCloseDatesIso = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2027-12-23"]);

export interface PlutoSystemCheckContext {
  state: PlutoState;
  marketState: MarketSessionState;
  netLiquidationValue: number | null;
  totalCashValue: number | null;
  counters: PlutoTodayCounters;
  todayEasternIso: string;
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

/** Pure: the daily-loss breaker input — today's move against last night's net liquidation value. */
export function dailyLossPercent(netLiquidationValue: number | null, previousNetLiquidationValue: number | null): number | null {
  if (netLiquidationValue === null || previousNetLiquidationValue === null || !(previousNetLiquidationValue > 0)) return null;
  return ((netLiquidationValue - previousNetLiquidationValue) / previousNetLiquidationValue) * 100;
}

export async function runPlutoSystemChecks(settings: PlutoSettings, now: Date = new Date()): Promise<PlutoSystemChecksResult> {
  const todayEasternIso = easternDateIso(now);
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
  record("early_close_day", !earlyCloseDatesIso.has(todayEasternIso), earlyCloseDatesIso.has(todayEasternIso) ? `${todayEasternIso} is an early-close day` : "full session");
  const inWindow = isInsideTradingWindow(now, todayEasternIso, settings.windowStartEt, settings.windowEndEt);
  record("trading_window", inWindow, `${inWindow ? "inside" : "outside"} ${settings.windowStartEt}–${settings.windowEndEt} ET`);

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
    const account = await fetchAccountSummary();
    netLiquidationValue = account.netLiquidationValue;
    totalCashValue = account.totalCashValue;
    record("account_data", netLiquidationValue !== null && netLiquidationValue > 0, netLiquidationValue !== null ? `NLV ${netLiquidationValue.toFixed(0)}` : "net liquidation value unavailable");
  } catch (error) {
    record("account_data", false, `account summary failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const previous = await db("account_pnl_snapshots").where("snapshot_date", "<", todayEasternIso).orderBy("snapshot_date", "desc").first("net_liquidation_value", "snapshot_date");
    const lossPct = dailyLossPercent(netLiquidationValue, previous ? Number(previous.net_liquidation_value) : null);
    if (lossPct === null) record("daily_loss", false, "cannot compute today's move: no previous snapshot or no live NLV");
    else record("daily_loss", lossPct > -settings.dailyLossBreakerPct, `${lossPct >= 0 ? "+" : ""}${lossPct.toFixed(2)}% vs ${previous?.snapshot_date} close (breaker at -${settings.dailyLossBreakerPct}%)`);
  } catch (error) {
    record("daily_loss", false, `could not read the P&L snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  const counters = await loadPlutoTodayCounters(now);
  record("cost_ceiling", counters.costTodayUsd < settings.dailyCostCeilingUsd, `$${counters.costTodayUsd.toFixed(3)} of $${settings.dailyCostCeilingUsd} today`);
  record("model_calls_cap", counters.modelCallsToday < settings.maxModelCallsPerSession, `${counters.modelCallsToday} of ${settings.maxModelCallsPerSession} calls today`);
  record("actions_cap", counters.actionsToday < settings.maxActionsPerSession, `${counters.actionsToday} of ${settings.maxActionsPerSession} actions today`);
  const trailingFailures = await countTrailingModelFailures(now);
  record("model_failures", trailingFailures < settings.consecutiveModelFailuresBreaker, `${trailingFailures} consecutive model failure(s), breaker at ${settings.consecutiveModelFailuresBreaker}`);

  const failures = Object.entries(checks).filter(([, check]) => !check.ok).map(([name, check]) => `${name}: ${check.detail}`);
  return { ok: failures.length === 0, checks, failures, context: { state, marketState, netLiquidationValue, totalCashValue, counters, todayEasternIso } };
}
