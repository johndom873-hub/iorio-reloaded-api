import { db } from "../db/connection.js";
import { readAppEnvironment } from "./appEnvironment.js";

// API-side half of the account-binding gate (Phase B work package 2): refuse to confirm an
// order (409, instant feedback in the UI and Genosuke) unless the trading worker has recently
// reported, for THIS environment, that it is bound to the expected IBKR account. Fail closed:
// no row, a stale heartbeat, or a worker that predates the binding columns all block.

/** The worker upserts worker_health every 45 s; two missed beats plus slack. */
export const workerHeartbeatStaleAfterSeconds = 120;

export interface WorkerHealthForTradingGate {
  updated_at: Date | string;
  app_environment: string | null;
  account_binding_status: string | null;
  account_binding_reason: string | null;
}

export function findTradingBlockedReason(row: WorkerHealthForTradingGate | undefined, apiEnvironment: string, nowMs: number = Date.now()): string | null {
  if (!row) return "Trading is blocked: the trading worker has never reported in.";
  const secondsSinceHeartbeat = Math.round((nowMs - new Date(row.updated_at).getTime()) / 1000);
  if (secondsSinceHeartbeat > workerHeartbeatStaleAfterSeconds) {
    return `Trading is blocked: the trading worker is offline (last heartbeat ${secondsSinceHeartbeat}s ago).`;
  }
  if (row.app_environment !== apiEnvironment) {
    return `Trading is blocked: the worker reports environment "${row.app_environment ?? "unknown"}" but this API is "${apiEnvironment}".`;
  }
  if (row.account_binding_status === null) {
    return "Trading is blocked: the worker has not reported its IBKR account binding (it needs the latest version).";
  }
  if (row.account_binding_status !== "ok") {
    return `Trading is blocked: ${row.account_binding_reason ?? `account binding is ${row.account_binding_status}`}`;
  }
  return null;
}

export async function fetchTradingBlockedReason(): Promise<string | null> {
  const row = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first();
  return findTradingBlockedReason(row, readAppEnvironment());
}
