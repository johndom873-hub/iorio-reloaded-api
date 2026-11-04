import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { loadBacktestLabSettings } from "../labSettingsStore.js";
import { loadTickerProjectionSource, type TickerProjectionSource } from "./portfolioProjectionInputs.js";

// What every portfolio projection and the suggestions' library read besides the tickers (kept apart so the library's code
// hash covers only what its runs depend on): the seed of the paths, today (SPY's last file day), the T-bill now (DTB3's
// latest) and its average from 2010 over SPY's sessions, SPY's history and the lab's settings.

export const projectionSeed = 20261103;
const treasuryBillAverageFromIso = "2010-01-04";

/** What every projection and the suggestions' library read besides the tickers: today (SPY's last file day), the T-bills, SPY's history and the lab's settings. */
export interface ProjectionContext {
  asOfIso: string;
  riskFreeNowPct: number;
  /** DTB3's average from 2010 over SPY's sessions. */
  riskFreeAveragePct: number;
  rates: TreasuryBillRates;
  spy: TickerProjectionSource;
  /** The lab's settings as a session reads them, before a book's allocations. */
  labSettings: ReturnType<typeof applyBacktestOverrides>;
}

export async function loadProjectionContext(connection: Knex = db): Promise<ProjectionContext> {
  const rates = await loadTreasuryBillRates(requireBacktestDataDirectory(), treasuryBillAverageFromIso, new Date().toISOString().slice(0, 10));
  const spy = await loadTickerProjectionSource("SPY", rates, connection);
  const asOfIso = spy.lastFileDay;
  const lab = await loadBacktestLabSettings(connection);
  const historyDates = spy.sessions.filter((session) => session.tradingDate >= treasuryBillAverageFromIso).map((session) => session.tradingDate);
  const riskFreeAveragePct = historyDates.reduce((sum, date) => sum + (rates.ratePercentOnOrBefore(date) ?? 0), 0) / Math.max(1, historyDates.length);
  return { asOfIso, riskFreeNowPct: rates.ratePercentOnOrBefore(asOfIso) ?? 0, riskFreeAveragePct, rates, spy, labSettings: applyBacktestOverrides(lab.settings, {}) };
}
