import { requireEnvironmentVariable } from "../config/env.js";
import { detectTradingModeFromAccountIds } from "./detectTradingModeFromAccountIds.js";
import type { AppEnvironment } from "./appEnvironment.js";

// Phase B work package 2: a worker may only trade against the IBKR account this
// environment expects. Pure functions (no I/O) so every rule is unit tested; the
// worker and the API guard feed them live data.

export type AccountBindingStatus = "ok" | "mismatch" | "pending";

export interface AccountBinding {
  status: AccountBindingStatus;
  reason: string;
}

/** How long after connecting Gateway may take to report its accounts before that counts as a mismatch. */
export const noAccountsReportedTimeoutSeconds = 30;

/** Exactly one account, on purpose: a multi-account (advisor/FA) setup must be designed, not tolerated by accident. */
export function readExpectedAccountId(): string {
  const value = requireEnvironmentVariable("IBKR_EXPECTED_ACCOUNT_ID").trim();
  if (value.includes(",") || /\s/.test(value)) {
    throw new Error(`IBKR_EXPECTED_ACCOUNT_ID must be exactly one IBKR account id, got: ${value}`);
  }
  return value;
}

/**
 * Configuration that can never be right, whatever Gateway says. Checked at worker
 * startup so a bad .env fails loudly instead of running unbound. Returns an error
 * message, or null when consistent.
 */
export function findStaticBindingConfigProblem(params: {
  expectedAccountId: string;
  configuredTradingMode: "paper" | "live";
  appEnvironment: AppEnvironment;
}): string | null {
  const expectedMode = detectTradingModeFromAccountIds([params.expectedAccountId]);
  if (expectedMode === "unknown") {
    return `IBKR_EXPECTED_ACCOUNT_ID ${params.expectedAccountId} is neither a paper (DU…) nor a live (U…) account id.`;
  }
  if (expectedMode !== params.configuredTradingMode) {
    return `IBKR_TRADING_MODE is ${params.configuredTradingMode} but the expected account ${params.expectedAccountId} looks ${expectedMode}.`;
  }
  if (params.appEnvironment !== "production" && expectedMode === "live") {
    return `APP_ENVIRONMENT is ${params.appEnvironment} but the expected account ${params.expectedAccountId} is a LIVE account; only production may trade live.`;
  }
  return null;
}

export function evaluateAccountBinding(params: {
  expectedAccountId: string;
  reportedAccountIds: string[];
  connected: boolean;
  secondsConnected: number | null;
  configuredTradingMode: "paper" | "live";
  appEnvironment: AppEnvironment;
}): AccountBinding {
  const configProblem = findStaticBindingConfigProblem(params);
  if (configProblem) return { status: "mismatch", reason: configProblem };

  if (!params.connected) return { status: "pending", reason: "Not connected to the IBKR Gateway." };

  if (params.reportedAccountIds.length === 0) {
    if ((params.secondsConnected ?? 0) < noAccountsReportedTimeoutSeconds) {
      return { status: "pending", reason: "Connected; waiting for the Gateway to report its accounts." };
    }
    return { status: "mismatch", reason: `The Gateway reported no accounts ${noAccountsReportedTimeoutSeconds}s after connecting (expected ${params.expectedAccountId}).` };
  }

  const onlyExpected = params.reportedAccountIds.length === 1 && params.reportedAccountIds[0] === params.expectedAccountId;
  if (!onlyExpected) {
    return { status: "mismatch", reason: `Expected account ${params.expectedAccountId}, but the Gateway reports ${params.reportedAccountIds.join(", ")}.` };
  }
  return { status: "ok", reason: `Bound to ${params.expectedAccountId}.` };
}
