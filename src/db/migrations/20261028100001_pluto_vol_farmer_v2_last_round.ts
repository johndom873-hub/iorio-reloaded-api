import type { Knex } from "knex";

// The Pluto screen's Vol Farmer v2 card (Marcelo 2026-10-28): each ticker's last round, its notes and the figures its
// warnings read (the pot check on v2's Puts, the free cash for a LEAPS). A ticker v2 cannot adopt yet keeps a row with no
// memory, for its notes.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_vol_farmer_v2_cycles", (table) => {
    table.jsonb("memory").nullable().alter();
    table.timestamp("last_round_at", { useTz: true }).nullable();
    /** What the round said about the ticker, in its order. */
    table.jsonb("last_round_notes").nullable();
    /** The round's figures (VolFarmerV2RoundFigures); null when it stopped before reading the book. */
    table.jsonb("last_round_figures").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex("pluto_vol_farmer_v2_cycles").whereNull("memory").delete();
  await knex.schema.alterTable("pluto_vol_farmer_v2_cycles", (table) => {
    table.dropColumns("last_round_at", "last_round_notes", "last_round_figures");
    table.jsonb("memory").notNullable().alter();
  });
}
