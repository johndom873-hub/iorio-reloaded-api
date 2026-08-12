import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("position_legs", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_id").notNullable().references("id").inTable("positions");
    table.enu("leg_type", ["stock", "option"], { useNative: false, enumName: "position_leg_type" }).notNullable();
    table.enu("side", ["long", "short"], { useNative: false, enumName: "position_leg_side" }).notNullable();
    table.integer("quantity").notNullable();
    table.enu("option_type", ["call", "put"], { useNative: false, enumName: "position_leg_option_type" });
    table.decimal("strike_price", 12, 4);
    table.date("expiry_date");
    // Contract multiplier — not always 100 (adjusted contracts after
    // splits/special dividends can differ). Getting this wrong silently
    // corrupts P&L math, so it's required, not optional.
    table.integer("multiplier").notNullable().defaultTo(100);
    table.text("ibkr_contract_id");
    table.decimal("entry_price", 12, 4).notNullable();
    table.timestamp("entry_at", { useTz: true }).notNullable();
    table.decimal("exit_price", 12, 4);
    table.timestamp("exit_at", { useTz: true });

    table.index(["position_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("position_legs");
}
