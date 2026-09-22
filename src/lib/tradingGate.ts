import { db } from "../db/connection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { formatDurationHuman } from "./formatDurationHuman.js";

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

export type TradingState = "ok" | "blocked" | "offline";

export interface TradingStatus {
  state: TradingState;
  /** Why trading is not ok; null when ok. */
  reason: string | null;
}

/** "offline" = no fresh heartbeat (never reported, or stale); "blocked" = the worker is there but not allowed to trade. */
export function classifyTradingStatus(row: WorkerHealthForTradingGate | undefined, apiEnvironment: string, nowMs: number = Date.now()): TradingStatus {
  if (!row) return { state: "offline", reason: "Trading is blocked: the trading worker has never reported in." };
  const secondsSinceHeartbeat = Math.round((nowMs - new Date(row.updated_at).getTime()) / 1000);
  if (secondsSinceHeartbeat > workerHeartbeatStaleAfterSeconds) {
    return { state: "offline", reason: `Trading is blocked: the trading worker is offline (last heartbeat ${formatDurationHuman(secondsSinceHeartbeat * 1000)} ago).` };
  }
  if (row.app_environment !== apiEnvironment) {
    return { state: "blocked", reason: `Trading is blocked: the worker reports environment "${row.app_environment ?? "unknown"}" but this API is "${apiEnvironment}".` };
  }
  if (row.account_binding_status === null) {
    return { state: "blocked", reason: "Trading is blocked: the worker has not reported its IBKR account binding (it needs the latest version)." };
  }
  if (row.account_binding_status !== "ok") {
    return { state: "blocked", reason: `Trading is blocked: ${row.account_binding_reason ?? `account binding is ${row.account_binding_status}`}` };
  }
  return { state: "ok", reason: null };
}

export function findTradingBlockedReason(row: WorkerHealthForTradingGate | undefined, apiEnvironment: string, nowMs: number = Date.now()): string | null {
  return classifyTradingStatus(row, apiEnvironment, nowMs).reason;
}

export async function fetchTradingBlockedReason(): Promise<string | null> {
  const row = await db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first();
  return findTradingBlockedReason(row, readAppEnvironment());
}
