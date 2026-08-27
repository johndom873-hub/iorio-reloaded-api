// Backs Genosuke's save_preference/forget_preference tools (see
// lowStakesWriteTools.ts) — a normal authenticated route like every other
// tool hits, not a direct DB call from chat.ts, so this rides the same
// service-user session/validation path as everything else Genosuke touches.
import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const genosukePreferencesRouter = Router();
genosukePreferencesRouter.use(requireAuth);

function serialize(row: { id: string; content: string; created_at: string }) {
  return { id: row.id, content: row.content, createdAt: row.created_at };
}

genosukePreferencesRouter.get("/", async (_request, response) => {
  const rows = await db("genosuke_preferences").orderBy("created_at", "asc");
  response.json(rows.map(serialize));
});

genosukePreferencesRouter.post("/", async (request, response) => {
  const { content } = request.body as { content?: string };
  if (!content || !content.trim()) {
    response.status(400).json({ error: "Content is required." });
    return;
  }

  const [row] = await db("genosuke_preferences").insert({ content: content.trim() }).returning("*");
  response.status(201).json(serialize(row));
});

genosukePreferencesRouter.delete("/:id", async (request, response) => {
  const deletedCount = await db("genosuke_preferences").where({ id: request.params.id }).del();
  if (deletedCount === 0) {
    response.status(404).json({ error: "Preference not found." });
    return;
  }
  response.status(204).end();
});
