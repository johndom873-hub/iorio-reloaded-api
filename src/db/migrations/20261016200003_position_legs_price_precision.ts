import type { Knex } from "knex";

// Entry and exit prices to 8 decimals (Marcelo 2026-10-16, "show the truth"): IBKR's average cost per share is not a
// 4-decimal number (two calls sold at 0.36 with $0.9462 commission cost 0.355269 a share), and 4 decimals times the
// shares put P&L a cent or more off the real fills and commissions. Existing values are kept as stored.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.decimal("entry_price", 18, 8).notNullable().alter();
    table.decimal("exit_price", 18, 8).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.decimal("entry_price", 12, 4).notNullable().alter();
    table.decimal("exit_price", 12, 4).nullable().alter();
  });
}
