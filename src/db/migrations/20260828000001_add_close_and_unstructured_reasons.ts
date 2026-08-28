import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.text("close_reason").nullable();
    table.text("unstructured_reason").nullable();
  });

  await knex.schema.createTable("platform_anomalies", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("anomaly_type").notNullable();
    table.uuid("position_id").references("id").inTable("positions").nullable();
    table.uuid("order_request_id").references("id").inTable("order_requests").nullable();
    table.text("detail").nullable();
    table.timestamp("detected_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable("platform_anomalies", (table) => {
    table.index(["detected_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("platform_anomalies");
  await knex.schema.alterTable("positions", (table) => {
    table.dropColumn("close_reason");
    table.dropColumn("unstructured_reason");
  });
}
