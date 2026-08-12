import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("users", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("email").notNullable().unique();
    table.text("display_name").notNullable();
    table.text("password_hash").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("users");
}
