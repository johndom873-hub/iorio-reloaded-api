import { workerHeartbeatStaleAfterSeconds } from "./tradingGate.js";
import { describeTradingHaltBlock, type TradingHalt } from "./platformControls.js";
import type { InvariantResult } from "./dataInvariants.js";
import { easternInstant } from "./marketSessionStatus.js";

// Pre-open readiness (approved 2026-10-05): "can Iorio trade when the market opens?", answered by one list of checks at
// 6:00 ET (3.5 hours to fix anything), re-checked while red, summed up at 9:20 ET, and confirmed against live option data at
// 9:35 ET. Everything here is pure: the collectors (preOpenReadinessCollectors.ts) read the world, these functions judge it,
// so every rule is unit tested. A check is "fail" when trading cannot be trusted, "warn" when a human should look but trading
// can go ahead, "ok" otherwise; the order is ready when nothing fails.

export type ReadinessStatus = "ok" | "warn" | "fail";
export type ReadinessStage = "pre_open" | "open";

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
}

const check = (name: string, status: ReadinessStatus, detail: string): ReadinessCheck => ({ name, status, detail });

// --- Configuration: the values that must be exactly right, compared to what this environment is supposed to have ---

export interface ConfigurationExpectation {
  name: string;
  /** Exact value required. */
  expected?: string;
  /** Pattern the value must match (e.g. a live account id). */
  pattern?: RegExp;
  /** Must be present and non-empty; its value is never shown. */
  secret?: boolean;
  /** Absent, empty or "false" is required (a kill-switch style flag that must stay off). */
  mustBeOff?: boolean;
}

const requiredSecrets = [
  "SESSION_SECRET",
  "FRED_API_KEY",
  "MARKETDATA_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "IBKR_FLEX_TOKEN",
  "IBKR_FLEX_QUERY_ID",
  "IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64",
  "IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64",
  "IBKR_GATEWAY_LOGIN_SSH_PRIVATE_KEY_BASE64",
  "IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64",
  "OPENROUTER_API_KEY",
  "GENOSUKE_WEBHOOK_URL",
  "GENOSUKE_WEBHOOK_SECRET",
  "DEPLOY_NOTICE_SECRET",
];

/** What production must look like (live account, every feature on). Changing one of these is a deliberate edit here, never a silent drift. */
export const productionConfigurationExpectations: ConfigurationExpectation[] = [
  { name: "APP_ENVIRONMENT", expected: "production" },
  { name: "IBKR_TRADING_MODE", expected: "live" },
  { name: "IBKR_EXPECTED_ACCOUNT_ID", pattern: /^U\d+$/ },
  { name: "IBKR_MARKET_DATA_LINES_ENABLED", expected: "true" },
  { name: "DAY_SIGNALS_LOOP_ENABLED", expected: "true" },
  { name: "EXPIRY_SETTLEMENT_MODE", expected: "apply" },
  { name: "GENOSUKE_ENABLED", expected: "true" },
  { name: "TELEGRAM_NOTIFICATIONS_DISABLED", mustBeOff: true },
  ...requiredSecrets.map((name) => ({ name, secret: true })),
];

/** Staging trades the paper account; the same features must be on. */
export const stagingConfigurationExpectations: ConfigurationExpectation[] = [
  { name: "APP_ENVIRONMENT", expected: "staging" },
  { name: "IBKR_TRADING_MODE", expected: "paper" },
  { name: "IBKR_EXPECTED_ACCOUNT_ID", pattern: /^DU\w+$/ },
  { name: "IBKR_MARKET_DATA_LINES_ENABLED", expected: "true" },
  { name: "TELEGRAM_NOTIFICATIONS_DISABLED", mustBeOff: true },
  ...requiredSecrets.map((name) => ({ name, secret: true })),
];

export function configurationExpectationsFor(appEnvironment: string): ConfigurationExpectation[] | null {
  if (appEnvironment === "production") return productionConfigurationExpectations;
  if (appEnvironment === "staging") return stagingConfigurationExpectations;
  return null;
}

