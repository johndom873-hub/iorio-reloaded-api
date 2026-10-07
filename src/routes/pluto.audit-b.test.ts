import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Audit B (2026-10-07): the Pluto routes changed today, on a small express app against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run Pluto route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: async () => true, notifyPlutoTelegram: async () => true }));
const watch = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../lib/daySignalsWatchStatus.js", () => ({
  loadDaySignalsWatchStatuses: async (tickerIds: string[]) => {
    watch.calls.push(tickerIds);
    return { tradingDateIso: "2098-07-14", sessionOpen: true, statuses: new Map(tickerIds.map((id) => [id, { kind: "watched", pooledExpiries: ["2098-07-17"] }])) };
  },
}));

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("./pluto.js");
const testDb: Knex = db;

const testTrigger = `audit_b_route_${Date.now()}`;
// One Eastern session nobody else uses (EDT, UTC-4).
const session = "2098-07-14";
const at = (minute: number) => `2098-07-14T14:${String(minute).padStart(2, "0")}:00Z`;
const suffix = String(Date.now() % 1_000_000);

let server: Server;
let baseUrl: string;
let userId: string;
const passIds: string[] = [];
const tickerIds: string[] = [];

async function pass(): Promise<string> {
  const [row] = await testDb("pluto_passes").insert({ trigger: testTrigger, model_called: true }).returning("id");
  passIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pluto-audit-b-${Date.now()}`, display_name: "Pluto Audit B", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  await testDb("pluto_events").insert([
    // A real pass_skipped shape: the tickers list carries each ticker's block reasons as text.
    { occurred_at: at(0), type: "pass_skipped", payload: { passId: "audit-b-p1", reason: "nothing eligible", tickers: [{ symbol: "NOK", blocks: ["day change 9.0% is 3.10× its normal 2.90% day, beyond 3×"], rejected: 0 }] } },
    { occurred_at: at(1), type: "ticker_enabled", payload: { symbol: "BSBR", by: "tester" } },
    { occurred_at: at(2), type: "pass_started", payload: { passId: "audit-b-p2", symbols: ["NOK"] } },
    { occurred_at: at(3), type: "order_outcome", payload: { actionId: "a1", symbol: "NOK", outcome: "filled" } },
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
  await testDb("pluto_events").whereBetween("occurred_at", ["2098-07-14T00:00:00Z", "2098-07-16T00:00:00Z"]).del();
  await testDb("pluto_decisions").whereIn("pass_id", passIds).del();
  await testDb("pluto_actions").whereIn("pass_id", passIds).del();
  await testDb("pluto_passes").whereIn("id", passIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}/pluto${path}`);
  return { status: response.status, json: (await response.json()) as any };
}

describe("GET /pluto/events — ticker trace", () => {
  it("keeps events naming the ticker exactly", async () => {
    const { json } = await get(`/events?session=${session}&ticker=NOK`);
    expect(json.events.map((event: any) => event.type)).toEqual(["order_outcome", "pass_started", "pass_skipped"]);
    expect(json.events.every((event: any) => event.appliesToAllTickers === false)).toBe(true);
  });

  // BUG: the trace matches by substring (LIKE '%X%') over the payload's symbol / symbols / tickers text, and `tickers` holds
  // block reasons as prose. BE (Bloom Energy, on the shortlist) matches the word "beyond" in any day-move block, and a
  // shorter symbol matches a longer one (BSB in BSBR).
  it("does not match a ticker inside another ticker's block reason (BE vs 'beyond')", async () => {
    const { json } = await get(`/events?session=${session}&ticker=BE`);
    expect(json.events.map((event: any) => event.type)).toEqual([]);
  });

  it("does not match a ticker that is a prefix of another (BSB vs BSBR)", async () => {
    const { json } = await get(`/events?session=${session}&ticker=BSB`);
    expect(json.total).toBe(0);
  });

  it("an underscore in the ticker is literal, not a LIKE wildcard", async () => {
    const { json } = await get(`/events?session=${session}&ticker=N_K`);
    expect(json.total).toBe(0);
  });
});

describe("GET /pluto/events — other filters", () => {
  it("categories and types combine as an intersection", async () => {
    const { json } = await get(`/events?session=${session}&categories=trading&types=order_outcome,pass_started`);
    expect(json.events.map((event: any) => event.type)).toEqual(["order_outcome"]);
  });

  it("a negative or junk offset and limit fall back to the defaults", async () => {
    const { status, json } = await get(`/events?session=${session}&offset=-5&limit=abc`);
    expect(status).toBe(200);
    expect(json.total).toBe(4);
    expect(json.events).toHaveLength(4);
  });

  // Characterised: a repeated ?categories= arrives as an array, which listFrom reads as no categories, so the filter keeps nothing.
  it("a repeated categories parameter returns nothing rather than both categories", async () => {
    const { status, json } = await get(`/events?session=${session}&categories=trading&categories=info`);
    expect(status).toBe(200);
    expect(json.total).toBe(0);
  });

  it("an empty session is ignored rather than rejected", async () => {
    expect((await get("/events?session=&limit=1")).status).toBe(200);
  });

  it("2098-02-30 is not a real date", async () => {
    expect((await get("/events?session=2098-02-30")).status).toBe(400);
  });
});

