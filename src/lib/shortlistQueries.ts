import type { Knex } from "knex";
import { db } from "../db/connection.js";

/** Ticker ids of every active shortlist entry: the price- and option-data universe (daily bars, calendar, chain structure, Volatility, Price Performance). */
export function activeShortlistTickerIdsQuery(connection: Knex = db) {
  return connection("shortlist_entries").whereNull("removed_at").select("ticker_id");
}
