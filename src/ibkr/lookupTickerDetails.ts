import { EventName, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface TickerDetails {
  companyName: string | null;
  sector: string | null;
}

const lookupTimeoutMs = 10_000;

/**
 * Connects to the paper Gateway just for this lookup, then disconnects —
 * ticker creation is a rare, manual action, not a hot path, so this
 * deliberately doesn't keep a persistent IBKR connection alive on the server.
 */
export async function lookupTickerDetails(symbol: string): Promise<TickerDetails> {
  const connection = await connectToIbkrGateway();
  try {
    return await new Promise<TickerDetails>((resolve) => {
      const reqId = 1;
      let settled = false;

      const onContractDetails = (detailsReqId: number, details: { longName?: string; industry?: string }) => {
        if (detailsReqId !== reqId) return;
        finish({ companyName: details.longName ?? null, sector: details.industry ?? null });
      };

      const onEnd = (endReqId: number) => {
        if (endReqId === reqId) finish({ companyName: null, sector: null });
      };

      // e.g. an invalid/unrecognized symbol — fail fast instead of waiting
      // out the full timeout for something that will never arrive.
      const onError = (_error: Error, _code: number, errorReqId: number) => {
        if (errorReqId === reqId) finish({ companyName: null, sector: null });
      };

      const timer = setTimeout(() => finish({ companyName: null, sector: null }), lookupTimeoutMs);

      function finish(result: TickerDetails) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connection.ib.off(EventName.contractDetails, onContractDetails);
        connection.ib.off(EventName.contractDetailsEnd, onEnd);
        connection.ib.off(EventName.error, onError);
        resolve(result);
      }

      connection.ib.on(EventName.contractDetails, onContractDetails);
      connection.ib.once(EventName.contractDetailsEnd, onEnd);
      connection.ib.on(EventName.error, onError);
      connection.ib.reqContractDetails(reqId, new Stock(symbol, "SMART", "USD"));
    });
  } finally {
    connection.disconnect();
  }
}