describe("GET /pluto/scoreboard", () => {
  it("counts abstentions (old 'abstain' and v3 'abstain_system_concern') inside noTrade, call 1 only, and has no pessimistic figure", async () => {
    const before = (await get("/scoreboard")).json;
    const verdicts = ["abstain_system_concern", "abstain", "no_trade", "trade"];
    for (const verdict of verdicts) {
      const passId = await pass();
      await testDb("pluto_decisions").insert({ pass_id: passId, call_index: 1, model_id: "m", input_payload: {}, schema_valid: true, parsed_output: { decision: verdict, candidate_id: verdict === "trade" ? "X:covered_call:2098-07-17:5" : null } });
      if (verdict === "abstain") await testDb("pluto_decisions").insert({ pass_id: passId, call_index: 2, model_id: "m", input_payload: {}, schema_valid: true, parsed_output: { decision: "abstain_system_concern" } });
    }
    const after = (await get("/scoreboard")).json;
    expect(after.modelVsTopPick.abstained - before.modelVsTopPick.abstained).toBe(2);
    expect(after.modelVsTopPick.noTrade - before.modelVsTopPick.noTrade).toBe(3);
    expect(after.modelVsTopPick.disagree - before.modelVsTopPick.disagree).toBe(1);
    expect(after).not.toHaveProperty("pessimisticPnl");
  });
});

describe("GET /pluto/passes and /passes/:id — system concerns normalised", () => {
  it("old plain-string concerns read as whole-message concerns, new ones keep their symbol, a missing list becomes []", async () => {
    const passId = await pass();
    await testDb("pluto_decisions").insert([
      { pass_id: passId, call_index: 1, model_id: "m", input_payload: {}, schema_valid: true, parsed_output: { decision: "abstain_system_concern", system_concerns: ["old string concern", { symbol: "SMCI", concern: "new" }] } },
      { pass_id: passId, call_index: 2, model_id: "m", input_payload: {}, schema_valid: true, parsed_output: { decision: "no_trade" } },
      { pass_id: passId, call_index: 3, model_id: "m", input_payload: {}, schema_valid: false, parsed_output: null },
    ]);
    await testDb("pluto_actions").insert({ pass_id: passId, kind: "no_trade", symbol: "—", outcome: "no_trade" });
    const detail = (await get(`/passes/${passId}`)).json;
    expect(detail.decisions.map((decision: any) => decision.parsedOutput?.system_concerns ?? null)).toEqual([
      [{ symbol: null, concern: "old string concern" }, { symbol: "SMCI", concern: "new" }],
      [],
      null,
    ]);
    expect(detail.actions[0]).not.toHaveProperty("pessimisticPnl");
    const list = (await get("/passes?limit=50")).json as any[];
    const row = list.find((entry) => entry.id === passId);
    expect(row.decisions[0].parsedOutput.system_concerns).toEqual([{ symbol: null, concern: "old string concern" }, { symbol: "SMCI", concern: "new" }]);
    expect(row.decisions[2].parsedOutput).toBeNull();
  });
});

describe("GET /pluto/day-signals-watch", () => {
  it("asks for every Pluto-enabled ticker on the shortlist and returns statuses keyed by ticker id", async () => {
    const tickers = await testDb("tickers").insert([{ symbol: `AWON${suffix}` }, { symbol: `AWOF${suffix}` }, { symbol: `AWRM${suffix}` }]).returning(["id", "symbol"]);
    tickerIds.push(...tickers.map((ticker) => ticker.id));
    await testDb("shortlist_entries").insert([
      { ticker_id: tickers[0].id, added_by_user_id: userId, signals_enabled: true, bot_enabled: true },
      { ticker_id: tickers[1].id, added_by_user_id: userId, signals_enabled: true, bot_enabled: false },
      { ticker_id: tickers[2].id, added_by_user_id: userId, signals_enabled: true, bot_enabled: true, removed_at: new Date() },
    ]);
    const { status, json } = await get("/day-signals-watch");
    expect(status).toBe(200);
    const asked = watch.calls.at(-1)!;
    expect(asked).toContain(tickers[0].id);
    expect(asked).not.toContain(tickers[1].id);
    expect(asked).not.toContain(tickers[2].id);
    expect(json.tradingDateIso).toBe("2098-07-14");
    expect(json.sessionOpen).toBe(true);
    expect(json.tickers[tickers[0].id]).toEqual({ kind: "watched", pooledExpiries: ["2098-07-17"] });
  });
});
