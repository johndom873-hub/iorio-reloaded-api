import type { Knex } from "knex";

// Day Signals (design agreed 2026-09-24, see PROGRESS.md): the intraday pool
// of expiries per ticker chosen from the 10:00 ET snapshot scoring, and the
// latest bid/ask the refresh loop has seen for every captured contract in
// those expiries. Both tables hold only the current trading day — the seed
// step wipes and re-fills them in one transaction after each capture — and
// quotes only: scores are re-derived at read time because they depend on the
// live spot and account context.
//
// `trading_date`/`expiry` are `date` columns — cast to ::text when reading
// (see project_postgres_date_local_timezone_parsing).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("day_signal_expiries", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.date("expiry").notNullable();
    // Eastern trading date of the snapshot the pool was seeded from; day quotes
    // are only merged into scoring when this matches the snapshot being scored.
    table.date("trading_date").notNullable();
    table.uuid("snapshot_id").notNullable().references("id").inTable("option_chain_snapshots").onDelete("CASCADE");
    // 1..3: order in which the expiry first appeared among the ticker's top-10 candidates by Edge $.
    table.integer("rank").notNullable();
    table.decimal("seed_best_edge_dollars", 14, 4).notNullable();
    table.decimal("seed_best_net_edge", 10, 6).notNullable();
    table.timestamp("seeded_at", { useTz: true }).notNullable();

    table.primary(["ticker_id", "expiry"]);
    table.index(["trading_date"]);
  });

  await knex.schema.createTable("day_signal_quotes", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.specificType("option_right", "char(1)").notNullable(); // 'C' | 'P'
    table.date("trading_date").notNullable();
    table.decimal("bid", 12, 4);
    table.decimal("ask", 12, 4);
    table.decimal("last", 12, 4);
    // IBKR error code for the last request of this contract (e.g. 200 no security definition), null when it quoted.
    table.integer("error_code");
    table.timestamp("quoted_at", { useTz: true }).notNullable();
    table.integer("cycle_number").notNullable();
    // Grade at the loop's last re-score of this contract; upward transitions from it are what get notified.
    table.text("last_grade");

    table.primary(["ticker_id", "expiry", "strike", "option_right"]);
    table.index(["ticker_id", "trading_date"]);
  });

  await knex.raw(`ALTER TABLE day_signal_quotes ADD CONSTRAINT day_signal_quotes_right_check CHECK (option_right IN ('C', 'P'))`);
  await knex.raw(`ALTER TABLE day_signal_quotes ADD CONSTRAINT day_signal_quotes_grade_check CHECK (last_grade IS NULL OR last_grade IN ('strong', 'good', 'weak', 'avoid'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("day_signal_quotes");
  await knex.schema.dropTableIfExists("day_signal_expiries");
}
