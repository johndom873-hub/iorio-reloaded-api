import type { Knex } from "knex";

// Cross-process coordination for IBKR's market-data-line cap (100 per TWS
// username, shared across EVERY connection on that login — not per
// connection, see the memory note this fixes: the nightly option-chain
// capture job and the Ticker Detail modal's live chain each independently
// assumed they owned the full 100, so running together starved both (staging
// incident, 2026-09-23). A holder reserves its line count here before
// opening reqMktData subscriptions and releases on completion; a TTL
// (expires_at) makes a crashed/killed process's reservation self-expire
// instead of permanently blocking the budget.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ibkr_market_data_line_reservations", (table) => {
    table.text("holder").primary();
    table.integer("lines").notNullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ibkr_market_data_line_reservations");
}
