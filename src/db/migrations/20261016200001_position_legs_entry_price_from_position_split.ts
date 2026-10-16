import type { Knex } from "knex";

// A stock leg whose entry is its own position's cost, split out of IBKR's one blended average for the ticker
// (Marcelo 2026-10-15). Set while two or more positions hold the same shares; such a leg keeps its own cost
// afterwards (alone, or re-created on a roll) instead of taking IBKR's average, which after a sibling's sale
// reflects whichever lot IBKR sold first rather than the lots this position bought.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.boolean("entry_price_from_position_split").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropColumn("entry_price_from_position_split");
  });
}
