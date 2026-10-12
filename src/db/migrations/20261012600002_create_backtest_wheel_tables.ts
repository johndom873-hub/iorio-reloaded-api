import type { Knex } from "knex";

// Backtesting simulates the wheel (Marcelo 2026-10-12, docs/backtesting/FULL-FIDELITY-DESIGN.md): a session's simulated
// book is stored as the platform's own tables are shaped (positions, their legs, fills), with every action Pluto took or
// was blocked on and one row per wheel cycle. backtest_trades stays, one row per option sold, for the current screens;
// it gains the simulated leg and how the option ended. Quantities and multipliers are decimals: after a split inside a
// cycle one contract can cover a fraction of 100 of the cycle's shares.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_trades", (table) => {
    table.text("leg_id");
    table.text("ended_by").checkIn(["expired_worthless", "assigned", "bought_back", "rolled"]);
  });

  await knex.schema.createTable("backtest_positions", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    /** The simulated ledger's id, unique inside the session. */
    table.text("position_id").notNullable();
    /** The order the ledger created it in. */
    table.integer("sequence").notNullable();
    table.text("symbol").notNullable();
    table.text("strategy_key").notNullable().checkIn(["cash_secured_put", "covered_call", "unstructured"]);
    table.text("status").notNullable().checkIn(["open", "closed"]);
    table.timestamp("opened_at", { useTz: true }).notNullable();
    table.timestamp("closed_at", { useTz: true });
    table.text("close_reason");
    table.text("unstructured_reason");
    /** EXP $ now, net of premium (the platform's capitalAtRisk). */
    table.decimal("capital_at_risk_dollars", 16, 2);
    /** The P&L % base (the platform's capitalDeployed). */
    table.decimal("capital_deployed_dollars", 16, 2);
    table.decimal("realized_pnl_dollars", 16, 2).notNullable();
    table.decimal("realized_premium_pnl_dollars", 16, 2).notNullable();
    table.decimal("realized_stock_pnl_dollars", 16, 2).notNullable();
    /** At the session's last 10:00 marks; null for a closed position. */
    table.decimal("unrealized_pnl_dollars", 16, 2);
    /** Ids of the positions its shares came from. */
    table.jsonb("share_source_position_ids").notNullable().defaultTo("[]");
    table.primary(["session_id", "position_id"]);
  });

  await knex.schema.createTable("backtest_position_legs", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("leg_id").notNullable();
    table.integer("sequence").notNullable();
    table.text("position_id").notNullable();
    /** The leg a partial sale carved this closed slice from. */
    table.text("parent_leg_id");
    table.text("leg_type").notNullable().checkIn(["stock", "option"]);
    table.text("side").notNullable().checkIn(["long", "short"]);
    table.decimal("quantity", 18, 6).notNullable();
    table.text("option_type").checkIn(["call", "put"]);
    table.decimal("strike_price", 14, 6);
    table.date("expiry_date");
    table.decimal("multiplier", 14, 6).notNullable();
    /** Option: the fill less the opening commission per share. Stock: the cost per share with the commission. */
    table.decimal("entry_price", 16, 8).notNullable();
    table.timestamp("entry_at", { useTz: true }).notNullable();
    table.decimal("exit_price", 16, 8);
    table.timestamp("exit_at", { useTz: true });
    /** How an option settled at expiry, by the session's own rule (the wheel cycles are derived from it, not inferred from a price). */
    table.text("settled_as").checkIn(["assigned", "worthless"]);
    /** The underlying's close the settlement was decided on. */
    table.decimal("expiry_close", 16, 8);
    table.integer("dte_at_entry");
    table.decimal("realized_pnl_dollars", 16, 2);
    /** The stored prices ÷ this are the prices as traded on the entry day (1 unless a split fell inside the leg's cycle before it). */
    table.decimal("price_scale", 14, 8).notNullable().defaultTo(1);
    table.primary(["session_id", "leg_id"]);
    table.index(["session_id", "position_id"]);
  });

  await knex.schema.createTable("backtest_fills", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("fill_id").notNullable();
    table.integer("sequence").notNullable();
    table.text("position_id").notNullable();
    table.text("leg_id").notNullable();
    table.text("symbol").notNullable();
    table.text("instrument").notNullable().checkIn(["stock", "option"]);
    table.text("side").notNullable().checkIn(["buy", "sell"]);
    /** Contracts or shares as the ledger held them when it traded. */
    table.decimal("quantity", 18, 6).notNullable();
    /** Shares per contract when it traded (1 for stock): price × quantity × multiplier is the fill's dollars. */
    table.decimal("multiplier", 14, 6).notNullable();
    table.decimal("price", 16, 8).notNullable();
    /** The stored price ÷ this is the price as traded that day (1 unless a split fell inside the cycle before the fill). */
    table.decimal("price_scale", 14, 8).notNullable().defaultTo(1);
    table.decimal("commission_dollars", 12, 4).notNullable();
    table.timestamp("executed_at", { useTz: true }).notNullable();
    /** The Eastern date of executed_at: what the fills are filtered by. */
    table.date("trading_date").notNullable();
    table.boolean("is_closing").notNullable();
    /** The action that caused it; null for a settlement (shares put to the book at the strike). */
    table.text("action_id");
    table.primary(["session_id", "fill_id"]);
    table.index(["session_id", "trading_date"]);
  });

  await knex.schema.createTable("backtest_actions", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("action_id").notNullable();
    table.integer("sequence").notNullable();
    table.date("trading_date").notNullable();
    table.timestamp("at", { useTz: true }).notNullable();
    /** The pass inside the day's look, from 1. */
    table.integer("pass_number").notNullable();
    table.text("symbol").notNullable();
    table.text("kind").notNullable().checkIn(["open_cash_secured_put", "open_covered_call", "roll", "close_shares", "close_leg", "close_position"]);
    table.text("candidate_id").notNullable();
    table.text("description").notNullable();
    table.boolean("automatic").notNullable();
    table.text("chosen_because").notNullable();
    table.text("outcome").notNullable().checkIn(["filled", "blocked"]);
    table.text("block_reason");
    table.jsonb("gate_results").notNullable().defaultTo("[]");
    table.jsonb("contract");
    table.jsonb("candidate_scores");
    table.decimal("quantity", 18, 6);
    table.decimal("limit_price", 16, 8);
    table.decimal("fill_price", 16, 8);
    table.jsonb("position_ids").notNullable().defaultTo("[]");
    table.primary(["session_id", "action_id"]);
    table.index(["session_id", "trading_date"]);
  });

  await knex.schema.createTable("backtest_cycles", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("symbol").notNullable();
    /** In order of opening, from 1, per symbol. */
    table.integer("cycle_number").notNullable();
    table.text("status").notNullable().checkIn(["open", "closed"]);
    table.timestamp("opened_at", { useTz: true }).notNullable();
    table.timestamp("closed_at", { useTz: true });
    table.date("opened_on").notNullable();
    table.date("closed_on");
    /** The first day a put of the cycle was assigned. */
    table.date("assigned_on");
    /** Trading sessions from the assignment to the cycle's close. */
    table.integer("recovery_sessions");
    /** Open cycles: trading sessions from the assignment (else the opening) to the session's last day. */
    table.integer("age_sessions");
    table.decimal("total_dollars", 16, 2).notNullable();
    table.decimal("net_premium_dollars", 16, 2).notNullable();
    table.decimal("shares_held", 18, 6).notNullable();
    table.decimal("break_even_per_share", 16, 8);
    /** { csp, unstructured, cc, hedge }, each { premium, stock, total, capital }. */
    table.jsonb("buckets").notNullable();
    table.jsonb("data_flags").notNullable().defaultTo("[]");
    table.primary(["session_id", "symbol", "cycle_number"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_cycles");
  await knex.schema.dropTable("backtest_actions");
  await knex.schema.dropTable("backtest_fills");
  await knex.schema.dropTable("backtest_position_legs");
  await knex.schema.dropTable("backtest_positions");
  await knex.schema.alterTable("backtest_trades", (table) => {
    table.dropColumn("ended_by");
    table.dropColumn("leg_id");
  });
}
