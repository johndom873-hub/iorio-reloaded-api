// ONE-OFF diagnostic (2026-08-31 trade-alert outage investigation): fully
// hardcoded, zero dynamic lookups -- same exact symbol/expiry/strikes run
// locally and via `heroku run`, to isolate whether Heroku's connection to
// the Gateway behaves differently from a local connection through the same
// SSH tunnel code. Strikes below were confirmed valid, listed DRAM calls
// (verified locally: all 20 got a tick within 8s; half-dollar and far-OTM
// strikes around them did not, consistent with those simply not existing
// as contracts -- not a data problem). Delete once investigation is closed.
//
// Usage (prod, via heroku run):
//   node dist/scripts/diagnoseHerokuMarketData.js

import "dotenv/config";
import { EventName, MarketDataType } from "@stoqey/ib";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";

const SYMBOL = "DRAM";
const EXPIRY = "20260902";
const STRIKES = [57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76];

async function main(): Promise<void> {
  console.log(`Environment: ${process.env.DYNO ? "heroku dyno " + process.env.DYNO : "local"}`);
  const connection = await connectToIbkrGateway();
  connection.ib.reqMarketDataType(MarketDataType.DELAYED);
  connection.ib.on(EventName.error, (error: Error, code: number, reqId: number) => {
    if (code !== 10091 && code !== 10167) console.log(`[error] reqId=${reqId} code=${code} ${error.message}`);
  });

  const ready = new Set<number>();
  connection.ib.on(EventName.tickPrice, (reqId: number) => ready.add(reqId));
  connection.ib.on(EventName.tickOptionComputation, (reqId: number) => ready.add(reqId));

  STRIKES.forEach((strike, i) => {
    connection.ib.reqMktData(
      200 + i,
      { symbol: SYMBOL, secType: "OPT", exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: EXPIRY, strike, right: "C" } as any,
      "",
      false,
      false,
    );
  });

  await new Promise((r) => setTimeout(r, 8_000));
  console.log(`RESULT: ${ready.size}/${STRIKES.length} contracts got data`);
  console.log(`Got data: ${STRIKES.filter((_, i) => ready.has(200 + i)).join(", ")}`);
  console.log(`No data: ${STRIKES.filter((_, i) => !ready.has(200 + i)).join(", ")}`);

  STRIKES.forEach((_, i) => connection.ib.cancelMktData(200 + i));
  await new Promise((r) => setTimeout(r, 500));
  connection.disconnect();
}

main()
  .catch((error) => console.error("Fatal:", error))
  .finally(() => process.exit(0));