export function evaluateConfiguration(environment: Record<string, string | undefined>, expectations: ConfigurationExpectation[]): ReadinessCheck {
  const problems: string[] = [];
  for (const expectation of expectations) {
    const value = environment[expectation.name]?.trim();
    if (expectation.secret) {
      if (!value) problems.push(`${expectation.name} is not set`);
    } else if (expectation.mustBeOff) {
      if (value && value.toLowerCase() !== "false") problems.push(`${expectation.name} is "${value}" (must be off)`);
    } else if (expectation.expected !== undefined) {
      if (value !== expectation.expected) problems.push(`${expectation.name} is ${value ? `"${value}"` : "not set"} (expected "${expectation.expected}")`);
    } else if (expectation.pattern) {
      if (!value || !expectation.pattern.test(value)) problems.push(`${expectation.name} is ${value ? `"${value}"` : "not set"} (not the expected kind of account id)`);
    }
  }
  return problems.length === 0
    ? check("Configuration", "ok", `${expectations.length} values checked against what this environment must have`)
    : check("Configuration", "fail", problems.join("; "));
}

// --- The trading worker on the VPS ---

export interface WorkerHealthRow {
  updatedAt: Date;
  connected: boolean | null;
  appEnvironment: string | null;
  accountBindingStatus: string | null;
  accountBindingReason: string | null;
  ibkrAccountIds: string[] | null;
  detectedTradingMode: string | null;
  configuredTradingMode: string | null;
  gitSha: string | null;
}

export function evaluateWorker(row: WorkerHealthRow | null, now: Date, expected: { appEnvironment: string; accountId: string | undefined }): ReadinessCheck {
  if (!row) return check("Trading worker", "fail", "the worker has never reported in");
  const heartbeatAgeSeconds = Math.round((now.getTime() - row.updatedAt.getTime()) / 1000);
  const problems: string[] = [];
  if (heartbeatAgeSeconds > workerHeartbeatStaleAfterSeconds) problems.push("its heartbeat is stale, so it is offline or hung");
  if (row.connected !== true) problems.push("it is not connected to the IBKR Gateway");
  if (row.appEnvironment !== expected.appEnvironment) problems.push(`it reports environment "${row.appEnvironment ?? "unknown"}", this one is "${expected.appEnvironment}"`);
  if (row.accountBindingStatus !== "ok") problems.push(`its account binding is ${row.accountBindingStatus ?? "unreported"}${row.accountBindingReason ? ` (${row.accountBindingReason})` : ""}`);
  if (row.detectedTradingMode && row.configuredTradingMode && row.detectedTradingMode !== row.configuredTradingMode) {
    problems.push(`it is configured for ${row.configuredTradingMode} but the Gateway account looks ${row.detectedTradingMode}`);
  }
  const reportedAccounts = row.ibkrAccountIds ?? [];
  if (expected.accountId && (reportedAccounts.length !== 1 || reportedAccounts[0] !== expected.accountId)) {
    problems.push(`it is bound to ${reportedAccounts.join(",") || "no account"}, expected ${expected.accountId}`);
  }
  return problems.length === 0
    ? check("Trading worker", "ok", `connected and bound to ${reportedAccounts[0]} (code ${row.gitSha ?? "unknown"})`)
    : check("Trading worker", "fail", `The trading worker: ${problems.join("; ")}`);
}

// --- The order path: IBKR's what-if for a real contract, from the web process ---

export type OrderPathProbeResult = { ok: true; probe: string } | { ok: false; reason: string };

// Verified on the paper Gateway (2026-10-05): with the Read-Only API setting on, IBKR rejects a what-if order, for options and for stock,
// with code 321 "The API interface is currently in Read-Only mode". So an answered what-if also proves the Gateway is not read-only.
const readOnlyRejection = /\b321\b|read-only/i;

export function evaluateOrderPath(result: OrderPathProbeResult): ReadinessCheck {
  if (result.ok) return check("Order path", "ok", `IBKR answered a what-if order (${result.probe}): the account, the contract lookup and the order channel work, and the Gateway is not in Read-Only mode`);
  if (readOnlyRejection.test(result.reason)) {
    return check("Order path", "fail", `the Gateway is in Read-Only API mode, so every order would be refused (${result.reason}). Turn it off in the Gateway's API settings (READ_ONLY_API) and log in again`);
  }
  return check("Order path", "fail", `IBKR refused or did not answer a what-if order: ${result.reason}`);
}

// --- The account ---

export interface AccountFigures {
  netLiquidationValue: number | null;
  totalCashValue: number | null;
  buyingPower: number | null;
  excessLiquidity: number | null;
}

