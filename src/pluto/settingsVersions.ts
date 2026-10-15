import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "./settingsStore.js";

// The Pluto settings a pass ran with, stored once per distinct set: passes point at a version
// instead of each carrying a copy. Keyed by Postgres's sha256 of the jsonb text, which is
// canonical (key order normalised), the same hash the 20261014100001 backfill used.

const contentHashSql = "encode(sha256(convert_to((?::jsonb)::text, 'UTF8')), 'hex')";

export interface PlutoSettingsVersionView {
  versionId: string;
  /** 1 for the first set of settings ever stored, counting in the order sets were first stored (a set used again keeps its number). */
  number: number;
  /** When Pluto's settings last changed; null when they never were. */
  since: string | null;
}

export async function ensurePlutoSettingsVersion(settings: unknown, connection: Knex = db): Promise<string> {
  const settingsJson = JSON.stringify(settings);
  const existing = await connection("pluto_settings_versions").whereRaw(`content_hash = ${contentHashSql}`, [settingsJson]).first("id");
  if (existing) return existing.id as string;
  await connection.raw(`insert into pluto_settings_versions (content_hash, settings) values (${contentHashSql}, ?::jsonb) on conflict (content_hash) do nothing`, [settingsJson, settingsJson]);
  const row = await connection("pluto_settings_versions").whereRaw(`content_hash = ${contentHashSql}`, [settingsJson]).first("id");
  return row!.id as string;
}

/** The version the current settings are (stored now if new), numbered by when each version was first stored. */
export async function loadCurrentPlutoSettingsVersion(connection: Knex = db): Promise<PlutoSettingsVersionView> {
  const settings = await loadPlutoSettings(connection);
  const versionId = await ensurePlutoSettingsVersion(settings, connection);
  const counted = (await connection.raw("select count(*)::int as number from pluto_settings_versions where created_at <= (select created_at from pluto_settings_versions where id = ?)", [versionId])).rows as { number: number }[];
  const number = counted[0]?.number ?? 1;
  const row: { updated_at: Date | null } | undefined = await connection("pluto_settings").where({ id: 1 }).first("updated_at");
  return { versionId, number, since: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
}
