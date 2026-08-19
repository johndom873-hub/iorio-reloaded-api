import { EventName, MarketDataType, Option, OptionType, Stock } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface PriceContract {
  key: string;
  legType: "stock" | "option";
  symbol: string;
  expiry?: string; // YYYYMMDD, option legs only
  strike?: number; // option legs only
  right?: OptionType; // option legs only
}

const quoteTimeoutMs = 5_000;

/**
 * Sibling of fetchLiveGreeks.ts — same shape, but captures last price
 * instead of Greeks. Used by the daily P&L snapshot job to mark open
 * positions to market (see the unrealized-P&L formula sign-off, 2026-08-20).
 */
export async function fetchLivePrices(contracts: PriceContract[]): Promise<Record<string, number | null>> {
  if (contracts.length === 0) return {};

  const connection = await connectToIbkrGateway();
  const { ib } = connection;

  try {
    ib.reqMarketDataType(MarketDataType.DELAYED);

    const priceByKey = new Map<string, number | null>();
    const reqIdToContract = new Map<number, PriceContract>();
    let nextReqId = 30_000;

    function onTickPrice(reqId: number, tickType: number, price: number) {
      const contract = reqIdToContract.get(reqId);
      if (!contract || price < 0) return;
      // Delayed tick types: last=68.
      if (tickType === 68) priceByKey.set(contract.key, price);
    }

    function onError(error: Error, code: number, reqId: number) {
      const contract = reqIdToContract.get(reqId);
      if (!contract) return;
      // 10167/10091: informational "using delayed data" notices, expected.
      if (code === 10167 || code === 10091) return;
      console.error(`Live price error for ${contract.symbol} (${contract.legType}, code ${code}): ${error.message}`);
    }

    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.error, onError);

    for (const contract of contracts) {
      const reqId = nextReqId++;
      reqIdToContract.set(reqId, contract);
      priceByKey.set(contract.key, null);
      const ibContract: Contract =
        contract.legType === "stock"
          ? new Stock(contract.symbol, "SMART", "USD")
          : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right!, "SMART");
      ib.reqMktData(reqId, ibContract, "", false, false);
    }

    await new Promise((resolve) => setTimeout(resolve, quoteTimeoutMs));

    for (const reqId of reqIdToContract.keys()) {
      ib.cancelMktData(reqId);
    }
    ib.removeListener(EventName.tickPrice, onTickPrice);
    ib.removeListener(EventName.error, onError);

    return Object.fromEntries(priceByKey);
  } finally {
    connection.disconnect();
  }
}
