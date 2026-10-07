import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real plutoRouter on a small express app against the test database; only the list filters the Live tab relies on.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run Pluto route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("./pluto.js");

const testDb: Knex = db;
const testTrigger = "pluto_route_test";
// Far in the future so these rows are always the newest, whatever else the shared test database holds.
const farFuture = (minute: number) => new Date(Date.UTC(2099, 0, 1, 0, minute)).toISOString();
const zzPassId = `pluto-route-test-pass-${Date.now()}`;

let server: Server;
let baseUrl: string;
let userId: string;

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pluto-route-${Date.now()}`, display_name: "Pluto Route Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  await testDb("pluto_passes").insert([
    { started_at: farFuture(1), trigger: testTrigger, model_called: true },
    { started_at: farFuture(2), trigger: testTrigger, model_called: false },
    { started_at: farFuture(3), trigger: testTrigger, model_called: false },
  ]);
  await testDb("pluto_events").insert([
    { occurred_at: farFuture(1), type: "route_test_meaningful", payload: {} },
    { occurred_at: farFuture(2), type: "route_test_routine", payload: {} },
    { occurred_at: farFuture(3), type: "route_test_noise", payload: {} },
    // One Eastern session (2099-03-05, EST = UTC-5), newest last; the last two sit either side of its midnight.
    { occurred_at: "2099-03-05T12:00:00Z", type: "ticker_enabled", payload: { symbol: "ZZTA", by: "tester" } },
    { occurred_at: "2099-03-05T12:01:00Z", type: "ticker_enabled", payload: { symbol: "ZZTB", by: "tester" } },
    { occurred_at: "2099-03-05T12:02:00Z", type: "pass_started", payload: { passId: zzPassId, symbols: ["ZZTA", "ZZTB"] } },
    { occurred_at: "2099-03-05T12:03:00Z", type: "pass_skipped", payload: { tickers: ["ZZTC"] } },
    // The model's call names no ticker; it belongs to the ZZTA/ZZTB pass.
    { occurred_at: "2099-03-05T12:04:00Z", type: "model_called", payload: { passId: zzPassId } },
    { occurred_at: "2099-03-05T12:05:00Z", type: "paused", payload: {} },
    { occurred_at: "2099-03-06T04:59:00Z", type: "resumed", payload: {} },
    { occurred_at: "2099-03-06T05:01:00Z", type: "resumed", payload: {} },
  ]);

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
  await testDb("pluto_passes").where({ trigger: testTrigger }).del();
  await testDb("pluto_events").whereLike("type", "route_test_%").del();
  await testDb("pluto_events").whereBetween("occurred_at", ["2099-03-05T00:00:00Z", "2099-03-07T00:00:00Z"]).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}/pluto${path}`, { headers: { "x-test-user-id": userId } });
  return { status: response.status, json: (await response.json()) as any };
}

describe("GET /pluto/passes", () => {
  it("returns the newest passes of any kind by default", async () => {
    const { status, json } = await get("/passes?limit=3");
    expect(status).toBe(200);
    expect(json.map((pass: any) => pass.modelCalled)).toEqual([false, false, true]);
  });

  it("skips passes that never asked the model when modelCalled=true, however many newer ones there are", async () => {
    const { json } = await get("/passes?modelCalled=true&limit=1");
    expect(json).toHaveLength(1);
    expect(json[0].modelCalled).toBe(true);
    expect(json[0].trigger).toBe(testTrigger);
  });
});

