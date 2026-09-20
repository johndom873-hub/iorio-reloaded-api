import type { Knex } from "knex";

// Shared "last known good" stock price per symbol (approved 2026-09-19, price
// consistency audit in PROGRESS.md). IBKR's frozen `last` is intermittent per
// symbol and fades over a closed weekend, so two screens could disagree just
// because one asked earlier. Every live/frozen price any path receives is
// recorded here (src/lib/priceService.ts); every path falls back to it — never
// to a previous close — so all screens show the same number.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("last_known_prices", (table) => {
    table.text("symbol").primary();
    table.decimal("price", 14, 4).notNullable();
    table.timestamp("as_of", { useTz: true }).notNullable();
    table.text("source").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("last_known_prices");
}
