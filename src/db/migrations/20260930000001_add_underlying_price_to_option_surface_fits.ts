import type { Knex } from "knex";

// The underlying price each slice's forward is anchored to (the quotes' median underlying, else the
// snapshot spot). Live scoring rescales the stored forward by liveSpot / this price; null on fits made
// before this column existed, whose forward was built from the snapshot spot.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_surface_fits", (table) => {
    table.decimal("underlying_price", 14, 4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("option_surface_fits", (table) => {
    table.dropColumn("underlying_price");
  });
}
