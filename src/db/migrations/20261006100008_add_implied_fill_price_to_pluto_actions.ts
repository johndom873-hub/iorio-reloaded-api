import type { Knex } from "knex";

// For a two-part order, the chosen option's price implied by the net fill with the other leg counted
// at the price we set on it (Marcelo, 2026-09-29). fill_price keeps IBKR's own report for the leg,
// which is its arbitrary split of the net; the screen shows this one with IBKR's figure beside it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.decimal("implied_fill_price", 12, 4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.dropColumn("implied_fill_price");
  });
}
