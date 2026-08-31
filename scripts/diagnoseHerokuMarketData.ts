// ONE-OFF diagnostic (2026-08-31 trade-alert outage investigation): runs the
// exact same option-chain request the real scan makes, on Heroku's own
// infrastructure, to compare against identical local test results. Delete
// once the investigation is closed.
//
// Usage (prod, via heroku run):
//   node dist/scripts/diagnoseHerokuMarketData.js [SYMBOL] [SPOT_PRICE]

import "dotenv/config";
import { EventName, MarketDataType } from "@stoqey/ib";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { getCachedContractDetails } from "../src/ibkr/fetchNewTickerData.js";
import { getCachedOptionParams } from "../src/ibkr/fetchOptionChain.js";

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? "DRAM";
  const connection = await connectToIbkrGateway();
  connection.ib.reqMarketDataType(MarketDataType.DELAYED);
  connection.ib.on(EventName.error, (error: Error, code: number, reqId: number) => {
    if (code !== 10091 && code !== 10167) console.log(`[error] reqId=${reqId} code=${code} ${error.message}`);
  });

  const { conId } = await getCachedContractDetails(connection, symbol, 1);
  console.log("conId=" + conId);
  const { strikes, expirations } = await getCachedOptionParams(connection.ib, symbol, conId!);

  const today = new Date();
  const inWindow = expirations
    .filter((e) => {
      const d = new Date(`${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`);
      const dte = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      return dte >= 1 && dte <= 14;
    })
    .sort();
  const expiry = inWindow[0];
  console.log("expiry=" + expiry);

  const spotPrice = Number(process.argv[3] ?? "56.5");
  const uniqueStrikes = [...new Set(strikes)]
    .filter((s) => s > spotPrice && s <= spotPrice * 1.4)
    .sort((a, b) => a - b);
  console.log(`Requesting ${uniqueStrikes.length} distinct near-money strikes...`);

  const ready = new Set<number>();
  connection.ib.on(EventName.tickPrice, (reqId: number) => ready.add(reqId));
  connection.ib.on(EventName.tickOptionComputation, (reqId: number) => ready.add(reqId));

  uniqueStrikes.forEach((strike, i) => {
    connection.ib.reqMktData(
      200 + i,
      { symbol, secType: "OPT", exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: expiry, strike, right: "C" } as any,
      "",
      false,
      false,
    );
  });

  await new Promise((r) => setTimeout(r, 8_000));
  console.log(`RESULT: ${ready.size}/${uniqueStrikes.length} contracts got data (from heroku run dyno)`);
  uniqueStrikes.forEach((_, i) => connection.ib.cancelMktData(200 + i));
  await new Promise((r) => setTimeout(r, 500));
  connection.disconnect();
}

main()
  .catch((error) => console.error("Fatal:", error))
  .finally(() => process.exit(0));
