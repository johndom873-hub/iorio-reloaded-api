import type { Knex } from "knex";

// Each option contract's full-session volume, read from IBKR after the close (Marcelo 2026-10-15): the CC + Put Ladder's
// 20% rule caps a sale at 20% of the contract's previous-session volume. IBKR's quote volume (tick 8) holds the full day
// only after the close and resets overnight, so a job reads it at 21:30 UTC for the next day. The IBKR implied volatility
// of the same quote is kept as the contract's last-seen IV, which picks the contracts the next capture quotes.
// One row per contract the capture asked for: volume null = IBKR sent none.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("option_session_volumes", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    /** The session the volume is for (Eastern date). */
    table.date("session_date").notNullable();
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.string("option_right", 1).notNullable();
    table.integer("volume").nullable();
    table.decimal("bid", 12, 4).nullable();
    table.decimal("ask", 12, 4).nullable();
    table.decimal("implied_volatility", 10, 6).nullable();
    /** The stock price the capture used for its band (IBKR's last after the close). */
    table.decimal("stock_price", 12, 4).nullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["ticker_id", "session_date", "expiry", "strike", "option_right"]);
    table.index(["ticker_id", "expiry", "strike", "option_right", "session_date"]);
  });
  await knex.raw("alter table option_session_volumes add constraint option_session_volumes_right_check check (option_right in ('C', 'P'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("option_session_volumes");
}
