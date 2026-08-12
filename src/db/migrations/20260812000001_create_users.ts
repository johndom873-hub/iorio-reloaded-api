import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("users", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("username").notNullable();
    table.text("display_name").notNullable();
    table.text("password_hash").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // Case-insensitive uniqueness: "Marce" and "marce" must not both be creatable.
  await knex.raw("create unique index users_username_lower_unique on users (lower(username))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("users");
}
