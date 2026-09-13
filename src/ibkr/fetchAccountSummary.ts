import { EventName, type IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { dedupeInFlight } from "../lib/dedupeInFlight.js";

export interface AccountSummary {
  netLiquidationValue: number | null;
  buyingPower: number | null;
  totalCashValue: number | null;
  grossPositionValue: number | null;
  // Added for Iorio Pulse's IBKR node ("Margin excess") — IBKR's own
  // "excess liquidity" figure, additive to the existing tags so every
  // existing caller (dashboard.ts, riskLimits.ts) is unaffected.
  excessLiquidity: number | null;
}

const requestedTags = "NetLiquidation,BuyingPower,TotalCashValue,GrossPositionValue,ExcessLiquidity";

function requestAccountSummary(ib: IBApi, reqId: number): Promise<AccountSummary> {
  return new Promise<AccountSummary>((resolve, reject) => {
    const summary: AccountSummary = {
      netLiquidationValue: null,
      buyingPower: null,
      totalCashValue: null,
      grossPositionValue: null,
      excessLiquidity: null,
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Account summary timeout."));
    }, 15_000);

    function onAccountSummary(id: number, _account: string, tag: string, value: string) {
      if (id !== reqId) return;
      const numericValue = Number(value);
      if (Number.isNaN(numericValue)) return;
      if (tag === "NetLiquidation") summary.netLiquidationValue = numericValue;
      if (tag === "BuyingPower") summary.buyingPower = numericValue;
      if (tag === "TotalCashValue") summary.totalCashValue = numericValue;
      if (tag === "GrossPositionValue") summary.grossPositionValue = numericValue;
      if (tag === "ExcessLiquidity") summary.excessLiquidity = numericValue;
    }

    function onAccountSummaryEnd(id: number) {
      if (id !== reqId) return;
      cleanup();
      resolve(summary);
    }

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.accountSummary, onAccountSummary);
      ib.removeListener(EventName.accountSummaryEnd, onAccountSummaryEnd);
    }

    // .on(), not .once() — see project_eventemitter_once_concurrent_listeners
    // memory. On the shared connection (sharedReadConnection.ts), multiple
    // concurrent fetchAccountSummary() calls register their own
    // onAccountSummaryEnd on the same IBApi instance. A .once() listener
    // self-removes on the *next* emission of accountSummaryEnd regardless of
    // which reqId it carries — so one call's real completion silently
    // unregisters every other in-flight call's listener before its own
    // accountSummaryEnd ever arrives, hanging it until the 15s timeout. Real
    // bug hit 2026-09-09: Dashboard fires /available-cash and /portfolio
    // concurrently, both call this — the second one timed out and rendered
    // "–" instead of a real number. cleanup() below still removes this
    // listener explicitly once *this* call's own reqId actually completes.
    ib.on(EventName.accountSummary, onAccountSummary);
    ib.on(EventName.accountSummaryEnd, onAccountSummaryEnd);
    ib.reqAccountSummary(reqId, "All", requestedTags);
  });
}

/**
 * Tries the shared read connection first (sharedReadConnection.ts — reused
 * across requests, no per-call connect cost) and only falls back to the
 * one-shot connect/fetch/disconnect pattern below when the shared connection
 * itself isn't available. A failure *during* the account summary request
 * (e.g. a timeout) is not treated as a reason to fall back and retry — it
 * propagates normally, same as before this change.
 *
 * Deduplicated (see dedupeInFlight.ts) — /dashboard/portfolio and
 * /risk-limits/exposure both call this with no arguments, and load together
 * on the Dashboard.
 */
export const fetchAccountSummary = dedupeInFlight(fetchAccountSummaryUncached);

async function fetchAccountSummaryUncached(): Promise<AccountSummary> {
  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `fetchAccountSummary: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }

  if (borrowed) {
    const { ib, release } = borrowed;
    const reqId = sharedReadConnection.allocateReqId();
    try {
      return await requestAccountSummary(ib, reqId);
    } finally {
      ib.cancelAccountSummary(reqId);
      release();
    }
  }

  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  const reqId = 9001;
  try {
    return await requestAccountSummary(ib, reqId);
  } finally {
    ib.cancelAccountSummary(reqId);
    connection.disconnect();
  }
}
