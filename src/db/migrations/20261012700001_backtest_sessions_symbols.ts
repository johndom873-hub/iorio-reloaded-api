import type { Knex } from "knex";

// A backtest session runs several symbols on one simulated book (docs/backtesting/FULL-FIDELITY-DESIGN.md, step 4).
// `symbols` is the list in the order given; `symbol` stays, holding the list as text ("SMCI" or "SMCI, HOOD"), for the
// jobs list and for sessions created before. Each option sold names its symbol.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.jsonb("symbols").notNullable().defaultTo("[]");
  });
  await knex.raw("UPDATE backtest_sessions SET symbols = jsonb_build_array(symbol)");
  await knex.schema.alterTable("backtest_trades", (table) => {
    table.text("symbol");
  });
  await knex.raw("UPDATE backtest_trades t SET symbol = s.symbol FROM backtest_sessions s WHERE s.id = t.session_id");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_trades", (table) => {
    table.dropColumn("symbol");
  });
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("symbols");
  });
}
