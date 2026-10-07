import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Audit (G3, 2026-10-07): the Event log's categories and recordPlutoEvent against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Pluto ledger audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
const publishNotification = vi.fn(async () => {});
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const { plutoEventCategories, plutoEventCategoryByType, plutoEventTypesInCategories, recordPlutoEvent } = await import("./ledger.js");
const testDb: Knex = db;
const createdEventIds: number[] = [];

afterAll(async () => {
  if (createdEventIds.length > 0) await testDb("pluto_events").whereIn("id", createdEventIds).del();
  await testDb.destroy();
});

/** Every type any production file passes to recordPlutoEvent, read from the source (string literals only). */
function eventTypesRecordedInSource(): Set<string> {
  const sourceRoot = join(import.meta.dirname, "..");
  const types = new Set<string>();
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/recordPlutoEvent\(\s*([^,)]+)/g)) {
          for (const literal of match[1]!.matchAll(/"([a-z_]+)"/g)) types.add(literal[1]!);
        }
      }
    }
  };
  walk(sourceRoot);
  return types;
}

describe("plutoEventCategoryByType (audit)", () => {
  it("gives every type recorded anywhere in the code a category", () => {
    const recorded = eventTypesRecordedInSource();
    expect(recorded.size).toBeGreaterThan(20);
    const missing = [...recorded].filter((type) => !(type in plutoEventCategoryByType));
    expect(missing).toEqual([]);
  });

  it("maps every type to one of the declared categories, and every category has at least one type", () => {
    for (const category of Object.values(plutoEventCategoryByType)) expect(plutoEventCategories).toContain(category);
    for (const category of plutoEventCategories) expect(plutoEventTypesInCategories([category]).length).toBeGreaterThan(0);
  });

  it("places the types the PROGRESS entry names where it says", () => {
    expect(plutoEventCategoryByType.pass_started).toBe("info");
    expect(plutoEventCategoryByType.pass_skipped).toBe("info");
    expect(plutoEventCategoryByType.session_schedule).toBe("system");
    expect(plutoEventCategoryByType.warning).toBe("system");
    expect(plutoEventCategoryByType.lines_changed).toBe("system");
    expect(plutoEventCategoryByType.readiness_check).toBe("system");
  });
});

describe("plutoEventTypesInCategories (audit)", () => {
  it("returns nothing for no categories and every type for all of them, with no type in two categories", () => {
    expect(plutoEventTypesInCategories([])).toEqual([]);
    const all = plutoEventTypesInCategories([...plutoEventCategories]);
    expect(new Set(all).size).toBe(Object.keys(plutoEventCategoryByType).length);
    const perCategory = plutoEventCategories.flatMap((category) => plutoEventTypesInCategories([category]));
    expect(perCategory.length).toBe(all.length);
  });

  it("ignores a category it does not know instead of throwing", () => {
    expect(plutoEventTypesInCategories(["bogus" as never])).toEqual([]);
  });
});

describe("recordPlutoEvent (audit)", () => {
  it("stores the payload and publishes the stored row's id, type and time", async () => {
    publishNotification.mockClear();
    const marker = `audit-g3-${Date.now()}`;
    await recordPlutoEvent("warning", { message: marker, nested: { b: 2, a: 1 } });
    const row = await testDb("pluto_events").whereRaw("payload->>'message' = ?", [marker]).first();
    expect(row).toBeTruthy();
    createdEventIds.push(Number(row.id));
    expect(row.type).toBe("warning");
    expect(row.payload).toEqual({ message: marker, nested: { a: 1, b: 2 } });
    expect(publishNotification).toHaveBeenCalledTimes(1);
    const [notification] = publishNotification.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(notification).toMatchObject({ type: "pluto_event", eventId: Number(row.id), eventType: "warning", occurredAt: new Date(row.occurred_at).toISOString() });
  });

  it("stores {} when no payload is given, so the event applies to every ticker", async () => {
    publishNotification.mockClear();
    const before = await testDb("pluto_events").max("id as id").first();
    await recordPlutoEvent("agent_stopped");
    const row = await testDb("pluto_events").where("id", ">", Number(before?.id ?? 0)).where({ type: "agent_stopped" }).orderBy("id", "desc").first();
    createdEventIds.push(Number(row.id));
    expect(row.payload).toEqual({});
  });
});
