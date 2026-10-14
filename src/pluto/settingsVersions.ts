import type { Knex } from "knex";
import { db } from "../db/connection.js";

// The Pluto settings a pass ran with, stored once per distinct set: passes point at a version
// instead of each carrying a copy. Keyed by Postgres's sha256 of the jsonb text, which is
// canonical (key order normalised), the same hash the 20261014100001 backfill used.

const contentHashSql = "encode(sha256(convert_to((?::jsonb)::text, 'UTF8')), 'hex')";

export async function ensurePlutoSettingsVersion(settings: unknown, connection: Knex = db): Promise<string> {
  const settingsJson = JSON.stringify(settings);
  const existing = await connection("pluto_settings_versions").whereRaw(`content_hash = ${contentHashSql}`, [settingsJson]).first("id");
  if (existing) return existing.id as string;
  await connection.raw(`insert into pluto_settings_versions (content_hash, settings) values (${contentHashSql}, ?::jsonb) on conflict (content_hash) do nothing`, [settingsJson, settingsJson]);
  const row = await connection("pluto_settings_versions").whereRaw(`content_hash = ${contentHashSql}`, [settingsJson]).first("id");
  return row!.id as string;
}
