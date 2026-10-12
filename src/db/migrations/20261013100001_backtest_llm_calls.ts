import type { Knex } from "knex";

// The backtest's LLM mode (Marcelo 2026-10-12, docs/backtesting/FULL-FIDELITY-DESIGN.md §5): every answered call is kept
// once, keyed by a hash of exactly what the model was given (model, effort, system prompt, masked payload), so a re-run
// or a resumed session never asks the same question twice. Each session logs every decision it asked for, answered from
// the model or from that cache, in real symbols and dates; the masking it used is stored with the session.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_llm_calls", (table) => {
    table.text("request_hash").primary();
    table.text("model").notNullable();
    table.text("reasoning_effort").notNullable();
    table.text("system_prompt_hash").notNullable();
    /** What the model was given: symbols aliased, dates shifted. */
    table.jsonb("masked_payload").notNullable();
    /** The model's answer as it gave it (masked). */
    table.text("raw_output").notNullable();
    table.text("served_model_id");
    table.integer("tokens_in");
    table.integer("tokens_out");
    /** The CLI's API-equivalent figure: nothing is billed on the subscription. */
    table.decimal("api_equivalent_cost_usd", 12, 6);
    table.integer("latency_ms").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("backtest_session_llm_calls", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.integer("sequence").notNullable();
    table.date("trading_date").notNullable();
    /** 'HH:MM' Eastern. */
    table.text("look_time").notNullable();
    table.text("request_hash").notNullable();
    /** Null when the call failed: only answered calls are cached. */
    table.text("llm_call_id").references("request_hash").inTable("backtest_llm_calls");
    table.boolean("cache_hit").notNullable();
    table.text("outcome").notNullable().checkIn(["decided", "invalid_answer", "call_failed", "usage_limit"]);
    /** The answer in real symbols and dates, as Pluto's parser read it. */
    table.jsonb("decision");
    table.text("error");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["session_id", "sequence"]);
  });

  await knex.schema.alterTable("backtest_sessions", (table) => {
    /** LLM mode only: { aliasBySymbol, dateShiftWeeks }. */
    table.jsonb("llm_masking");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_sessions", (table) => {
    table.dropColumn("llm_masking");
  });
  await knex.schema.dropTable("backtest_session_llm_calls");
  await knex.schema.dropTable("backtest_llm_calls");
}
