import type { Knex } from "knex";

// Daily option-chain archive for the IORIO Signal Engine (Phase 0, design
// approved 2026-09-21 — see PROGRESS.md "IORIO Signal Engine" and the guiding
// artifact's §13). IBKR cannot backfill per-strike history, so every trading
// day this isn't captured is calibration/backtest data lost for good.
//
// Two tables, exactly as approved (artifact Exhibits 6 and 7):
// - option_chain_snapshots: one header row per ticker per capture.
// - option_quote_snapshots: one row per contract per capture, keyed by
//   (snapshot_id, expiry, strike, option_right) so the same contract can be
//   followed across days (hold-vs-roll and early-exit simulations).
//
// A same-day re-run REPLACES that day's snapshot (approved 2026-09-21):
// unique (ticker_id, trading_date) on the header, and the child rows go with
// it via ON DELETE CASCADE — the capture deletes the header and inserts a new
// one inside one transaction, so a snapshot is never half-saved.
//
// Thin/wide quotes are stored, not dropped (approved): liquidity filters are
// applied when the data is read, so they can be tightened later on data
// already collected.
//
// `trading_date` and `expiry` are `date` columns — cast to ::text when
// reading, a raw `date` round-trips through node-pg's local-timezone parsing
// (see project_postgres_date_local_timezone_parsing).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("option_chain_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    // Eastern-time trading date of the capture (not the UTC date).
    table.date("trading_date").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable();
    // Spot at capture, from the shared last-known-good price service.
    table.decimal("underlying_price", 14, 4);
    // The rate in use that day, stored as a percent like risk_free_rates.rate_percent,
    // so every snapshot is self-contained and reproducible.
    table.decimal("risk_free_rate_percent", 8, 4);
    table.date("next_ex_dividend_date");
    table.decimal("next_ex_dividend_amount", 12, 4);
    // The daily blended IBKR implied volatility (decimal, 0.84 = 84%) used to
    // size this ticker's strike window (Formula 7).
    table.decimal("reference_implied_volatility", 10, 6);
    // 'real_time' | 'delayed' | 'mixed' | 'unknown', judged from which tick
    // types actually arrived (real-time bid=1/ask=2, delayed bid=66/ask=67).
    table.text("market_data_type").notNullable().defaultTo("unknown");
    // Coverage. `with_any_tick` drives the "starved ticker" re-capture rule
    // (fewer than 90% of requested contracts received any tick); the
    // two-sided-quote count is NOT used for that, because far-OTM contracts
    // legitimately have no bid.
    table.integer("contracts_requested").notNullable().defaultTo(0);
    table.integer("contracts_with_any_tick").notNullable().defaultTo(0);
    table.integer("contracts_with_two_sided_quote").notNullable().defaultTo(0);
    table.integer("contracts_with_implied_volatility").notNullable().defaultTo(0);
    table.integer("capture_duration_ms");
    // 'complete' | 'partial' | 'failed'
    table.text("status").notNullable();
    table.text("error_message");

    table.unique(["ticker_id", "trading_date"]);
    table.index(["trading_date"]);
  });

  await knex.schema.createTable("option_quote_snapshots", (table) => {
    table.uuid("snapshot_id").notNullable().references("id").inTable("option_chain_snapshots").onDelete("CASCADE");
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.specificType("option_right", "char(1)").notNullable(); // 'C' | 'P'
    table.decimal("bid", 12, 4);
    table.decimal("ask", 12, 4);
    table.decimal("last", 12, 4);
    table.integer("bid_size");
    table.integer("ask_size");
    // IBKR's model values (tickOptionComputation 13/83), not our own inversion.
    table.decimal("implied_volatility", 10, 6);
    table.decimal("delta", 10, 6);
    table.decimal("gamma", 10, 6);
    table.decimal("vega", 10, 6);
    table.decimal("theta", 10, 6);
    // The option's model value and the underlying price IBKR used to compute it.
    table.decimal("model_option_price", 12, 4);
    table.decimal("underlying_price", 14, 4);
    table.integer("open_interest");
    table.integer("volume");

    table.primary(["snapshot_id", "expiry", "strike", "option_right"]);
  });

  await knex.raw(`ALTER TABLE option_quote_snapshots ADD CONSTRAINT option_quote_snapshots_right_check CHECK (option_right IN ('C', 'P'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("option_quote_snapshots");
  await knex.schema.dropTableIfExists("option_chain_snapshots");
}
