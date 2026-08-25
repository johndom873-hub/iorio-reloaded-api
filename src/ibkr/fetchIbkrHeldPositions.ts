import { EventName } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";

export interface IbkrHeldPosition {
  contract: Contract;
  quantity: number;
  avgCost: number;
}

/**
 * Pulls IBKR's actual current holdings via reqPositions(). Shared by
 * worker.ts's continuous position sync and checkPositionReconciliation.ts's
 * detection-only check — both need the exact same "what does IBKR say we
 * hold right now" snapshot.
 */
export async function fetchIbkrHeldPositions(ib: IBApi): Promise<IbkrHeldPosition[]> {
  return new Promise((resolve) => {
    const rows: IbkrHeldPosition[] = [];
    const onPosition = (_account: string, contract: Contract, pos: number, avgCost?: number) => {
      if (pos !== 0) rows.push({ contract, quantity: pos, avgCost: avgCost ?? 0 });
    };
    const onEnd = () => {
      ib.off(EventName.position, onPosition);
      ib.off(EventName.positionEnd, onEnd);
      resolve(rows);
    };
    ib.on(EventName.position, onPosition);
    ib.once(EventName.positionEnd, onEnd);
    ib.reqPositions();
  });
}
