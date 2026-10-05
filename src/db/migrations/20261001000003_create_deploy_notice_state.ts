import type { Knex } from "knex";

// The release identity each service last announced on Telegram at start-up, so the next start can say whether it
// is a new deploy, a release with the same code (config change) or a plain restart. One row per service
// ("API" today); in Postgres rather than process memory because a restart is exactly what wipes memory.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("deploy_notice_state", (table) => {
    table.text("subject").primary();
    table.text("release_version").notNullable();
    table.text("commit_sha").notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("deploy_notice_state");
}
