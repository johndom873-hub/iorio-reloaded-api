import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { db } from "../db/connection.js";

// The exact system prompt behind every decision, stored once per distinct text so a replay months
// later pairs each recorded payload with the instructions it was actually judged under.

export function promptContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function ensurePlutoPrompt(version: string, content: string, connection: Knex = db): Promise<string> {
  const contentHash = promptContentHash(content);
  const existing = await connection("pluto_prompts").where({ content_hash: contentHash }).first("id");
  if (existing) return existing.id as string;
  await connection("pluto_prompts").insert({ version, content_hash: contentHash, content }).onConflict("content_hash").ignore();
  const row = await connection("pluto_prompts").where({ content_hash: contentHash }).first("id");
  return row!.id as string;
}

export async function loadPlutoPrompt(promptId: string, connection: Knex = db): Promise<{ id: string; version: string; content: string } | null> {
  const row = await connection("pluto_prompts").where({ id: promptId }).first("id", "version", "content");
  return row ? { id: row.id, version: row.version, content: row.content } : null;
}
