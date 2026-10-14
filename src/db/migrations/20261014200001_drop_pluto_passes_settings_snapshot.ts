import type { Knex } from "knex";

// Second half of 20261014100001: a pass written by the previous agent during that release still
// carries its own settings copy; it gets its version here, then the column goes.
const contentHashOf = (jsonbExpression: string) => `encode(sha256(convert_to((${jsonbExpression})::text, 'UTF8')), 'hex')`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    insert into pluto_settings_versions (content_hash, settings, created_at)
    select ${contentHashOf("settings_snapshot")}, settings_snapshot, min(started_at)
    from pluto_passes
    where settings_snapshot is not null
    group by settings_snapshot
    on conflict (content_hash) do nothing
  `);
  await knex.raw(`
    update pluto_passes p
    set settings_version_id = v.id
    from pluto_settings_versions v
    where p.settings_snapshot is not null and p.settings_version_id is null and v.settings = p.settings_snapshot
  `);
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.dropColumn("settings_snapshot");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_passes", (table) => {
    table.jsonb("settings_snapshot").nullable();
  });
}