function formatDollars(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export function evaluateAccount(account: AccountFigures | null, maxPositionPctOfPortfolio: number | null): ReadinessCheck {
  if (!account) return check("Account", "fail", "the IBKR account summary could not be read");
  if (account.netLiquidationValue === null || !(account.netLiquidationValue > 0)) return check("Account", "fail", "net liquidation value is missing or zero: the account is unfunded or not reporting");
  if (account.excessLiquidity !== null && account.excessLiquidity < 0) return check("Account", "fail", `excess liquidity is negative (${formatDollars(account.excessLiquidity)}): the account is in a margin shortfall`);
  const parts = [`net liquidation ${formatDollars(account.netLiquidationValue)}`];
  if (account.totalCashValue !== null) parts.push(`cash ${formatDollars(account.totalCashValue)}`);
  if (account.buyingPower !== null) parts.push(`buying power ${formatDollars(account.buyingPower)}`);
  if (maxPositionPctOfPortfolio !== null) {
    // One contract of a cash-secured put ties up strike x 100, which may not exceed the max position share of the account.
    const largestSingleContractStrike = (account.netLiquidationValue * maxPositionPctOfPortfolio) / 100 / 100;
    parts.push(`largest cash-secured put the ${maxPositionPctOfPortfolio}% position limit allows: strike $${Math.floor(largestSingleContractStrike)} (1 contract)`);
  }
  return check("Account", account.buyingPower === null || account.totalCashValue === null ? "warn" : "ok", parts.join(", "));
}

// --- The operator kill switch ---

/** A halt left on overnight is the one thing that makes the market-open answer "NOT READY" for a reason nothing in the system will fix by itself. */
export function evaluateTradingHalt(halt: TradingHalt, now: Date): ReadinessCheck {
  const blockedReason = describeTradingHaltBlock(halt, now.getTime());
  if (!blockedReason) return check("Trading halt", "ok", "trading is not halted");
  return check("Trading halt", "fail", `${blockedReason} Every order is refused until someone resumes trading (Risk & Limits, or ask Genosuke)`);
}

// --- The limits and targets (the settings you edit) ---

export interface TradingSettingsFigures {
  maxPositionPctOfPortfolio: number;
  maxConcentrationPerTickerPct: number;
  minCashReservePct: number;
  deltaTargetMin: number;
  deltaTargetMax: number;
}

export function evaluateSettings(settings: TradingSettingsFigures | null): ReadinessCheck {
  if (!settings) return check("Trading settings", "fail", "the trading settings could not be read, so every order would be blocked");
  const zeroLimits = [
    settings.maxPositionPctOfPortfolio === 0 ? "max position size" : null,
    settings.maxConcentrationPerTickerPct === 0 ? "max exposure per ticker" : null,
  ].filter((name): name is string => name !== null);
  const summary = `max position ${settings.maxPositionPctOfPortfolio}%, per ticker ${settings.maxConcentrationPerTickerPct}%, cash reserve ${settings.minCashReservePct}%, delta band ${settings.deltaTargetMin}-${settings.deltaTargetMax}`;
  if (zeroLimits.length > 0) return check("Trading settings", "warn", `${zeroLimits.join(" and ")} is 0%, which blocks every new order (${summary})`);
  return check("Trading settings", "ok", summary);
}

// --- Orders left over from before ---

export interface ActiveOrderRow {
  status: string;
  symbol: string;
  createdAt: Date;
}

export const staleUnconfirmedOrderMinutes = 15;

export function evaluateOrderHygiene(rows: ActiveOrderRow[], now: Date): ReadinessCheck {
  const inFlight = rows.filter((row) => row.status !== "pending_confirmation");
  const staleUnconfirmed = rows.filter((row) => row.status === "pending_confirmation" && now.getTime() - row.createdAt.getTime() > staleUnconfirmedOrderMinutes * 60_000);
  if (inFlight.length > 0) {
    return check("Open orders", "fail", `${inFlight.length} order(s) still in flight from before: ${[...new Set(inFlight.map((row) => `${row.symbol} ${row.status}`))].join(", ")}. They count against the limits and block closes of their positions`);
  }
  if (staleUnconfirmed.length > 0) return check("Open orders", "warn", `${staleUnconfirmed.length} built order(s) were never confirmed and are older than ${staleUnconfirmedOrderMinutes} minutes (the sweep cancels them)`);
  return check("Open orders", "ok", "no order left in flight");
}

// --- Scheduled jobs ---

export interface LatestJobRun {
  jobName: string;
  startedAt: Date | null;
  status: "running" | "success" | "failure" | null;
  errorMessage: string | null;
}

// Jobs whose output is reporting or advisory data, never an input to placing or checking an order: the Dashboard and cycle
// P&L history, the screener's candidate list, and the earnings / ex-dividend / macro warnings (whose data is checked on its
// own as warn-only invariants). A failed or missing run of one is a "look at" warning; any other job, including one not
// listed here, stays blocking, so a new job is safe by default.
export const nonGatingScheduledJobs: ReadonlySet<string> = new Set(["daily_pnl_snapshot", "daily_screener_scan", "daily_calendar_capture"]);

export function evaluateJobs(latestRuns: LatestJobRun[], dueButMissing: string[]): ReadinessCheck {
  const failedRuns = latestRuns.filter((run) => run.status === "failure");
  const describeFailedRun = (run: LatestJobRun) => `failed: ${run.jobName}${run.errorMessage ? ` (${run.errorMessage.split("\n")[0]!.slice(0, 120)})` : ""}`;
  const describeMissingRun = (jobName: string) => `not started although due: ${jobName}`;
  const neverRun = latestRuns.filter((run) => run.status === null).map((run) => run.jobName);

  const blockingProblems = [
    ...failedRuns.filter((run) => !nonGatingScheduledJobs.has(run.jobName)).map(describeFailedRun),
    ...dueButMissing.filter((jobName) => !nonGatingScheduledJobs.has(jobName)).map(describeMissingRun),
  ];
  const nonBlockingProblems = [
    ...failedRuns.filter((run) => nonGatingScheduledJobs.has(run.jobName)).map(describeFailedRun),
    ...dueButMissing.filter((jobName) => nonGatingScheduledJobs.has(jobName)).map(describeMissingRun),
  ];
  if (blockingProblems.length > 0) {
    const alsoNotBlocking = nonBlockingProblems.length > 0 ? `; not blocking: ${nonBlockingProblems.join("; ")}` : "";
    return check("Scheduled jobs", "fail", `${blockingProblems.join("; ")}${alsoNotBlocking}`);
  }
  const warnings = [...nonBlockingProblems, ...(neverRun.length > 0 ? [`never run: ${neverRun.join(", ")}`] : [])];
  if (warnings.length > 0) {
    return check("Scheduled jobs", "warn", `${warnings.join("; ")}${nonBlockingProblems.length > 0 ? " (none of these blocks trading)" : ""}`);
  }
  return check("Scheduled jobs", "ok", `latest run of each of ${latestRuns.length} jobs succeeded`);
}

export const healthCheckMaxSilenceMinutesForReadiness = 25;

export function evaluateHealthCheck(latest: { startedAt: Date; status: "running" | "success" | "failure" } | null, now: Date): ReadinessCheck {
  if (!latest) return check("Gateway health check", "fail", "the 10-minute IBKR health check has never run");
  const ageMinutes = (now.getTime() - latest.startedAt.getTime()) / 60_000;
  if (ageMinutes > healthCheckMaxSilenceMinutesForReadiness) return check("Gateway health check", "fail", `the IBKR health check has not run for over ${healthCheckMaxSilenceMinutesForReadiness} minutes`);
  if (latest.status === "failure") return check("Gateway health check", "fail", "the latest IBKR health check failed");
  return check("Gateway health check", "ok", "ran within the last 25 minutes and passed");
}

// --- Data produced by the jobs, for the previous session ---

const warnOnlyInvariantNames = new Set(["Ticker calendar (earnings, dividends)", "Economic calendar"]);

/** The data checks of the morning digest, run against the session named in each check (the previous one until today's 10:00 ET capture has finished, then today). */
export function evaluateDataChecks(invariants: InvariantResult[], dataSessionIso: string): ReadinessCheck[] {
  return invariants.map((invariant) =>
    check(`Data: ${invariant.name} (${dataSessionIso})`, invariant.ok ? "ok" : warnOnlyInvariantNames.has(invariant.name) ? "warn" : "fail", invariant.detail),
  );
}

// --- Market data ---

export interface QuoteProbe {
  symbol: string;
  bid: number | null;
  ask: number | null;
  delta: number | null;
}

export interface MarketDataFigures {
  linesEnabled: boolean;
  feedRefusal: { code: number; message: string } | null;
  stockProbe: QuoteProbe | null;
  /** Only read at the open stage, when options quote. */
  optionProbe: QuoteProbe | null;
}

const hasTwoSidedQuote = (probe: QuoteProbe | null): boolean => probe !== null && probe.bid !== null && probe.ask !== null && probe.bid > 0 && probe.ask > 0;

export function evaluateMarketData(figures: MarketDataFigures, stage: ReadinessStage): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  if (!figures.linesEnabled) checks.push(check("Market data", "fail", "real-time market data is switched off (IBKR_MARKET_DATA_LINES_ENABLED)"));
  else if (figures.feedRefusal) checks.push(check("Market data", "fail", `IBKR is refusing live prices (code ${figures.feedRefusal.code}: ${figures.feedRefusal.message})`));
  else checks.push(check("Market data", "ok", "real-time lines on, IBKR is not refusing prices"));

  const stock = figures.stockProbe;
  if (hasTwoSidedQuote(stock)) checks.push(check("Live stock quote", "ok", `${stock!.symbol} bid ${stock!.bid} / ask ${stock!.ask}`));
  else checks.push(check("Live stock quote", stage === "open" ? "fail" : "warn", `no live two-sided ${stock?.symbol ?? "stock"} quote yet${stage === "open" ? " at the open: the stock entitlements are not delivering" : " (thin before the open)"}`));

  if (stage === "open") {
    const option = figures.optionProbe;
    if (!option) checks.push(check("Live option quote", "fail", "no option contract could be probed"));
    else if (!hasTwoSidedQuote(option)) checks.push(check("Live option quote", "fail", `no live two-sided quote on the ${option.symbol} option: the option entitlements (OPRA) are not delivering`));
    else if (option.delta === null) checks.push(check("Live option quote", "fail", `the ${option.symbol} option quotes but has no live delta: the delta band cannot be checked, so opening orders would be blocked`));
    else checks.push(check("Live option quote", "ok", `${option.symbol} option bid ${option.bid} / ask ${option.ask}, delta ${option.delta.toFixed(2)}`));
  }
  return checks;
}

