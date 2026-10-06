import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { errorHandler } from "../middleware/errorHandler.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real genosukePreferencesRouter on a small express app against the test database. The table is shared with other files, so every
// row this file creates carries a unique tag and only those rows are read back and cleaned up.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run Genosuke preferences route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { genosukePreferencesRouter } = await import("./genosukePreferences.js");

const testDb: Knex = db;

const contentTag = `preference-route-${Date.now()}`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/genosuke-preferences", genosukePreferencesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("genosuke_preferences").where("content", "like", `%${contentTag}%`).del();
  await testDb.destroy();
});

async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? "user-1" : options.asUser;
  const response = await fetch(`${baseUrl}/genosuke-preferences${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  return { status: response.status, json: text && isJson ? (JSON.parse(text) as any) : null };
}

const storedRowsWithTag = () => testDb("genosuke_preferences").where("content", "like", `%${contentTag}%`).orderBy("created_at", "asc");
const withoutConsoleErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await run();
  } finally {
    consoleErrorSpy.mockRestore();
  }
};

describe("auth", () => {
  it("refuses every route without a session and changes nothing", async () => {
    const [createdRow] = await testDb("genosuke_preferences").insert({ content: `auth ${contentTag}` }).returning("id");

    expect(await call("GET", "", undefined, { asUser: null })).toEqual({ status: 401, json: { error: "Not logged in." } });
    expect((await call("POST", "", { content: `refused ${contentTag}` }, { asUser: null })).status).toBe(401);
    expect((await call("DELETE", `/${createdRow.id}`, undefined, { asUser: null })).status).toBe(401);

    expect((await storedRowsWithTag()).map((row) => row.content)).toEqual([`auth ${contentTag}`]);
    await testDb("genosuke_preferences").where({ id: createdRow.id }).del();
  });
});

describe("POST /genosuke-preferences", () => {
  it("stores the preference and answers 201 with its id, content and creation time", async () => {
    const response = await call("POST", "", { content: `Prefer weekly expiries ${contentTag}` });

    expect(response.status).toBe(201);
    expect(response.json).toEqual({ id: expect.any(String), content: `Prefer weekly expiries ${contentTag}`, createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
    const stored = await testDb("genosuke_preferences").where({ id: response.json.id }).first();
    expect(stored.content).toBe(`Prefer weekly expiries ${contentTag}`);
    expect(stored.created_at.toISOString()).toBe(response.json.createdAt);
  });

  it("trims the edges of the content but keeps what is inside, line breaks included", async () => {
    const response = await call("POST", "", { content: `  \n First line\n\n  second   line ${contentTag}  \t` });
    expect(response.json.content).toBe(`First line\n\n  second   line ${contentTag}`);
    expect((await testDb("genosuke_preferences").where({ id: response.json.id }).first()).content).toBe(`First line\n\n  second   line ${contentTag}`);
  });

  it("stores the same text twice as two rows (no uniqueness rule)", async () => {
    const first = await call("POST", "", { content: `same ${contentTag}` });
    const second = await call("POST", "", { content: `same ${contentTag}` });
    expect(first.json.id).not.toBe(second.json.id);
    expect((await storedRowsWithTag()).filter((row) => row.content === `same ${contentTag}`)).toHaveLength(2);
  });

  it.each([
    ["an empty body object", {}],
    ["no content", { notContent: "x" }],
    ["an empty string", { content: "" }],
    ["whitespace only", { content: " \n\t " }],
    ["null", { content: null }],
  ])("%s is a 400 with nothing stored", async (_label, body) => {
    const rowsBefore = await storedRowsWithTag();
    expect(await call("POST", "", body)).toEqual({ status: 400, json: { error: "Content is required." } });
    expect(await storedRowsWithTag()).toEqual(rowsBefore);
  });

  it("content that is not text is a 400 and nothing is stored", async () => {
    const rowsBefore = await storedRowsWithTag();
    for (const content of [5, ["a"], { text: "x" }, true]) {
      const response = await call("POST", "", { content });
      expect(response.status, JSON.stringify(content)).toBe(400);
      expect(response.json).toEqual({ error: "Content is required." });
    }
    expect(await storedRowsWithTag()).toEqual(rowsBefore);
  });

  it("a request with no body at all is a 400", async () => {
    const response = await call("POST", "");
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: "Content is required." });
  });
});

describe("GET /genosuke-preferences", () => {
  it("lists the preferences oldest first, each as id, content and createdAt", async () => {
    const created: string[] = [];
    for (const label of ["first", "second", "third"]) created.push((await call("POST", "", { content: `${label} listed ${contentTag}` })).json.id);

    const response = await call("GET", "");

    expect(response.status).toBe(200);
    const mine = (response.json as { id: string; content: string; createdAt: string }[]).filter((preference) => preference.content.endsWith(`listed ${contentTag}`));
    expect(mine.map((preference) => preference.content)).toEqual([`first listed ${contentTag}`, `second listed ${contentTag}`, `third listed ${contentTag}`]);
    expect(mine.map((preference) => preference.id)).toEqual(created);
    expect(Object.keys(mine[0]!).sort()).toEqual(["content", "createdAt", "id"]);
    const instants = mine.map((preference) => Date.parse(preference.createdAt));
    expect([...instants].sort((a, b) => a - b)).toEqual(instants);
  });

  it("is a JSON array", async () => {
    expect(Array.isArray((await call("GET", "")).json)).toBe(true);
  });
});

describe("DELETE /genosuke-preferences/:id", () => {
  it("removes the preference, answers 204 with no body, and only that row", async () => {
    const keep = (await call("POST", "", { content: `keep ${contentTag}` })).json.id;
    const drop = (await call("POST", "", { content: `drop ${contentTag}` })).json.id;

    expect(await call("DELETE", `/${drop}`)).toEqual({ status: 204, json: null });

    expect(await testDb("genosuke_preferences").where({ id: drop }).first()).toBeUndefined();
    expect(await testDb("genosuke_preferences").where({ id: keep }).first()).toBeDefined();
    expect((await call("GET", "")).json.some((preference: { id: string }) => preference.id === drop)).toBe(false);
  });

  it("deleting the same preference again is a 404", async () => {
    const id = (await call("POST", "", { content: `twice ${contentTag}` })).json.id;
    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    expect(await call("DELETE", `/${id}`)).toEqual({ status: 404, json: { error: "Preference not found." } });
  });

  it("an id that matches nothing is a 404", async () => {
    expect(await call("DELETE", "/00000000-0000-4000-8000-000000000000")).toEqual({ status: 404, json: { error: "Preference not found." } });
  });

  it("an id that is not a uuid is a 404 through the app's error handler, not a server error", async () => {
    await withoutConsoleErrors(async () => {
      expect(await call("DELETE", "/not-a-uuid")).toEqual({ status: 404, json: { error: "Not found." } });
    });
  });
});
