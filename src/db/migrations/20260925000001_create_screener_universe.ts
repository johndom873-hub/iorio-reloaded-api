import type { Knex } from "knex";

// Replaces screener_scan_results (2026-09-05 migration) with an accumulating
// "potential universe" table (design agreed 2026-09-25): unlike the old
// table, a symbol is never purged just because it didn't match tonight's
// scans — every symbol already in the table gets re-enriched every night
// regardless, so the data never goes stale even for a ticker that's stopped
// matching. best_rank/matched_scan_codes reflect ONLY the most recent
// refresh: 999/'{}' when the symbol didn't match tonight (sentinel, sorts to
// the bottom), the real rank/codes when it did. Deliberately independent of
// `tickers` for the same reason the old table was (see its migration
// comment) — most candidates are never shortlisted.
//
// Dropped columns from the old table: iv_vs_hist_ratio (sourced from
// IBKR's scannerData benchmark/projection fields, which were found to
// always be empty on this account — dead data, never real) and scan_date
// (superseded by last_matched_at/last_refreshed_at, which distinguish
// "still matching" from "just re-enriched").
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("screener_universe", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("symbol").notNullable().unique();
    table.integer("ibkr_contract_id");
    table.text("company_name");
    table.text("sector");
    table.text("primary_exchange");

    table.decimal("last_price", 14, 4);
    table.decimal("avg_share_volume", 16, 2);
    table.decimal("avg_option_volume", 14, 2);
    table.decimal("call_open_interest", 14, 2);
    table.decimal("put_open_interest", 14, 2);
    table.decimal("bid_ask_spread_pct", 8, 6);
    table.decimal("implied_volatility", 8, 6);

    // Reflects the most recent refresh only — see migration comment above.
    table.integer("best_rank").notNullable().defaultTo(999);
    table.specificType("matched_scan_codes", "text[]").notNullable().defaultTo("{}");

    table.timestamp("first_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("last_matched_at", { useTz: true });
    table.timestamp("last_refreshed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["best_rank"]);
    table.index(["sector"]);
  });

  await knex.schema.dropTableIfExists("screener_scan_results");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("screener_universe");

  await knex.schema.createTable("screener_scan_results", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("symbol").notNullable().unique();
    table.text("company_name");
    table.text("sector");
    table.integer("ibkr_contract_id");
    table.specificType("scan_codes", "text[]").notNullable();
    table.integer("best_rank");
    table.decimal("last_price", 14, 4);
    table.decimal("avg_share_volume", 16, 2);
    table.decimal("avg_option_volume", 14, 2);
    table.decimal("call_open_interest", 14, 2);
    table.decimal("put_open_interest", 14, 2);
    table.decimal("bid_ask_spread_pct", 8, 6);
    table.decimal("iv_vs_hist_ratio", 8, 4);
    table.decimal("implied_volatility", 8, 6);
    table.date("scan_date").notNullable();
    table.date("first_seen_date").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["scan_date"]);
  });
}
