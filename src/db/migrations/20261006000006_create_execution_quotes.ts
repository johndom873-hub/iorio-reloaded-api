import type { Knex } from "knex";

// The bid and ask of the executed contract at the moment of each fill (Marcelo 2026-10-05), so the share of the half-spread
// a mid-limit order really gives up can be measured and Risk & Limits' spread cost set from evidence. Keyed by IBKR's
// execution id (the same key as trades.ibkr_exec_id), so an opening fill buffered before its leg exists still gets its quote.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("execution_quotes", (table) => {
    table.text("ibkr_exec_id").primary();
    table.text("ibkr_contract_id").notNullable();
    table.text("sec_type").notNullable();
    table.timestamp("executed_at", { useTz: true }).notNullable();
    table.decimal("execution_price", 12, 4).notNullable();
    table.decimal("bid", 12, 4);
    table.decimal("ask", 12, 4);
    table.timestamp("quoted_at", { useTz: true }).notNullable();
    table.text("note"); // what IBKR said when a side is missing (an error, delayed-only data)
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("execution_quotes");
}
