import { EventName, SecType, type IBApi } from "@stoqey/ib";

const contractDetailsTimeoutMs = 10_000;

export interface ContractListing {
  symbol: string;
  primaryExchange: string | null;
}

/**
 * The symbol and primary exchange IBKR currently files a stock contract id under, or null when IBKR has nothing for
 * it. A contract id outlives its ticker: after a ticker change it resolves to the new symbol (804144296 PSKY -> SKYD),
 * and after a delisting it still resolves, to the old symbol on the "VALUE" exchange (554208351 WBD).
 */
export function lookupListingByContractId(ib: IBApi, conId: number, reqId: number): Promise<ContractListing | null> {
  return new Promise((resolve) => {
    let settled = false;

    const onContractDetails = (id: number, details: { contract: { symbol?: string; primaryExch?: string } }) => {
      if (id !== reqId) return;
      finish(details.contract.symbol ? { symbol: details.contract.symbol, primaryExchange: details.contract.primaryExch || null } : null);
    };
    const onEnd = (id: number) => {
      if (id === reqId) finish(null);
    };
    const onError = (_error: Error, _code: number, id: number) => {
      if (id === reqId) finish(null);
    };
    const timer = setTimeout(() => finish(null), contractDetailsTimeoutMs);

    function finish(listing: ContractListing | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ib.off(EventName.contractDetails, onContractDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      ib.off(EventName.error, onError);
      resolve(listing);
    }

    ib.on(EventName.contractDetails, onContractDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqContractDetails(reqId, { conId, secType: SecType.STK });
  });
}
