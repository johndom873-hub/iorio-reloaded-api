import type { Knex } from "knex";

// The CC + Put Ladder's memory per ticker between looks (ladderCycleMemory.ts): when the ticker's cycle started, the account
// value it started with (the base's floor), the highest price since its first shares (the ladder's floor F follows it) and
// the stock shock fixed at the cycle's start. One row per ticker the ladder has looked at; cleared when Pluto switches to
// the ladder, so a cycle open at the switch starts its memory there (Marcelo 2026-10-15).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pluto_ladder_cycles", (table) => {
    table.uuid("ticker_id").primary().references("id").inTable("tickers").onDelete("CASCADE");
    /** Eastern date the cycle started; null while the ticker is flat. */
    table.date("cycle_started_on").nullable();
    /** The whole account's value at the cycle's start (while flat: at the last look). */
    table.decimal("account_value_at_start", 16, 2).notNullable();
    /** Null until the cycle holds shares (a cycle of Puts alone has no peak yet). */
    table.decimal("peak_price", 12, 4).nullable();
    /** The stock shock S as a fraction (0.7 = 70%); null while flat. */
    table.decimal("shock_fraction", 8, 6).nullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("pluto_ladder_cycles");
}