// --- Alerts and the database ---

export function evaluateUndeliveredAlerts(count: number): ReadinessCheck {
  return count === 0 ? check("Telegram", "ok", "no alert waiting after a failed delivery") : check("Telegram", "warn", `${count} earlier alert(s) could not be delivered to Telegram`);
}

export const databaseWarnPercent = 85;

export function evaluateDatabase(figures: { totalConnections: number; maxConnections: number; sizeBytes: number; maxSizeBytes: number | null } | null): ReadinessCheck {
  if (!figures) return check("Database", "fail", "the database health could not be read");
  const connectionPercent = (figures.totalConnections / figures.maxConnections) * 100;
  const sizePercent = figures.maxSizeBytes ? (figures.sizeBytes / figures.maxSizeBytes) * 100 : null;
  const problems: string[] = [];
  if (connectionPercent > databaseWarnPercent) problems.push(`${Math.round(connectionPercent)}% of its connections are in use`);
  if (sizePercent !== null && sizePercent > databaseWarnPercent) problems.push(`${Math.round(sizePercent)}% of its storage is used`);
  return problems.length > 0
    ? check("Database", "warn", problems.join("; "))
    : check("Database", "ok", `${figures.totalConnections}/${figures.maxConnections} connections${sizePercent !== null ? `, ${Math.round(sizePercent)}% of storage` : ""}`);
}

