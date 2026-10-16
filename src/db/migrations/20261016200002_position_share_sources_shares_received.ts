import type { Knex } from "knex";

// How many shares a hand-over delivered (Marcelo 2026-10-16): each open position's own break-even splits a source
// position's amounts by the shares each receiver got (breakEvenByPositionFromHistory). Recorded when the link is made;
// links made before this column read it from the receiver's first stock leg instead (cycleBreakEvenQueries.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_share_sources", (table) => {
    table.integer("shares_received").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_share_sources", (table) => {
    table.dropColumn("shares_received");
  });
}
