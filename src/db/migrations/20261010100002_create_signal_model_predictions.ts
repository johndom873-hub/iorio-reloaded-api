import type { Knex } from "knex";

// The valuation model's prediction for every Signals candidate at the morning seed (model review, approved by Marcelo
// 2026-10-10): one row per ticker, trading date and contract, so the model can be judged monthly against what each
// contract actually earned by expiry (no parallel model is run; this is the evidence trail).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("signal_model_predictions", (table) => {
    table.bigIncrements("id").primary();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.date("trading_date").notNullable();
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.specificType("option_right", "char(1)").notNullable();
    table.timestamp("valued_at", { useTz: true }).notNullable();
    table.text("quote_source").notNullable();
    table.decimal("bid", 12, 4).notNullable();
    table.decimal("ask", 12, 4).notNullable();
    table.decimal("spot", 14, 4).notNullable();
    table.decimal("forward", 14, 4).notNullable();
    table.decimal("forecast_volatility", 10, 6).notNullable();
    table.decimal("variance_sessions", 10, 4).notNullable();
    table.decimal("fair_price", 12, 4).notNullable();
    table.decimal("edge_margin", 14, 6).notNullable(); // very negative when a tiny mid sits far under its fair price
    table.decimal("expected_pnl_dollars", 12, 2).notNullable();
    table.decimal("calibrated_expected_pnl_dollars", 12, 2).notNullable();
    table.decimal("probability_of_profit", 8, 6).notNullable();
    table.decimal("expected_shortfall_dollars", 12, 2).notNullable();
    table.text("grade").notNullable();
    table.text("tables_built_at").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["ticker_id", "trading_date", "expiry", "strike", "option_right"]);
    table.index(["trading_date"]);
  });
  await knex.raw(`ALTER TABLE signal_model_predictions ADD CONSTRAINT signal_model_predictions_right_check CHECK (option_right IN ('C','P'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("signal_model_predictions");
}
