import { EventName } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";

export interface IbkrHeldPosition {
  contract: Contract;
  quantity: number;
  avgCost: number;
}

const positionsTimeoutMs = 15_000;

/** One holding per account and contract; a contract without a conId falls back to its describing fields. */
function heldPositionKey(account: string, contract: Contract): string {
  const contractKey = contract.conId ?? [contract.symbol, contract.secType, contract.right, contract.strike, contract.lastTradeDateOrContractMonth].join("|");
  return `${account}:${contractKey}`;
}

/**
 * Pulls IBKR's actual current holdings via reqPositions(). Shared by
 * ibkrGatewayWorker.ts's continuous position sync and checkPositionReconciliation.ts's
 * detection-only check — both need the exact same "what does IBKR say we
 * hold right now" snapshot.
 *
 * Rejects rather than resolving with a possibly-empty/partial list if
 * positionEnd never arrives (dropped connection, API hiccup) — found
 * 2026-08-25 in a full-repo review: without this, a stalled snapshot
 * previously hung forever (no timeout existed at all) or, worse, could
 * have resolved with too few positions, which ibkrGatewayWorker.ts's
 * reconcilePositionsFromIbkr would have read as "IBKR no longer holds
 * this" and closed every genuinely-still-open leg. Rejecting lets that
 * function's existing (unwrapped) await naturally abort the whole pass
 * instead. Deliberately no EventName.error listener here — reqPositions()
 * has no per-request id to scope one to, and this connection fires plenty
 * of unrelated, harmless errors (order informational codes, market-data
 * subscription warnings) that would cause spurious aborts far more often
 * than they'd catch a real problem; the timeout is the sole safety net.
 *
 * IBKR also sends a `position` update whenever a fill changes a holding, so a fill landing inside the
 * reqPositions window repeats its contract at in-between quantities (3 Calls filling: -1, -2, -3). One
 * row per account and contract is kept, the latest; a contract whose latest quantity is 0 is no longer held.
 */
export function fetchIbkrHeldPositions(ib: IBApi): Promise<IbkrHeldPosition[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const latestByAccountAndContract = new Map<string, IbkrHeldPosition>();

    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.position, onPosition);
      ib.off(EventName.positionEnd, onEnd);
    }

    const onPosition = (account: string, contract: Contract, pos: number, avgCost?: number) => {
      const key = heldPositionKey(account, contract);
      if (pos === 0) latestByAccountAndContract.delete(key);
      else latestByAccountAndContract.set(key, { contract, quantity: pos, avgCost: avgCost ?? 0 });
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve([...latestByAccountAndContract.values()]);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("reqPositions timed out waiting for positionEnd."));
    }, positionsTimeoutMs);

    ib.on(EventName.position, onPosition);
    ib.once(EventName.positionEnd, onEnd);
    ib.reqPositions();
  });
}
