import type { Knex } from "knex";

// Schema required by connect-pg-simple (the express-session store).
// See: https://github.com/voxpelli/node-connect-pg-simple#table-structure
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("session", (table) => {
    table.string("sid").notNullable().primary();
    table.json("sess").notNullable();
    table.specificType("expire", "timestamp(6)").notNullable();
  });

  await knex.raw(`CREATE INDEX "session_expire_idx" ON "session" ("expire")`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("session");
}
