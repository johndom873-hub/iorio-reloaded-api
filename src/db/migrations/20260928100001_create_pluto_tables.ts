import type { Knex } from "knex";

// Pluto — the autonomous trading agent (design closed 2026-09-28; see the Signal
// Engine artifact's "Pluto" section and PROGRESS.md). Everything Pluto owns lives
// in these tables; every parameter default below was approved by Marcelo on
// 2026-09-28 (rounds 3–4). Additive only.
//
//   pluto_settings        one row, typed columns — every dial the Pluto screen edits
//   pluto_settings_audit  who changed which field from what to what, when
//   pluto_state           one row — mode, pause, breakers, last seen release
//   pluto_passes          one row per evaluation pass (event-triggered or opening look)
//   pluto_decisions       one row per model call: full input, raw + parsed output
//   pluto_actions         one row per concrete action: gates, order id, outcome, P&L
//   pluto_events          the screen's timeline feed
//   shortlist_entries.bot_enabled (+ who/when)   the per-ticker allow flag, default off
//   order_requests.pluto_action_id               the origin marker on Pluto's orders

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pluto_settings", (table) => {
    table.integer("id").primary().defaultTo(1);
    // Capital
    table.decimal("capital_budget_pct", 6, 2).notNullable().defaultTo(30);
    table.decimal("max_ticker_exposure_pct", 6, 2).notNullable().defaultTo(10);
    table.decimal("max_sector_exposure_pct", 6, 2).notNullable().defaultTo(100);
    table.integer("max_open_positions").notNullable().defaultTo(8);
    table.integer("max_actions_per_session").notNullable().defaultTo(10);
    table.decimal("max_order_notional_pct", 6, 2).notNullable().defaultTo(10);
    table.decimal("min_cash_reserve_pct", 6, 2).notNullable().defaultTo(5);
    // Candidate quality
    table.text("min_grade").notNullable().defaultTo("good");
    table.decimal("min_edge_dollars", 10, 2).notNullable().defaultTo(30);
    table.decimal("max_abs_delta", 6, 4).notNullable().defaultTo(0.3);
    table.integer("min_dte").notNullable().defaultTo(2);
    table.integer("max_dte").notNullable().defaultTo(45);
    table.decimal("min_annualized_yield_pct", 6, 2).notNullable().defaultTo(50);
    table.decimal("max_spread_pct", 6, 2).notNullable().defaultTo(15);
    table.integer("min_open_interest").notNullable().defaultTo(500);
    table.integer("min_session_volume").notNullable().defaultTo(50);
    table.integer("max_quote_age_minutes").notNullable().defaultTo(10);
    table.decimal("max_contracts_volume_share_pct", 6, 2).notNullable().defaultTo(20);
    // Model risk
    table.decimal("max_slice_rmse_vp", 6, 2).notNullable().defaultTo(2);
    table.integer("min_slice_point_count").notNullable().defaultTo(10);
    table.decimal("max_mid_vs_surface_iv_vp", 6, 2).notNullable().defaultTo(5);
    table.decimal("max_iv_shift_vp", 6, 2).notNullable().defaultTo(8);
    table.decimal("max_abs_day_change_pct", 6, 2).notNullable().defaultTo(6);
    // Market
    table.text("window_start_et").notNullable().defaultTo("10:45");
    table.text("window_end_et").notNullable().defaultTo("15:30");
    table.decimal("daily_loss_breaker_pct", 6, 2).notNullable().defaultTo(2);
    table.decimal("spy_stress_breaker_pct", 6, 2).notNullable().defaultTo(3);
    // Execution
    table.integer("unfilled_cancel_minutes").notNullable().defaultTo(20);
    table.decimal("max_edge_drift_vp", 6, 2).notNullable().defaultTo(1);
    table.integer("ticker_cooldown_sessions").notNullable().defaultTo(1);
    // Model
    table.text("model_id").notNullable().defaultTo("openai/gpt-6-luna");
    table.text("reasoning_effort").notNullable().defaultTo("medium");
    table.integer("call_timeout_seconds").notNullable().defaultTo(90);
    table.decimal("daily_cost_ceiling_usd", 8, 2).notNullable().defaultTo(3);
    table.decimal("confidence_floor", 4, 2).notNullable().defaultTo(0.6);
    table.integer("max_model_calls_per_session").notNullable().defaultTo(12);
    table.integer("consecutive_model_failures_breaker").notNullable().defaultTo(3);
    table.text("prompt_version").notNullable().defaultTo("v1");
    // Real-time triggers
    table.decimal("spot_move_trigger_pct", 6, 2).notNullable().defaultTo(1.5);
    table.integer("burst_lines").notNullable().defaultTo(10);
    table.integer("burst_settle_seconds").notNullable().defaultTo(4);
    table.integer("coalescing_window_seconds").notNullable().defaultTo(20);
    table.integer("per_ticker_model_cooldown_minutes").notNullable().defaultTo(10);
    table.integer("global_min_call_interval_seconds").notNullable().defaultTo(60);
    table.integer("max_enabled_tickers").notNullable().defaultTo(15);
    table.integer("message_rate_limit_per_second").notNullable().defaultTo(8);
    // Operational
    table.integer("crash_loop_restarts_per_hour").notNullable().defaultTo(3);
    table.text("telegram_verbosity").notNullable().defaultTo("actions");
    // Closing (Formulas P1 / P2)
    table.decimal("unstructured_close_min_pct", 6, 2).notNullable().defaultTo(1);
    table.decimal("unstructured_close_min_dollars", 10, 2).notNullable().defaultTo(50);
    table.integer("buyback_min_dte").notNullable().defaultTo(2);
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("updated_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
  await knex.raw("ALTER TABLE pluto_settings ADD CONSTRAINT pluto_settings_single_row CHECK (id = 1)");
  await knex("pluto_settings").insert({ id: 1 });

  await knex.schema.createTable("pluto_settings_audit", (table) => {
    table.bigIncrements("id");
    table.timestamp("changed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("user_id").references("id").inTable("users").onDelete("SET NULL");
    table.text("field").notNullable();
    table.text("old_value");
    table.text("new_value");
    table.index(["changed_at"]);
  });

  await knex.schema.createTable("pluto_state", (table) => {
    table.integer("id").primary().defaultTo(1);
    table.text("mode").notNullable().defaultTo("off");
    table.boolean("paused").notNullable().defaultTo(true);
    // manual | deploy | crash_loop | breaker:<name>
    table.text("pause_reason");
    table.uuid("paused_by_user_id").references("id").inTable("users").onDelete("SET NULL");
    table.timestamp("paused_at", { useTz: true });
    table.text("last_seen_release");
    // { <breaker name>: { trippedAt, detail } }
    table.jsonb("breakers").notNullable().defaultTo("{}");
    table.timestamp("last_pass_at", { useTz: true });
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE pluto_state ADD CONSTRAINT pluto_state_single_row CHECK (id = 1)");
  await knex.raw("ALTER TABLE pluto_state ADD CONSTRAINT pluto_state_mode_check CHECK (mode IN ('off', 'on'))");
  await knex("pluto_state").insert({ id: 1 });

  await knex.schema.createTable("pluto_passes", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.timestamp("started_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("finished_at", { useTz: true });
    // opening_look | spot_move | grade_crossing | day_quotes | held_leg | manual
    table.text("trigger").notNullable();
    table.jsonb("trigger_detail").notNullable().defaultTo("{}");
    table.text("input_hash");
    table.integer("candidate_count").notNullable().defaultTo(0);
    // { <check>: { ok, detail } }
    table.jsonb("system_checks").notNullable().defaultTo("{}");
    table.boolean("model_called").notNullable().defaultTo(false);
    table.text("skipped_reason");
    table.integer("tokens_in");
    table.integer("tokens_out");
    table.decimal("cost_usd", 10, 6);
    table.specificType("served_model_ids", "text[]").notNullable().defaultTo("{}");
    table.index(["started_at"]);
  });

  await knex.schema.createTable("pluto_decisions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("pass_id").notNullable().references("id").inTable("pluto_passes").onDelete("CASCADE");
    table.integer("call_index").notNullable();
    table.text("model_id").notNullable();
    table.text("served_model_id");
    table.jsonb("input_payload").notNullable();
    table.text("raw_output");
    table.jsonb("parsed_output");
    table.boolean("schema_valid").notNullable().defaultTo(false);
    table.integer("latency_ms");
    table.integer("tokens_in");
    table.integer("tokens_out");
    table.decimal("cost_usd", 10, 6);
    table.text("error");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["pass_id"]);
  });

  await knex.schema.createTable("pluto_actions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("pass_id").notNullable().references("id").inTable("pluto_passes").onDelete("CASCADE");
    // open_covered_call | open_cash_secured_put | roll | close_shares | close_leg | no_trade
    table.text("kind").notNullable();
    table.text("symbol").notNullable();
    table.uuid("ticker_id").references("id").inTable("tickers");
    table.jsonb("contract");
    table.jsonb("candidate_scores");
    table.jsonb("deterministic_top_pick");
    // [{ gate, ok, detail }] in evaluation order
    table.jsonb("gate_results").notNullable().defaultTo("[]");
    table.text("size_tier");
    table.integer("quantity");
    table.decimal("limit_price", 12, 4);
    // validated | blocked | order_built | confirmed | filled | partially_filled | cancelled | rejected | error | no_trade
    table.text("outcome").notNullable();
    table.text("block_reason");
    table.uuid("order_request_id").references("id").inTable("order_requests").onDelete("SET NULL");
    table.decimal("reference_bid", 12, 4);
    table.decimal("reference_mid", 12, 4);
    table.decimal("fill_price", 12, 4);
    table.decimal("pessimistic_pnl", 14, 2);
    table.decimal("realized_pnl", 14, 2);
    table.timestamp("evaluated_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["pass_id"]);
    table.index(["symbol", "created_at"]);
    table.index(["outcome"]);
  });

  await knex.schema.createTable("pluto_events", (table) => {
    table.bigIncrements("id");
    table.timestamp("occurred_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text("type").notNullable();
    table.jsonb("payload").notNullable().defaultTo("{}");
    table.index(["occurred_at"]);
  });

  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.boolean("bot_enabled").notNullable().defaultTo(false);
    table.uuid("bot_enabled_changed_by_user_id").references("id").inTable("users").onDelete("SET NULL");
    table.timestamp("bot_enabled_changed_at", { useTz: true });
  });

  await knex.schema.alterTable("order_requests", (table) => {
    table.uuid("pluto_action_id").references("id").inTable("pluto_actions").onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("pluto_action_id");
  });
  await knex.schema.alterTable("shortlist_entries", (table) => {
    table.dropColumn("bot_enabled");
    table.dropColumn("bot_enabled_changed_by_user_id");
    table.dropColumn("bot_enabled_changed_at");
  });
  await knex.schema.dropTableIfExists("pluto_events");
  await knex.schema.dropTableIfExists("pluto_actions");
  await knex.schema.dropTableIfExists("pluto_decisions");
  await knex.schema.dropTableIfExists("pluto_passes");
  await knex.schema.dropTableIfExists("pluto_state");
  await knex.schema.dropTableIfExists("pluto_settings_audit");
  await knex.schema.dropTableIfExists("pluto_settings");
}
