import type { Knex } from "knex";

// One row per release whose release phase backed up the database before running migrations
// (scripts/run-release-phase.ts), written after the release succeeds. Says which Heroku backup
// holds the database exactly as it was before that release's migrations.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("release_backups", (table) => {
    table.increments("id").primary();
    table.text("heroku_release_version").nullable();
    table.text("slug_commit").nullable();
    table.text("backup_name").notNullable();
    table.text("backup_transfer_uuid").notNullable();
    table.timestamp("backup_finished_at", { useTz: true }).notNullable();
    table.text("latest_migration_before").nullable();
    table.jsonb("migrations_applied").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("release_backups");
}
