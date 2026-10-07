import type { Knex } from "knex";
import { db } from "../db/connection.js";

/** Ticker ids of every active shortlist entry, Signals on or off: the price-data universe (daily bars, calendar, Price Performance). */
export function activeShortlistTickerIdsQuery(connection: Knex = db) {
  return connection("shortlist_entries").whereNull("removed_at").select("ticker_id");
}

/** Ticker ids of every active shortlist entry with Signals on: the option/volatility universe (chain capture, Signals, Pluto). */
export function signalsEnabledShortlistTickerIdsQuery(connection: Knex = db) {
  return connection("shortlist_entries").whereNull("removed_at").where({ signals_enabled: true }).select("ticker_id");
}
