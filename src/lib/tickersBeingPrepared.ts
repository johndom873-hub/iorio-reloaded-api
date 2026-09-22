import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { staleBackfillRunMinutes } from "./tickerBackfillSteps.js";

/** Restricts a tickers query to those NOT currently being prepared (a 'running' run younger than the stale window). */
export function excludeTickersBeingPrepared<T extends Knex.QueryBuilder>(query: T, tickerIdColumn: string): T {
  return query.whereNotIn(
    tickerIdColumn,
    db("ticker_backfill_runs")
      .where({ status: "running" })
      .whereRaw("started_at > now() - make_interval(mins => ?)", [staleBackfillRunMinutes])
      .select("ticker_id"),
  ) as T;
}