describe("GET /pluto/events", () => {
  it("returns every event type by default, newest first, each with its category", async () => {
    const { json } = await get("/events?limit=3&session=2098-12-31");
    expect(json.events.map((event: any) => event.type)).toEqual(["route_test_noise", "route_test_routine", "route_test_meaningful"]);
    expect(json.events[0].category).toBe("system");
  });

  it("leaves out the types named in excludeTypes in the query, so the limit applies to what is kept", async () => {
    const { json } = await get("/events?limit=1&session=2098-12-31&excludeTypes=route_test_noise,route_test_routine");
    expect(json.events.map((event: any) => event.type)).toEqual(["route_test_meaningful"]);
  });

  it("keeps only the types named in types, newest first", async () => {
    const { json } = await get("/events?session=2098-12-31&types=route_test_meaningful,route_test_noise");
    expect(json.events.map((event: any) => event.type)).toEqual(["route_test_noise", "route_test_meaningful"]);
  });

  it("ignores an empty excludeTypes", async () => {
    const { json } = await get("/events?limit=1&session=2098-12-31&excludeTypes=");
    expect(json.events[0].type).toBe("route_test_noise");
  });

  it("pages with limit and offset and reports the total of every match", async () => {
    const first = await get("/events?session=2099-03-05&limit=4&offset=0");
    const second = await get("/events?session=2099-03-05&limit=4&offset=4");
    const third = await get("/events?session=2099-03-05&limit=4&offset=8");
    expect(first.json.total).toBe(7);
    expect(first.json.events.map((event: any) => event.type)).toEqual(["resumed", "paused", "model_called", "pass_skipped"]);
    expect(second.json.events.map((event: any) => event.type)).toEqual(["pass_started", "ticker_enabled", "ticker_enabled"]);
    expect(third.json.events).toEqual([]);
    expect(third.json.total).toBe(7);
  });

  it("keeps only the chosen categories, and nothing when none are chosen", async () => {
    const config = await get("/events?session=2099-03-05&categories=config");
    expect(config.json.events.map((event: any) => event.category)).toEqual(["config", "config"]);
    const infoAndAnalysis = await get("/events?session=2099-03-05&categories=info,analysis");
    expect(infoAndAnalysis.json.total).toBe(3);
    const none = await get("/events?session=2099-03-05&categories=");
    expect(none.json).toEqual({ events: [], total: 0 });
  });

  it("rejects a category that does not exist", async () => {
    const { status } = await get("/events?categories=config,bogus");
    expect(status).toBe(400);
  });

  it("keeps a ticker's trace: events naming it (as symbol, symbols or tickers, any case), its passes' events, and events for every ticker", async () => {
    const zztb = await get("/events?session=2099-03-05&ticker=zztb");
    expect(zztb.json.events.map((event: any) => event.type)).toEqual(["resumed", "paused", "model_called", "pass_started", "ticker_enabled"]);
    expect(zztb.json.events.filter((event: any) => event.appliesToAllTickers).map((event: any) => event.type)).toEqual(["resumed", "paused"]);
    const zztc = await get("/events?session=2099-03-05&ticker=ZZTC");
    expect(zztc.json.events.map((event: any) => event.type)).toEqual(["resumed", "paused", "pass_skipped"]);
    const wildcard = await get("/events?session=2099-03-05&ticker=%25");
    expect(wildcard.json.events.map((event: any) => event.type)).toEqual(["resumed", "paused"]);
  });

  it("treats a session as an Eastern calendar day, not a UTC one", async () => {
    const march5 = await get("/events?session=2099-03-05&categories=system&types=resumed");
    expect(march5.json.total).toBe(1);
    const march6 = await get("/events?session=2099-03-06&types=resumed");
    expect(march6.json.total).toBe(1);
    expect(march6.json.events[0].occurredAt).toBe("2099-03-06T05:01:00.000Z");
  });

  it("rejects a session that is not a real date", async () => {
    expect((await get("/events?session=2099-13-40")).status).toBe(400);
    expect((await get("/events?session=yesterday")).status).toBe(400);
  });
});

describe("GET /pluto/tickers", () => {
  it("lists only Signals tickers: a Signals-off shortlist ticker is hidden", async () => {
    const suffix = String(Date.now() % 1_000_000);
    const tickers = await testDb("tickers")
      .insert([{ symbol: `PTON${suffix}` }, { symbol: `PTOF${suffix}` }])
      .returning(["id", "symbol"]);
    try {
      await testDb("shortlist_entries").insert([
        { ticker_id: tickers[0].id, added_by_user_id: userId, signals_enabled: true },
        { ticker_id: tickers[1].id, added_by_user_id: userId, signals_enabled: false },
      ]);
      const { status, json } = await get("/tickers");
      expect(status).toBe(200);
      const symbols = (json.tickers as { symbol: string }[]).map((row) => row.symbol);
      expect(symbols).toContain(`PTON${suffix}`);
      expect(symbols).not.toContain(`PTOF${suffix}`);
    } finally {
      await testDb("shortlist_entries").whereIn("ticker_id", tickers.map((ticker) => ticker.id)).del();
      await testDb("tickers").whereIn("id", tickers.map((ticker) => ticker.id)).del();
    }
  });
});
