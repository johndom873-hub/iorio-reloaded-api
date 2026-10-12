import type { Knex } from "knex";

// Model backtesting (Marcelo 2026-10-12, docs/backtesting/): sessions with their settings snapshot and overrides, every
// day's account value, every simulated trade, and the background jobs (downloads and runs) whose progress the screen
// shows across API restarts. Local-only feature; the tables exist (empty) everywhere the migrations run.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_sessions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("name").notNullable();
    table.text("symbol").notNullable();
    table.date("start_date").notNullable();
    table.date("end_date").notNullable();
    table.decimal("starting_value", 16, 2).notNullable();
    table.text("tables_mode").notNullable().checkIn(["walk_forward", "current"]);
    /** Pluto's and the trading settings as they were when the session was created: { pluto, trading, kellyFraction }. */
    table.jsonb("settings_snapshot").notNullable();
    /** Only the changed values, same shape as the snapshot. */
    table.jsonb("overrides").notNullable().defaultTo("{}");
    table.text("status").notNullable().defaultTo("queued").checkIn(["queued", "running", "succeeded", "failed", "cancelled"]);
    /** The session's headline figures (FORMULAS.md), filled when the run succeeds. */
    table.jsonb("metrics");
    /** The same figures for buy and hold over the same days. */
    table.jsonb("baseline_metrics");
    /** The data file's last complete day when the run started (a later download does not change a finished session). */
    table.date("data_last_date");
    table.text("error");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("finished_at", { useTz: true });
    table.index(["symbol"]);
  });

  await knex.schema.createTable("backtest_session_days", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.date("trading_date").notNullable();
    table.decimal("account_value", 16, 2).notNullable();
    table.decimal("cash", 16, 2).notNullable();
    /** Σ EXP $ of the open positions at 10:00 (net of premium). */
    table.decimal("exposure_dollars", 16, 2).notNullable();
    table.decimal("interest_dollars", 12, 2).notNullable();
    /** Account value ÷ previous day's − 1; null on the first day. */
    table.decimal("daily_return", 14, 10);
    table.decimal("baseline_value", 16, 2).notNullable();
    table.decimal("baseline_daily_return", 14, 10);
    /** One line on the day's decision: what opened, or why nothing did. */
    table.text("decision_summary");
    table.primary(["session_id", "trading_date"]);
  });

  await knex.schema.createTable("backtest_trades", (table) => {
    table.bigIncrements("id").primary();
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.date("opened_on").notNullable();
    table.text("strategy_key").notNullable().checkIn(["cash_secured_put", "covered_call"]);
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.specificType("option_right", "char(1)").notNullable();
    table.integer("contracts").notNullable();
    table.decimal("bid", 12, 4).notNullable();
    table.decimal("ask", 12, 4).notNullable();
    /** Sale price per share: mid − spread cost share × half-spread. */
    table.decimal("fill_price", 12, 4).notNullable();
    table.decimal("commission_dollars", 12, 2).notNullable();
    table.decimal("spot_at_open", 14, 4).notNullable();
    /** Covered call: the share purchase price per share; null for a put. */
    table.decimal("share_price_at_open", 14, 4);
    /** EXP $ at the open, net of premium, for all contracts. */
    table.decimal("exposure_dollars", 16, 2).notNullable();
    table.integer("dte").notNullable();
    table.decimal("delta", 8, 4);
    table.text("grade").notNullable();
    table.decimal("edge_margin", 14, 6).notNullable();
    /** The model's Edge $ and Hist Edge $ for all contracts, at the open. */
    table.decimal("expected_pnl_dollars", 14, 2).notNullable();
    table.decimal("calibrated_expected_pnl_dollars", 14, 2).notNullable();
    table.decimal("edge_yield", 12, 6);
    table.decimal("hist_yield", 12, 6);
    table.decimal("kelly_contracts", 12, 2);
    table.decimal("stress_contracts", 12, 2);
    table.date("settled_on");
    /** The underlying's close on the expiry day. */
    table.decimal("settlement_close", 14, 4);
    table.boolean("in_the_money_at_expiry");
    /** Realized P&L for all contracts, after commission. */
    table.decimal("pnl_dollars", 16, 2);
    table.index(["session_id", "opened_on"]);
  });

  await knex.schema.createTable("backtest_jobs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("kind").notNullable().checkIn(["download", "backtest"]);
    table.text("symbol").notNullable();
    table.uuid("session_id").references("id").inTable("backtest_sessions").onDelete("CASCADE");
    /** Download range (backtests read theirs from the session). */
    table.date("start_date");
    table.date("end_date");
    table.text("status").notNullable().defaultTo("queued").checkIn(["queued", "running", "succeeded", "failed", "cancelled"]);
    table.integer("progress_done").notNullable().defaultTo(0);
    table.integer("progress_total").notNullable().defaultTo(0);
    table.text("progress_label");
    table.boolean("cancel_requested").notNullable().defaultTo(false);
    table.integer("pid");
    table.text("error");
    table.timestamp("heartbeat_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("started_at", { useTz: true });
    table.timestamp("finished_at", { useTz: true });
    table.index(["status"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_jobs");
  await knex.schema.dropTable("backtest_trades");
  await knex.schema.dropTable("backtest_session_days");
  await knex.schema.dropTable("backtest_sessions");
}
