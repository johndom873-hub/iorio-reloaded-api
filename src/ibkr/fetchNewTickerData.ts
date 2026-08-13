import { EventName, MarketDataType, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { captureMarketDataSnapshot } from "./captureMarketDataSnapshot.js";

export interface NewTickerData {
  companyName: string | null;
  sector: string | null;
  impliedVolatility: number | null;
  avgOptionVolume: number | null;
}

const contractDetailsTimeoutMs = 10_000;
// Shorter than captureMarketDataSnapshot's 15s batch-job default — this path
// is interactive (a person is watching a spinner), and avg_option_volume
// consistently never arrives under current delayed-data entitlements
// anyway, so waiting the full 15s just delays showing implied volatility
// (which usually does arrive within a couple seconds) for no benefit.
const interactiveMarketDataTimeoutMs = 5_000;
const contractDetailsReqId = 1;
const marketDataReqId = 2;

export function lookupContractDetails(
  connection: Awaited<ReturnType<typeof connectToIbkrGateway>>,
  reqId: number = contractDetailsReqId,
): Promise<{ companyName: string | null; sector: string | null }> {
  return new Promise((resolve) => {
    let settled = false;

    const onContractDetails = (id: number, details: { longName?: string; industry?: string }) => {
      if (id !== reqId) return;
      finish({ companyName: details.longName ?? null, sector: details.industry ?? null });
    };

    const onEnd = (id: number) => {
      if (id === reqId) finish({ companyName: null, sector: null });
    };

    // e.g. an invalid/unrecognized symbol — fail fast instead of waiting out
    // the full timeout for something that will never arrive.
    const onError = (_error: Error, _code: number, id: number) => {
      if (id === reqId) finish({ companyName: null, sector: null });
    };

    const timer = setTimeout(() => finish({ companyName: null, sector: null }), contractDetailsTimeoutMs);

    function finish(result: { companyName: string | null; sector: string | null }) {
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
  });
}

/**
 * Everything needed to show a freshly-added ticker in the Screener
 * immediately, rather than waiting for the next daily capture job run:
 * company name/sector (reqContractDetails) + implied volatility/avg option
 * volume (same delayed-data capture the daily job uses). One IBKR
 * connection for both, since they're always needed together at ticker
 * creation — connects per-request and disconnects when done, same
 * rationale as the rest of the ticker-creation path (rare manual action,
 * not a hot path, not worth a persistent server-side connection).
 */
export async function fetchNewTickerData(symbol: string): Promise<NewTickerData> {
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    const contractDetailsPromise = lookupContractDetails(connection);
    connection.ib.reqContractDetails(contractDetailsReqId, new Stock(symbol, "SMART", "USD"));

    const [contractDetails, marketData] = await Promise.all([
      contractDetailsPromise,
      captureMarketDataSnapshot(connection, marketDataReqId, symbol, interactiveMarketDataTimeoutMs),
    ]);

    return { ...contractDetails, ...marketData };
  } finally {
    connection.disconnect();
  }
}
