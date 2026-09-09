import { EventName } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";

const executionReplayReqId = 90210; // Fixed, distinct from any real order id (those come from nextValidId and stay low) — only this one call ever uses it, so no collision risk.
const replayTimeoutMs = 15_000;
const lookbackHours = 6; // Comfortably covers any realistic worker outage (restarts observed have been minutes, not hours) without replaying old, already-closed positions' executions on every reconnect.

function formatIbkrExecutionFilterTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Replays IBKR's own execution log from the last few hours through whatever
 * execDetails listener is already attached (ibkrGatewayWorker.ts's
 * setupOrderTrackingListeners registers one on every connect, before this is
 * called) — recordExecution is idempotent by construction (trades.ibkr_exec_id
 * is UNIQUE), so re-processing an execution already recorded is a no-op.
 *
 * Exists to close a real gap: an opening execution with no position_leg yet
 * is buffered in-memory (pendingOpeningExecutions) until the next
 * reconciliation pass creates the leg. If the worker restarts in that
 * window, the buffer — and that fill's row in the Trade Blotter — was
 * previously lost for good, even though the position itself self-heals via
 * reconcilePositionsFromIbkr. Calling this on every (re)connect means that
 * gap is now covered by IBKR's own durable execution history instead of
 * relying on the live event having survived.
 *
 * No clientId filter — deliberately broadest, since a fill can originate
 * from an order placed outside the app entirely (see recordExecution's
 * comment on that case) and this should recover those too.
 */
export function replayRecentIbkrExecutions(ib: IBApi): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let count = 0;

    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.execDetails, onExecution);
      ib.off(EventName.execDetailsEnd, onEnd);
    }

    const onExecution = (reqId: number) => {
      if (reqId === executionReplayReqId) count++;
    };
    const onEnd = (reqId: number) => {
      if (reqId !== executionReplayReqId || settled) return;
      settled = true;
      cleanup();
      console.log(`replayRecentIbkrExecutions: replayed ${count} execution(s) from the last ${lookbackHours}h.`);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      console.error("replayRecentIbkrExecutions: timed out waiting for execDetailsEnd — proceeding without it.");
      resolve();
    }, replayTimeoutMs);

    ib.on(EventName.execDetails, onExecution);
    ib.once(EventName.execDetailsEnd, onEnd);
    ib.reqExecutions(executionReplayReqId, { time: formatIbkrExecutionFilterTime(new Date(Date.now() - lookbackHours * 60 * 60 * 1000)) });
  });
}
