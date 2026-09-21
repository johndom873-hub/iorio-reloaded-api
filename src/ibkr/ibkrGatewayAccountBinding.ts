import { environment } from "../config/env.js";
import { evaluateAccountBinding, findStaticBindingConfigProblem, readExpectedAccountId, type AccountBinding } from "../lib/accountBinding.js";
import { readAppEnvironment, type AppEnvironment } from "../lib/appEnvironment.js";
import { clearDownState, notifyDownThrottled } from "../lib/throttledAlert.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { persistentIbkrConnection } from "./ibkrGatewayPersistentConnection.js";

// Runs on the VPS worker (hence the ibkrGateway* name). Phase B work package 2: the worker may only
// trade against the IBKR account this environment expects. The rules live in lib/accountBinding.ts;
// this file feeds them live Gateway data, and alerts (state-based) when the binding breaks.

const bindingAlertKey = "account_binding_mismatch";
const reminderIntervalMs = 30 * 60_000;
const watchIntervalMs = 10_000;

let expectedAccountId: string | null = null;
let appEnvironment: AppEnvironment | null = null;
let lastLoggedStatus: string | null = null;

/** Call first thing at worker startup: a missing or contradictory setting must stop the process, not run unbound. */
export function initializeAccountBinding(): void {
  const accountId = readExpectedAccountId();
  const environmentName = readAppEnvironment();
  const problem = findStaticBindingConfigProblem({ expectedAccountId: accountId, configuredTradingMode: environment.ibkrTradingMode, appEnvironment: environmentName });
  if (problem) throw new Error(`Account binding misconfigured: ${problem}`);
  expectedAccountId = accountId;
  appEnvironment = environmentName;
  console.log(`Account binding: expecting IBKR account ${accountId} (${environment.ibkrTradingMode}, ${environmentName}).`);
}

export function getExpectedAccountId(): string {
  if (!expectedAccountId) throw new Error("initializeAccountBinding() was not called.");
  return expectedAccountId;
}

/** Evaluated fresh from the live connection every call, so a gate never acts on a stale answer. */
export function getCurrentAccountBinding(): AccountBinding {
  if (!expectedAccountId || !appEnvironment) return { status: "pending", reason: "Account binding not initialised yet." };
  const health = persistentIbkrConnection.getHealthSnapshot();
  return evaluateAccountBinding({
    expectedAccountId,
    reportedAccountIds: health.managedAccountIds,
    connected: health.connected,
    secondsConnected: health.uptimeMs === null ? null : Math.floor(health.uptimeMs / 1000),
    configuredTradingMode: environment.ibkrTradingMode,
    appEnvironment,
  });
}

async function checkBindingAndAlert(): Promise<void> {
  const binding = getCurrentAccountBinding();
  if (binding.status !== lastLoggedStatus) {
    console.log(`Account binding: ${lastLoggedStatus ?? "start"} -> ${binding.status} — ${binding.reason}`);
    lastLoggedStatus = binding.status;
  }
  if (binding.status === "mismatch") {
    await notifyDownThrottled(
      bindingAlertKey,
      `🛑 IBKR account binding MISMATCH (${appEnvironment}): ${binding.reason}\nNew orders and position sync are paused; cancels still work.`,
      reminderIntervalMs,
    );
    return;
  }
  if (binding.status === "ok") {
    const downMs = await clearDownState(bindingAlertKey);
    if (downMs !== null) {
      await notifyTelegram(`✅ IBKR account binding restored (${appEnvironment}) after ${Math.max(1, Math.round(downMs / 60_000))} min: ${binding.reason}`);
    }
  }
}

export function startAccountBindingWatch(): void {
  setInterval(() => {
    checkBindingAndAlert().catch((error) => console.error(`Account binding check failed: ${error instanceof Error ? error.message : error}`));
  }, watchIntervalMs);
}
