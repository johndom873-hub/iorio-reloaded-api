import type { Knex } from "knex";

// The band of option quotes serves every strategy, not only the CC + Put Ladder (Marcelo 2026-10-28): the table and its
// constraints take the band's name.
const constraintSuffixes = ["pkey", "right_check", "ticker_id_foreign"];

export async function up(knex: Knex): Promise<void> {
  await knex.raw("alter table ladder_band_quotes rename to option_quote_band_quotes");
  for (const suffix of constraintSuffixes) await knex.raw(`alter table option_quote_band_quotes rename constraint ladder_band_quotes_${suffix} to option_quote_band_quotes_${suffix}`);
}

export async function down(knex: Knex): Promise<void> {
  for (const suffix of constraintSuffixes) await knex.raw(`alter table option_quote_band_quotes rename constraint option_quote_band_quotes_${suffix} to ladder_band_quotes_${suffix}`);
  await knex.raw("alter table option_quote_band_quotes rename to ladder_band_quotes");
}
