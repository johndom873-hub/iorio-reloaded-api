import { EventName, type Contract, type IBApi } from "@stoqey/ib";

const contractDetailsTimeoutMs = 10_000;

/**
 * Resolves conId for an arbitrary Contract (stock or option) via
 * reqContractDetails — generalized from fetchNewTickerData.ts's
 * lookupContractDetails, which was hardcoded to a Stock contract. Needed
 * before placing a combo (BAG) order: each ComboLeg needs a resolved conId,
 * not just symbol/strike/expiry/right.
 */
export function resolveContractId(ib: IBApi, contract: Contract, reqId: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;

    const onContractDetails = (id: number, details: { contract: { conId?: number } }) => {
      if (id !== reqId) return;
      finish(details.contract.conId ?? null);
    };
    const onEnd = (id: number) => {
      if (id === reqId) finish(null);
    };
    const onError = (_error: Error, _code: number, id: number) => {
      if (id === reqId) finish(null);
    };
    const timer = setTimeout(() => finish(null), contractDetailsTimeoutMs);

    function finish(conId: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ib.off(EventName.contractDetails, onContractDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      ib.off(EventName.error, onError);
      resolve(conId);
    }

    ib.on(EventName.contractDetails, onContractDetails);
    ib.once(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqContractDetails(reqId, contract);
  });
}
