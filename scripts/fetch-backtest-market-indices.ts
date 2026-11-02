import "dotenv/config";
import { requireBacktestDataDirectory } from "../src/backtest/backtestDataDirectory.js";
import { marketIndexBarsPath } from "../src/backtest/engine/marketIndexDailyBars.js";
import { refreshMarketIndexFiles } from "../src/backtest/fetchMarketIndexDailyBars.js";
import { lastFinishedBacktestSessionDate } from "../src/backtest/jobs/backtestJobRules.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";

// The VIX and VIX3M daily bars for backtests (src/backtest/engine/marketIndexDailyBars.ts): one read-only historical
// request per index through the Gateway the local API uses, 10 s apart; each file is rewritten whole. Run it (or Refresh
// VIX on the Backtesting screen) before a backtest whose rule reads them reaches days the files do not have.
//
// Usage: npm run backtest:fetch-market-indices

async function main(): Promise<void> {
  const dataDirectory = requireBacktestDataDirectory();
  const connection = await connectToIbkrGateway();
  try {
    await refreshMarketIndexFiles(connection, dataDirectory, {
      lastFinishedSessionIso: lastFinishedBacktestSessionDate(new Date()),
      onFileWritten: (file) => console.log(`${file.symbol}: ${file.bars.length} days, ${file.bars[0]!.dateIso} to ${file.bars.at(-1)!.dateIso} → ${marketIndexBarsPath(dataDirectory, file.symbol)}`),
    });
  } finally {
    connection.disconnect();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
