import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestJobView } from "../backtestTypes.js";
import { readBacktestDataFileContents } from "../dataFileSummary.js";
import { loadLatestPortfolioLibraryJobView } from "../jobs/backtestJobStore.js";
import { marketDayHistoryOf } from "./portfolioDayHistory.js";
import { libraryGlobalKey, readLibraryManifest } from "./portfolioLibrary.js";
import { loadProjectionContext } from "./portfolioProjectionContext.js";

export interface PortfolioLibraryStatus {
  /** Null when it has not been built. */
  built: { asOf: string; builtAt: string; tickers: number; failed: Record<string, string> } | null;
  /** Built for today's data, the lab's settings and the code (null when not built). */
  current: boolean | null;
  /** The tickers whose data file was updated since their runs. */
  updatedSince: string[];
  /** The latest rebuild's job. */
  rebuild: BacktestJobView | null;
}

/** The library's state for the simulator: built or not, current or not, and its rebuild. */
export async function portfolioLibraryStatus(connection: Knex = db): Promise<PortfolioLibraryStatus> {
  const manifest = readLibraryManifest();
  const rebuild = await loadLatestPortfolioLibraryJobView();
  if (manifest === null) return { built: null, current: null, updatedSince: [], rebuild };
  const context = await loadProjectionContext(connection);
  const updatedSince = Object.entries(manifest.tickers)
    .filter(([symbol, entry]) => {
      const lastDate = readBacktestDataFileContents(symbol)?.lastDate ?? null;
      return lastDate !== null && lastDate !== entry.lastFileDay;
    })
    .map(([symbol]) => symbol);
  return {
    built: { asOf: manifest.asOf, builtAt: manifest.builtAt, tickers: Object.keys(manifest.tickers).length, failed: manifest.failed },
    current: manifest.globalKey === libraryGlobalKey(context, marketDayHistoryOf(context.spy.sessions)),
    updatedSince,
    rebuild,
  };
}
