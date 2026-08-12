import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("trades", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_leg_id").notNullable().references("id").inTable("position_legs");
    table.text("ibkr_order_id");
    // Unique per IBKR execution — lets the daily sync job safely re-run
    // without creating duplicate trade records.
    table.text("ibkr_exec_id").unique();
    table.enu("side", ["buy", "sell"], { useNative: false }).notNullable();
    table.integer("quantity").notNullable();
    table.decimal("price", 12, 4).notNullable();
    table.decimal("commission", 12, 4);
    // Sourced from IBKR's CommissionReport.realizedPNL, not computed by us.
    table.decimal("realized_pnl", 14, 4);
    table.timestamp("executed_at", { useTz: true }).notNullable();
    table.jsonb("raw_ibkr_payload");

    table.index(["position_leg_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("trades");
}
