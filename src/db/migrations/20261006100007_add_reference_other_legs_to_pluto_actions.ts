import type { Knex } from "knex";

// Combo fills are measured on the net (Marcelo, 2026-09-29): IBKR fills a guaranteed combo at the net
// limit but splits it between the legs its own way, so the slippage and pessimistic figures compare the
// net fill with the net reference. The chosen option leg stays in reference_bid; the combo's other legs
// (a buy-write's shares, a roll's buyback) are stored here so an order adopted after a restart keeps them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.jsonb("reference_other_legs");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.dropColumn("reference_other_legs");
  });
}
