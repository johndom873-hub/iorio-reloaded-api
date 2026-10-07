import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Audit (G3, 2026-10-07): GET /pluto/events filters, ticker trace, paging and session edges against the test database.
// Fixtures live on Eastern sessions in 2097 only, so they never collide with pluto.test.ts (2098/2099) or real rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run Pluto route audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
// The dev .env carries live Telegram credentials: nothing here may reach Telegram.
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("./pluto.js");
const testDb: Knex = db;

const fixtureRangeStart = "2097-07-01T00:00:00Z";
const fixtureRangeEnd = "2097-12-01T00:00:00Z";
// 2097-07-15 is a Monday in EDT (UTC-4): the Eastern day runs 04:00Z to 04:00Z the next day.
const traceSession = "2097-07-15";
const passBoth = `audit-g3-pass-both-${Date.now()}`;
const passOther = `audit-g3-pass-other-${Date.now()}`;

let server: Server;
let baseUrl: string;
let userId: string;
const ids: Record<string, number> = {};

async function insertEvent(key: string, occurredAt: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const [row] = await testDb("pluto_events").insert({ occurred_at: occurredAt, type, payload: JSON.stringify(payload) }).returning("id");
  ids[key] = Number(row.id);
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pluto-audit-g3-${Date.now()}`, display_name: "Pluto Audit G3", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  await testDb("pluto_events").whereBetween("occurred_at", [fixtureRangeStart, fixtureRangeEnd]).del();
  // One round over two tickers (an opening look names every enabled ticker), with an action on the second one.
  await insertEvent("passBothStarted", "2097-07-15T14:00:00Z", "pass_started", { passId: passBoth, trigger: "opening_look", symbols: ["AUDA", "AUDB"] });
  await insertEvent("passBothModel", "2097-07-15T14:01:00Z", "model_called", { passId: passBoth, verdict: "trade" });
  await insertEvent("passBothAudbValidated", "2097-07-15T14:02:00Z", "action_validated", { passId: passBoth, actionId: "a-1", symbol: "AUDB", candidateId: "AUDB:open:1" });
  await insertEvent("audbOrderOutcome", "2097-07-15T14:03:00Z", "order_outcome", { actionId: "a-1", symbol: "AUDB", outcome: "filled" });
  // A round over a third ticker that found nothing eligible; its block text contains the letters "BE" ("beyond").
  await insertEvent("passOtherStarted", "2097-07-15T14:04:00Z", "pass_started", { passId: passOther, trigger: "day_signals_update", symbols: ["AUDC"] });
  await insertEvent("passOtherSkipped", "2097-07-15T14:05:00Z", "pass_skipped", { passId: passOther, reason: "nothing eligible", tickers: [{ symbol: "AUDC", blocks: ["day change 5.0% is 3.20× its normal 1.50% day, beyond 3×"], rejected: 0 }] });
  // Applies to every ticker: no ticker key, no pass.
  await insertEvent("pausedAll", "2097-07-15T14:06:00Z", "paused", { by: "Marce" });
  // A type the category map does not know (an old or renamed type): shown as "system".
  await insertEvent("legacyType", "2097-07-15T14:07:00Z", "audit_g3_legacy_type", {});

  // Five events with the same instant, for paging ties.
  for (let index = 0; index < 5; index++) await insertEvent(`tie${index}`, "2097-07-16T15:00:00Z", "audit_g3_tie", { index });

  // 2097-11-03 is the first Sunday of November: EDT ends, the Eastern day runs 04:00Z to 05:00Z the next day (25 hours).
  await insertEvent("dstBefore", "2097-11-03T03:59:00Z", "audit_g3_dst", { at: "23:59 EDT Nov 2" });
  await insertEvent("dstFirst", "2097-11-03T04:00:00Z", "audit_g3_dst", { at: "00:00 EDT Nov 3" });
  await insertEvent("dstLast", "2097-11-04T04:59:00Z", "audit_g3_dst", { at: "23:59 EST Nov 3" });
  await insertEvent("dstAfter", "2097-11-04T05:00:00Z", "audit_g3_dst", { at: "00:00 EST Nov 4" });

  const app = express();
  app.use((request, _response, next) => {
    (request as unknown as { session: { userId?: string } }).session = { userId };
    next();
  });
  app.use("/pluto", plutoRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("pluto_events").whereBetween("occurred_at", [fixtureRangeStart, fixtureRangeEnd]).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}/pluto${path}`);
  return { status: response.status, json: (await response.json()) as any };
}

const idsOf = (json: any): number[] => json.events.map((event: any) => event.id);