// --- Verdict and message ---

export interface ReadinessVerdict {
  ready: boolean;
  failing: ReadinessCheck[];
  warnings: ReadinessCheck[];
  passing: ReadinessCheck[];
  /** Stable text naming the failing checks only, so a re-check announces itself only when the set of problems changes. */
  signature: string;
}

export function summarizeReadiness(checks: ReadinessCheck[]): ReadinessVerdict {
  const failing = checks.filter((entry) => entry.status === "fail");
  return {
    ready: failing.length === 0,
    failing,
    warnings: checks.filter((entry) => entry.status === "warn"),
    passing: checks.filter((entry) => entry.status === "ok"),
    signature: failing.map((entry) => entry.name).sort().join("|"),
  };
}

export type ReadinessMessageKind = "first" | "changed" | "final" | "open";

const headlines: Record<ReadinessMessageKind, { ready: string; notReady: string }> = {
  first: { ready: "✅ Pre-open check: READY to trade", notReady: "🚫 Pre-open check: NOT READY" },
  changed: { ready: "✅ Pre-open check: now READY to trade", notReady: "🚫 Pre-open check: still NOT READY" },
  final: { ready: "✅ FINAL pre-open check: GO", notReady: "🛑 FINAL pre-open check: NO-GO" },
  open: { ready: "✅ Market-open confirmation: live data is flowing, GO", notReady: "🛑 Market-open confirmation: NOT READY" },
};

