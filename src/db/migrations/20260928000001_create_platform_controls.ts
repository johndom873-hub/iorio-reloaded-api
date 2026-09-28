import type { Knex } from "knex";

// Platform-wide operator switches, one row per key (design agreed 2026-09-28,
// gap fix 1 ahead of the Pluto agent). The first key is `trading_halt`: the
// kill switch that stops EVERY order origin (web UI, Genosuke, Pluto) from
// reaching IBKR — enforced at order confirm (409) and again inside the VPS
// worker immediately before placeOrder, so a halt flipped while an order is
// already confirmed still stops it. Cancels are never blocked by it.
// Additive only (release-phase rule); the seed row makes reads unconditional.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("platform_controls", (table) => {
    table.text("key").primary();
    table.boolean("enabled").notNullable().defaultTo(false);
    table.text("reason");
    table.uuid("set_by_user_id").references("id").inTable("users").onDelete("SET NULL");
    table.timestamp("set_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex("platform_controls").insert({ key: "trading_halt", enabled: false });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("platform_controls");
}