describe("GET /pluto/events ticker trace (audit)", () => {
  it("includes the ticker's own pass, the model's call in it, and events for every ticker", async () => {
    const { json } = await get(`/events?session=${traceSession}&ticker=AUDA`);
    const found = idsOf(json);
    expect(found).toContain(ids.passBothStarted);
    expect(found).toContain(ids.passBothModel);
    expect(found).toContain(ids.pausedAll);
    expect(found).not.toContain(ids.passOtherStarted);
    expect(found).not.toContain(ids.passOtherSkipped);
  });

  it("does not put another ticker's action into a ticker's trace just because they shared a round", async () => {
    // AUDB's action_validated names AUDB; it belongs to the AUDA/AUDB round, but it is not part of AUDA's story.
    const { json } = await get(`/events?session=${traceSession}&ticker=AUDA`);
    expect(idsOf(json)).not.toContain(ids.passBothAudbValidated);
  });

  it("matches a ticker by its name, not by letters that happen to appear in an event's text", async () => {
    // Ticker BE (on the real shortlist): AUDC's skipped round says "beyond 3×" in its block text, which LIKE '%BE%' matches.
    const { json } = await get(`/events?session=${traceSession}&ticker=BE`);
    expect(idsOf(json)).not.toContain(ids.passOtherSkipped);
    expect(idsOf(json).sort()).toEqual([ids.pausedAll, ids.legacyType].sort());
  });

  it("matches a ticker exactly, not as a prefix of a longer symbol", async () => {
    // "AUD" is not a symbol here: none of AUDA / AUDB / AUDC's events belong to it.
    const { json } = await get(`/events?session=${traceSession}&ticker=AUD`);
    expect(idsOf(json).sort()).toEqual([ids.pausedAll, ids.legacyType].sort());
  });

  it("flags only events with no ticker or pass key as applying to every ticker", async () => {
    const { json } = await get(`/events?session=${traceSession}`);
    const flagged = json.events.filter((event: any) => event.appliesToAllTickers).map((event: any) => event.id);
    expect(flagged.sort()).toEqual([ids.pausedAll, ids.legacyType].sort());
    // An order outcome names its ticker and no pass: it is AUDB's, not every ticker's.
    expect(json.events.find((event: any) => event.id === ids.audbOrderOutcome).appliesToAllTickers).toBe(false);
  });

  it("finds an order outcome (no pass key) by the ticker it names", async () => {
    const { json } = await get(`/events?session=${traceSession}&ticker=audb`);
    expect(idsOf(json)).toContain(ids.audbOrderOutcome);
    expect(idsOf(json)).toContain(ids.passBothAudbValidated);
  });
});

describe("GET /pluto/events categories (audit)", () => {
  it("shows an unknown type as system, and keeps it when the System category is chosen", async () => {
    const all = await get(`/events?session=${traceSession}&types=audit_g3_legacy_type`);
    expect(all.json.events.map((event: any) => event.category)).toEqual(["system"]);
    // The screen always sends categories: a row it labels "System" must not vanish when System is ticked.
    const system = await get(`/events?session=${traceSession}&categories=system&types=audit_g3_legacy_type`);
    expect(system.json.total).toBe(1);
  });

  it("combines categories, types and excludeTypes as an intersection", async () => {
    const { json } = await get(`/events?session=${traceSession}&categories=info,trading&excludeTypes=pass_started`);
    expect(json.events.map((event: any) => event.type).sort()).toEqual(["action_validated", "order_outcome", "pass_skipped"]);
    expect(json.total).toBe(3);
  });
});

describe("GET /pluto/events paging (audit)", () => {
  it("pages through events sharing one instant without repeating or dropping any (id breaks the tie)", async () => {
    const pages = await Promise.all([0, 2, 4].map((offset) => get(`/events?session=2097-07-16&types=audit_g3_tie&limit=2&offset=${offset}`)));
    const seen = pages.flatMap((page) => idsOf(page.json));
    expect(seen).toEqual([ids.tie4, ids.tie3, ids.tie2, ids.tie1, ids.tie0]);
    for (const page of pages) expect(page.json.total).toBe(5);
  });

  it("returns an empty page past the end, still with the full total", async () => {
    const { json } = await get(`/events?session=2097-07-16&types=audit_g3_tie&limit=2&offset=50`);
    expect(json).toEqual({ events: [], total: 5 });
  });

  it("treats a negative or non-numeric offset as 0, and caps limit at 500", async () => {
    const negative = await get(`/events?session=2097-07-16&types=audit_g3_tie&limit=1&offset=-3`);
    expect(idsOf(negative.json)).toEqual([ids.tie4]);
    const junk = await get(`/events?session=2097-07-16&types=audit_g3_tie&limit=1&offset=abc`);
    expect(idsOf(junk.json)).toEqual([ids.tie4]);
    const huge = await get(`/events?session=2097-07-16&types=audit_g3_tie&limit=100000`);
    expect(huge.json.events).toHaveLength(5);
  });
});

describe("GET /pluto/events session (audit)", () => {
  it("covers the whole 25-hour Eastern day when daylight saving time ends", async () => {
    const { json } = await get(`/events?session=2097-11-03&types=audit_g3_dst`);
    expect(idsOf(json)).toEqual([ids.dstLast, ids.dstFirst]);
    const before = await get(`/events?session=2097-11-02&types=audit_g3_dst`);
    expect(idsOf(before.json)).toEqual([ids.dstBefore]);
    const after = await get(`/events?session=2097-11-04&types=audit_g3_dst`);
    expect(idsOf(after.json)).toEqual([ids.dstAfter]);
  });

  it("rejects dates that roll over and dates without leading zeros; an empty session means all sessions", async () => {
    expect((await get("/events?session=2097-02-30")).status).toBe(400);
    expect((await get("/events?session=2097-04-31")).status).toBe(400);
    expect((await get("/events?session=2097-7-15")).status).toBe(400);
    const empty = await get("/events?session=&types=audit_g3_dst");
    expect(empty.status).toBe(200);
    expect(empty.json.total).toBe(4);
  });

  it("accepts 29 February only in a leap year", async () => {
    expect((await get("/events?session=2096-02-29&types=audit_g3_dst")).status).toBe(200);
    expect((await get("/events?session=2097-02-29&types=audit_g3_dst")).status).toBe(400);
  });
});
