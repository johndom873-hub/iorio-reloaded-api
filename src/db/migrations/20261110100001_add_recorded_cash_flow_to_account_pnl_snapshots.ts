import type { Knex } from "knex";

/**
 * The part of net_cash_flow that is a deposit recorded before IBKR's statement holds it (books/recordedDeposits.ts,
 * Marcelo 2026-11-09): kept apart so the nightly reconcileCashFlows can drop it once the statement's own transfer counts
 * instead, under whichever night IBKR files it. net_cash_flow stays the total every reader uses.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("account_pnl_snapshots", (table) => {
    table.decimal("recorded_cash_flow", 14, 4).notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("account_pnl_snapshots", (table) => {
    table.dropColumn("recorded_cash_flow");
  });
}
