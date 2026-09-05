import type { Knex } from "knex";

// New IBKR-scanner-backed ticker-discovery table for the Screener tab
// (2026-09-05, "screener -> discovery tool" redesign). Deliberately
// independent of `tickers` — a `tickers` row is the "we actually monitor
// this" contract relied on by market_data_snapshots, daily_price_bars, the
// daily capture job's ticker-selection query, and runTradeAlertGeneration's
// unfiltered shortlist scan. Scanner candidates (dozens-hundreds/day, most
// never shortlisted) must not expand that universe — only actually adding a
// candidate to the shortlist (via findOrCreateTicker) creates a `tickers`
// row. Upserted latest-per-symbol (one row, not one-per-scan-run) since only
// "today's snapshot" is shown; a stale row's scan_date lagging behind the
// latest run signals it dropped out of contention and the daily job deletes
// it. first_seen_date is kept across upserts as a cheap substitute for full
// history, which is an explicit non-goal here.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("screener_scan_results", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("symbol").notNullable().unique();
    table.text("company_name");
    table.text("sector");
    table.integer("ibkr_contract_id");

    // Which scan(s) this symbol matched today, and its best (lowest) rank
    // across them — a symbol can appear in more than one scan.
    table.specificType("scan_codes", "text[]").notNullable();
    table.integer("best_rank");

    table.decimal("last_price", 14, 4);
    table.decimal("avg_share_volume", 16, 2);
    table.decimal("avg_option_volume", 14, 2);
    table.decimal("call_open_interest", 14, 2);
    table.decimal("put_open_interest", 14, 2);
    table.decimal("bid_ask_spread_pct", 8, 6);
    // IBKR's own IV-vs-historical-IV ratio (HIGH_OPT_IMP_VOLAT_OVER_HIST) —
    // stand-in for our 252-day ivRank/ivPercentile (see ivMetrics.ts) until
    // the symbol is shortlisted and accumulates daily_price_bars.
    table.decimal("iv_vs_hist_ratio", 8, 4);
    table.decimal("implied_volatility", 8, 6);

    table.date("scan_date").notNullable();
    table.date("first_seen_date").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["scan_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("screener_scan_results");
}
