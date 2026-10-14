import type { Knex } from "knex";

// Every distinct set of Pluto settings, stored once: a pass points at the version it ran with
// instead of carrying its own copy. The hash is Postgres's own sha256 of the jsonb text, which is
// canonical (key order normalised), so the backfill here and ensurePlutoSettingsVersion agree.
//
// settings_snapshot stays for one release: an agent dyno still running the old code during the
// release phase keeps writing it. The copied snapshots are cleared here; the next migration maps
// any written during the release window and drops the column.
const contentHashOf = (jsonbExpression: string) => `encode(sha256(convert_to((${jsonbExpression})::text, 'UTF8')), 'hex')`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pluto_settings_versions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("content_hash").notNullable().unique();
    table.jsonb("settings").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.uuid("settings_version_id").nullable().references("id").inTable("pluto_settings_versions");
  });
  await knex.raw(`
    insert into pluto_settings_versions (content_hash, settings, created_at)
    select ${contentHashOf("settings_snapshot")}, settings_snapshot, min(started_at)
    from pluto_passes
    where settings_snapshot is not null
    group by settings_snapshot
  `);
  await knex.raw(`
    update pluto_passes p
    set settings_version_id = v.id, settings_snapshot = null
    from pluto_settings_versions v
    where p.settings_snapshot is not null and v.settings = p.settings_snapshot
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    update pluto_passes p
    set settings_snapshot = v.settings
    from pluto_settings_versions v
    where p.settings_version_id = v.id
  `);
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.dropColumn("settings_version_id");
  });
  await knex.schema.dropTable("pluto_settings_versions");
}
