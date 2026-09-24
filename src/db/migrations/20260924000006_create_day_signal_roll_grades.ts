import type { Knex } from "knex";

// Roll Signals (Formula 3j, 2026-09-24): the grade each (open short leg,
// replacement contract) roll had at the Day Signals loop's last re-score,
// so upward transitions are notified exactly like day_signal_quotes.last_grade
// does for new-trade candidates. Current trading day only: the seed wipes it
// with the other two day tables. Grades only -- the roll itself is re-derived
// at read time from the held leg and the candidate list.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("day_signal_roll_grades", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.uuid("leg_id").notNullable().references("id").inTable("position_legs").onDelete("CASCADE");
    table.date("expiry").notNullable();
    table.decimal("strike", 12, 4).notNullable();
    table.specificType("option_right", "char(1)").notNullable(); // 'C' | 'P'
    table.date("trading_date").notNullable();
    table.text("last_grade").notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(["leg_id", "expiry", "strike", "option_right"]);
    table.index(["ticker_id", "trading_date"]);
  });
  await knex.raw(`ALTER TABLE day_signal_roll_grades ADD CONSTRAINT day_signal_roll_grades_right_check CHECK (option_right IN ('C', 'P'))`);
  await knex.raw(`ALTER TABLE day_signal_roll_grades ADD CONSTRAINT day_signal_roll_grades_grade_check CHECK (last_grade IN ('strong', 'good', 'weak', 'avoid'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("day_signal_roll_grades");
}
