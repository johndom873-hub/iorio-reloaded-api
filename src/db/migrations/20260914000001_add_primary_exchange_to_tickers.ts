import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    // IBKR's Contract.primaryExch, e.g. "ISLAND" (Nasdaq) or "NYSE" — captured
    // alongside company_name/sector/ibkr_contract_id at ticker-creation time.
    // Immutable per symbol, so no refresh job needed (unlike trading/liquid
    // hours, which are fetched live — see fetchExchangeHours.ts).
    table.text("primary_exchange");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tickers", (table) => {
    table.dropColumn("primary_exchange");
  });
}
