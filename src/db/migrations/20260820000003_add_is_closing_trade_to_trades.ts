import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trades", (table) => {
    // Distinguishes the opening trade (position/leg created) from the
    // closing trade (position/leg exited) for a given position_leg — needed
    // by the Trade Blotter to know which trade row a leg's realized P&L
    // belongs to, without fragile price/timestamp matching against
    // position_legs.
    table.boolean("is_closing_trade").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trades", (table) => {
    table.dropColumn("is_closing_trade");
  });
}
