import type { Knex } from "knex";

// Pluto's check of its memory against the ledger (Marcelo 2026-11-23, src/pluto/ledgerCheck.ts): when a ticker's memory and
// its open positions first disagreed, and how, so the 120 seconds after which the ticker is held survive an agent restart.
// Both null while they agree.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_vol_farmer_v4_cycles", (table) => {
    table.timestamp("ledger_mismatch_since", { useTz: true });
    table.text("ledger_mismatch_detail");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_vol_farmer_v4_cycles", (table) => {
    table.dropColumn("ledger_mismatch_detail");
    table.dropColumn("ledger_mismatch_since");
  });
}
