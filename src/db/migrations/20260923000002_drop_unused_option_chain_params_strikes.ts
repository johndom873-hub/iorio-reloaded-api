import type { Knex } from "knex";

// The `strikes` column (reqSecDefOptParams's raw union-of-strikes array) was
// stored but never read back by chain construction — the real per-expiry
// strike grid comes from option_chain_expiry_strikes instead. Found during
// the 2026-09-23 IBKR endpoint audit.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_chain_params", (table) => {
    table.dropColumn("strikes");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_chain_params", (table) => {
    table.specificType("strikes", "decimal(12,4)[]").notNullable().defaultTo("{}");
  });
}