export function buildReadinessMessage(input: { kind: ReadinessMessageKind; dateIso: string; environment: string; verdict: ReadinessVerdict }): string {
  const { verdict } = input;
  const headline = headlines[input.kind];
  const lines = [`${verdict.ready ? headline.ready : headline.notReady} — ${input.environment} ${input.dateIso}`];
  if (verdict.failing.length > 0) lines.push("", "Problems", ...verdict.failing.map((entry) => `❌ ${entry.name}: ${entry.detail}`));
  if (verdict.warnings.length > 0) lines.push("", "Look at", ...verdict.warnings.map((entry) => `⚠️ ${entry.name}: ${entry.detail}`));
  if (verdict.passing.length > 0) lines.push("", "Fine", ...verdict.passing.map((entry) => `✅ ${entry.name}: ${entry.detail}`));
  if (!verdict.ready) lines.push("", "If the Gateway needs a phone approval, reply to this message and Genosuke can send the 2FA push.");
  return lines.join("\n");
}

// --- When each stage runs ---

export const readinessSchedule = {
  preOpenStart: { hour: 6, minute: 0 },
  finalCheck: { hour: 9, minute: 20 },
  openConfirmationStart: { hour: 9, minute: 35 },
  openConfirmationEnd: { hour: 10, minute: 15 },
  preOpenRecheckMinutes: 10,
  openRecheckMinutes: 2,
} as const;

export interface ReadinessState {
  preOpenLastRunAtMs: number | null;
  /** Signature of the last pre-open run ("" when it was green). */
  preOpenSignature: string | null;
  finalSent: boolean;
  openLastRunAtMs: number | null;
  openSignature: string | null;
}

export const emptyReadinessState: ReadinessState = { preOpenLastRunAtMs: null, preOpenSignature: null, finalSent: false, openLastRunAtMs: null, openSignature: null };

export type ReadinessAction =
  | { kind: "pre_open"; announce: "always" | "on_change" }
  | { kind: "final" }
  | { kind: "open"; announce: "always" | "on_change" };

/**
 * Pure: what the monitor should do this minute on an open day. Pre-open: first run at 6:00 ET (announced), then every 10 minutes
 * while red (announced only when the set of problems changes) until 9:20. At 9:20 one FINAL verdict (always announced). From 9:35
 * the live-data confirmation, re-checked every 2 minutes while red until 10:15. Every stage is also a catch-up, so a restart in
 * the middle of the morning loses nothing.
 */
export function decideReadinessActions(now: Date, dateIso: string, state: ReadinessState): ReadinessAction[] {
  const at = (time: { hour: number; minute: number }) => easternInstant(dateIso, time.hour, time.minute);
  const actions: ReadinessAction[] = [];
  if (now < at(readinessSchedule.preOpenStart)) return actions;

  const minutesSince = (lastRunAtMs: number) => (now.getTime() - lastRunAtMs) / 60_000;

  if (now < at(readinessSchedule.finalCheck)) {
    if (state.preOpenLastRunAtMs === null) actions.push({ kind: "pre_open", announce: "always" });
    else if (state.preOpenSignature !== "" && minutesSince(state.preOpenLastRunAtMs) >= readinessSchedule.preOpenRecheckMinutes) actions.push({ kind: "pre_open", announce: "on_change" });
    return actions;
  }

  if (!state.finalSent && now < at(readinessSchedule.openConfirmationEnd)) actions.push({ kind: "final" });

  if (now >= at(readinessSchedule.openConfirmationStart) && now < at(readinessSchedule.openConfirmationEnd)) {
    if (state.openLastRunAtMs === null) actions.push({ kind: "open", announce: "always" });
    else if (state.openSignature !== "" && minutesSince(state.openLastRunAtMs) >= readinessSchedule.openRecheckMinutes) actions.push({ kind: "open", announce: "on_change" });
  }
  return actions;
}
