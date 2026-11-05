import type { Knex } from "knex";

// The account's two books, Pluto and Manual (Marcelo 2026-11-05): each has its own dollar balance that grows or shrinks
// with its own results, in place of Pluto's capital budget as a share of the account.
//
// book_cash_entries is the cash ledger: a book's cash is the sum of its entries. Rows come from IBKR's nightly statement
// (one per statement row and book, keyed by source_row_key so a re-read adds nothing), from an admin (deposit splits,
// moves between books), from a ticker switched between books, and from the cut-over's opening balances. Unallocated holds
// deposits and withdrawals until an admin splits them. Entries are never edited: a correction is a new entry. Amounts
// keep 6 decimals so a pro-rata split adds back up to the statement's amount exactly.
//
// ticker_book_periods: when each ticker belonged to Pluto; any other ticker, and every hedge, is Manual's.
// book_leg_transfers: each leg moved at a switch, at its mark: the source's realised P&L and the receiver's cost.
// book_value_snapshots: each book's cash, positions and value at the nightly snapshot.
// book_statement_imports: each nightly statement read, with its ending cash against the ledger's.
// books_cutover: the single row that starts the books.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("books_cutover", (table) => {
    table.boolean("id").primary().defaultTo(true);
    table.timestamp("cut_over_at", { useTz: true }).notNullable();
    table.date("statement_to_date");
    table.decimal("ibkr_cash", 20, 6).notNullable();
    table.decimal("pluto_starting_value", 20, 6).notNullable();
    table.decimal("pluto_positions_value", 20, 6).notNullable();
    // The statement rows already in the opening cash: a row first seen later, even one dated before the cut-over, is new cash.
    table.jsonb("statement_row_keys").notNullable().defaultTo("[]");
    table.uuid("created_by_user_id").references("id").inTable("users");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE books_cutover ADD CONSTRAINT books_cutover_single_row CHECK (id)");

  await knex.schema.createTable("book_cash_entries", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("book_key").notNullable();
    table.decimal("amount", 20, 6).notNullable();
    table.timestamp("effective_at", { useTz: true }).notNullable();
    table.text("kind").notNullable();
    table.text("source_row_key");
    table.uuid("group_id").notNullable();
    table.uuid("allocates_entry_id").references("id").inTable("book_cash_entries");
    table.text("symbol");
    table.text("description").notNullable();
    table.boolean("needs_review").notNullable().defaultTo(false);
    table.jsonb("statement_row");
    table.uuid("created_by_user_id").references("id").inTable("users");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["book_key", "effective_at"]);
    table.index(["group_id"]);
  });
  await knex.raw("ALTER TABLE book_cash_entries ADD CONSTRAINT book_cash_entries_book_key CHECK (book_key IN ('pluto', 'manual', 'unallocated'))");
  await knex.raw(
    `ALTER TABLE book_cash_entries ADD CONSTRAINT book_cash_entries_kind CHECK (kind IN (
      'opening_balance', 'trade', 'dividend', 'withholding_tax', 'interest', 'fee', 'sales_tax', 'commission_adjustment',
      'corporate_action', 'other_statement_row', 'external_transfer', 'deposit_split', 'book_move', 'ticker_transfer'))`,
  );
  await knex.raw("CREATE UNIQUE INDEX book_cash_entries_source_row_unique ON book_cash_entries (source_row_key, book_key) WHERE source_row_key IS NOT NULL");

  await knex.schema.createTable("ticker_book_periods", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("book_key").notNullable();
    table.timestamp("started_at", { useTz: true }).notNullable();
    table.timestamp("ended_at", { useTz: true });
    table.uuid("created_by_user_id").references("id").inTable("users");
    table.index(["ticker_id", "started_at"]);
  });
  await knex.raw("ALTER TABLE ticker_book_periods ADD CONSTRAINT ticker_book_periods_book_key CHECK (book_key = 'pluto')");
  await knex.raw("ALTER TABLE ticker_book_periods ADD CONSTRAINT ticker_book_periods_order CHECK (ended_at IS NULL OR ended_at >= started_at)");
  await knex.raw("CREATE UNIQUE INDEX ticker_book_periods_one_open ON ticker_book_periods (ticker_id) WHERE ended_at IS NULL");

  await knex.schema.createTable("book_leg_transfers", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_leg_id").notNullable().references("id").inTable("position_legs");
    table.text("from_book").notNullable();
    table.text("to_book").notNullable();
    table.timestamp("transferred_at", { useTz: true }).notNullable();
    table.integer("quantity").notNullable();
    table.decimal("mark_price", 14, 6).notNullable();
    table.decimal("cost_basis_price", 14, 6).notNullable();
    table.decimal("value_dollars", 20, 6).notNullable();
    table.decimal("realized_dollars", 20, 6).notNullable();
    table.text("mark_source").notNullable();
    table.uuid("group_id").notNullable();
    table.uuid("created_by_user_id").references("id").inTable("users");
    table.index(["position_leg_id", "transferred_at"]);
  });
  await knex.raw("ALTER TABLE book_leg_transfers ADD CONSTRAINT book_leg_transfers_books CHECK (from_book IN ('pluto', 'manual') AND to_book IN ('pluto', 'manual') AND from_book <> to_book)");

  await knex.schema.createTable("book_value_snapshots", (table) => {
    table.date("snapshot_date").notNullable();
    table.text("book_key").notNullable();
    table.decimal("cash", 20, 6).notNullable();
    table.decimal("positions_value", 20, 6).notNullable();
    table.decimal("book_value", 20, 6).notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["snapshot_date", "book_key"]);
  });
  await knex.raw("ALTER TABLE book_value_snapshots ADD CONSTRAINT book_value_snapshots_book_key CHECK (book_key IN ('pluto', 'manual', 'unallocated'))");

  await knex.schema.createTable("book_statement_imports", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.timestamp("imported_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.date("from_date").notNullable();
    table.date("to_date").notNullable();
    table.text("generated_at");
    table.timestamp("cut_off_at", { useTz: true }).notNullable();
    table.decimal("ending_cash", 20, 6);
    table.decimal("ledger_cash", 20, 6).notNullable();
    table.decimal("gap", 20, 6);
    table.integer("new_entry_count").notNullable();
    table.jsonb("problems").notNullable().defaultTo("[]");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("book_statement_imports");
  await knex.schema.dropTable("book_value_snapshots");
  await knex.schema.dropTable("book_leg_transfers");
  await knex.schema.dropTable("ticker_book_periods");
  await knex.schema.dropTable("book_cash_entries");
  await knex.schema.dropTable("books_cutover");
}
