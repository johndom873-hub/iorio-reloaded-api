import { db } from "../db/connection.js";
import { lastCompletedSessionDate } from "./marketSessionStatus.js";

// What the Shortlist's "Populate Daily Bars" action would do for one ticker, decided from what is stored.
// One source of truth for the Daily Bars column warning, the menu item's enabled state and the route itself.
//   full   -- no bars, or history short of ~5 years that no pipeline run has completed (a recently listed
//             ticker can never reach 5 years, so a completed history step clears this): fetch five years.
//   topUp  -- history is fine but the newest bar is older than the last completed session: fetch the gap.
//   none   -- nothing to do.
export type DailyBarsPlan = "full" | "topUp" | "none";

export function planDailyBarsPopulation(input: { historyIncomplete: boolean; latestBarDateIso: string | null; lastCompletedSessionDateIso: string }): DailyBarsPlan {
  if (input.latestBarDateIso === null || input.historyIncomplete) return "full";
  return input.latestBarDateIso < input.lastCompletedSessionDateIso ? "topUp" : "none";
}

export interface DailyBarsStatus {
  /** Earliest stored daily bar (YYYY-MM-DD), null when there are none. */
  historyStartDate: string | null;
  /** Newest stored daily bar (YYYY-MM-DD), null when there are none. */
  latestDailyBarDate: string | null;
  lastCompletedSessionDate: string;
  dailyBarsPlan: DailyBarsPlan;
}

export async function loadDailyBarsStatus(tickerId: string, now: Date = new Date()): Promise<DailyBarsStatus> {
  const [statusResult, lastCompletedSessionDateIso] = await Promise.all([
    db.raw(
      `
      SELECT
        first_bar::text AS "historyStartDate",
        latest_bar::text AS "latestDailyBarDate",
        CASE
          WHEN first_bar IS NULL OR first_bar > (current_date - interval '5 years' + interval '14 days')
            THEN NOT EXISTS (
              SELECT 1 FROM ticker_backfill_runs r
              WHERE r.ticker_id = :tickerId AND r.steps @> '[{"key":"history","status":"done"}]'::jsonb
            )
          ELSE false
        END AS "historyIncomplete"
      FROM (
        SELECT min(trading_date) AS first_bar, max(trading_date) AS latest_bar
        FROM daily_price_bars
        WHERE ticker_id = :tickerId
      ) bars
      `,
      { tickerId },
    ),
    lastCompletedSessionDate(now),
  ]);
  const row = statusResult.rows[0] as { historyStartDate: string | null; latestDailyBarDate: string | null; historyIncomplete: boolean };
  return {
    historyStartDate: row.historyStartDate,
    latestDailyBarDate: row.latestDailyBarDate,
    lastCompletedSessionDate: lastCompletedSessionDateIso,
    dailyBarsPlan: planDailyBarsPopulation({ historyIncomplete: row.historyIncomplete, latestBarDateIso: row.latestDailyBarDate, lastCompletedSessionDateIso }),
  };
}
