import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Audit (G2, 2026-10-07): the Shortlist Signals switch, the notes removal and the restart-aware Retry flag, through the real
// shortlistRouter on the test database. IBKR-facing modules and the backfill pipeline's start are mocked; rows are real.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the shortlist audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 8 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => undefined) }));
vi.mock("../ibkr/searchTickers.js", () => ({ searchTickers: vi.fn(async () => []) }));

const fetchNewTickerDataMock = vi.fn();
vi.mock("../ibkr/fetchNewTickerData.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/fetchNewTickerData.js")>("../ibkr/fetchNewTickerData.js");
  return { ...actual, fetchNewTickerData: (...args: unknown[]) => fetchNewTickerDataMock(...args) };
});

const recordPlutoEventMock = vi.fn();
vi.mock("../pluto/ledger.js", async () => {
  const actual = await vi.importActual<typeof import("../pluto/ledger.js")>("../pluto/ledger.js");
  return { ...actual, recordPlutoEvent: (...args: unknown[]) => recordPlutoEventMock(...args) };
});

const startTickerBackfillMock = vi.fn();
vi.mock("../ibkr/tickerBackfillPipeline.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/tickerBackfillPipeline.js")>("../ibkr/tickerBackfillPipeline.js");
  return { ...actual, startTickerBackfill: (...args: unknown[]) => startTickerBackfillMock(...args) };
});

vi.mock("../ibkr/sharedReadConnection.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/sharedReadConnection.js")>("../ibkr/sharedReadConnection.js");
  return { ...actual, sharedReadConnection: { label: "fake" }, borrowSharedConnectionOrConnect: vi.fn(), nextReqIdFor: vi.fn(() => 1) };
});

const invalidatePricePerformanceSnapshotMock = vi.fn();
vi.mock("../lib/pricePerformanceSnapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/pricePerformanceSnapshot.js")>("../lib/pricePerformanceSnapshot.js");
  return { ...actual, invalidatePricePerformanceSnapshot: () => invalidatePricePerformanceSnapshotMock() };
});

const { db } = await import("../db/connection.js");
const { shortlistRouter } = await import("./shortlist.js");
const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
const createdTickerIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `shortlist-audit-g2-${Date.now()}`, display_name: "Shortlist Audit Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as unknown as { session: { userId?: string } }).session = { userId };
    next();
  });
  app.use("/shortlist", shortlistRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  fetchNewTickerDataMock.mockReset();
  recordPlutoEventMock.mockReset().mockResolvedValue(undefined);
  startTickerBackfillMock.mockReset().mockImplementation(async (tickerId: string) => ({ id: "fake-run", tickerId, status: "running", steps: [], progressPercent: 0, startedAt: new Date().toISOString(), finishedAt: null, resumedFromRunId: null }));
  invalidatePricePerformanceSnapshotMock.mockReset();
});

afterEach(async () => {
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).update({ resumed_from_run_id: null });
  await testDb("ticker_backfill_runs").whereIn("ticker_id", createdTickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", createdTickerIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdTickerIds.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function insertTicker(): Promise<{ id: string; symbol: string }> {
  symbolCounter += 1;
  const [ticker] = await testDb("tickers").insert({ symbol: `SG2${symbolCounter}`, company_name: "Shortlist Audit Co", sector: "Technology", ibkr_contract_id: 4242 }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

async function insertEntry(tickerId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const [entry] = await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId, ...overrides }).returning("id");
  return entry.id;
}

async function insertRun(tickerId: string, status: string, startedMinutesAgo: number, resumedFromRunId: string | null = null): Promise<string> {
  const startedAt = new Date(Date.now() - startedMinutesAgo * 60_000);
  const [run] = await testDb("ticker_backfill_runs")
    .insert({ ticker_id: tickerId, status, steps: JSON.stringify([]), progress_percent: 50, started_at: startedAt, finished_at: status === "running" ? null : startedAt, resumed_from_run_id: resumedFromRunId })
    .returning("id");
  return run.id;
}

async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/shortlist${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const rowFor = async (symbol: string) => ((await call("GET", "/")).json as any[]).find((row) => row.symbol === symbol);

describe("PATCH /shortlist/:id/signals-enabled", () => {
  it("drops the Price Performance cache, which shows signalsEnabled and hides IV for a Signals-off ticker", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true });

    expect((await call("PATCH", `/${entryId}/signals-enabled`, { enabled: false })).status).toBe(200);
    expect(invalidatePricePerformanceSnapshotMock).toHaveBeenCalled();
  });

  it("Signals off racing Pluto on never breaks the Pluto-needs-Signals rule and never answers 500", async () => {
    const outcomes: number[][] = [];
    for (let round = 0; round < 6; round += 1) {
      const ticker = await insertTicker();
      const entryId = await insertEntry(ticker.id, { signals_enabled: true });
      const [signalsOff, plutoOn] = await Promise.all([call("PATCH", `/${entryId}/signals-enabled`, { enabled: false }), call("PATCH", `/${entryId}/bot-enabled`, { enabled: true })]);
      outcomes.push([signalsOff.status, plutoOn.status]);
      const entry = await testDb("shortlist_entries").where({ id: entryId }).first("signals_enabled", "bot_enabled");
      expect(entry.bot_enabled && !entry.signals_enabled).toBe(false);
    }
    for (const [signalsOffStatus, plutoOnStatus] of outcomes) {
      expect(signalsOffStatus).toBe(200);
      expect([200, 409]).toContain(plutoOnStatus);
    }
  });

  it("Signals back on after being turned off leaves Pluto off (it is not restored)", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true, bot_enabled: true });

    await call("PATCH", `/${entryId}/signals-enabled`, { enabled: false });
    expect((await call("PATCH", `/${entryId}/signals-enabled`, { enabled: true })).json).toMatchObject({ signalsEnabled: true, botEnabled: false });
    expect(startTickerBackfillMock).toHaveBeenCalledWith(ticker.id, ticker.symbol, undefined, "option_chain");
  });

  it("Signals off is allowed on a ticker Pluto holds (bot on), and the GET row agrees", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true, bot_enabled: true });

    await call("PATCH", `/${entryId}/signals-enabled`, { enabled: false });
    expect(await rowFor(ticker.symbol)).toMatchObject({ signalsEnabled: false, botEnabled: false });
  });
});

describe("POST /shortlist", () => {
  it.each([["a string", "true"], ["a number", 1], ["null", null]])("refuses signalsEnabled as %s before looking the symbol up, and stores nothing", async (_label, signalsEnabled) => {
    const ticker = await insertTicker();

    expect(await call("POST", "/", { symbol: ticker.symbol, signalsEnabled })).toMatchObject({ status: 400, json: { error: "signalsEnabled must be true or false." } });
    expect(await testDb("shortlist_entries").where({ ticker_id: ticker.id })).toHaveLength(0);
    expect(fetchNewTickerDataMock).not.toHaveBeenCalled();
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("an old client still sending notes adds the ticker with Signals off and stores no note", async () => {
    const ticker = await insertTicker();

    const response = await call("POST", "/", { symbol: ticker.symbol, notes: "legacy note" });
    expect(response).toMatchObject({ status: 201, json: { signalsEnabled: false, botEnabled: false } });
    expect(response.json).not.toHaveProperty("notes");
  });
});

describe("GET /shortlist", () => {
  it("has the Signals flag and no notes field", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);

    const row = await rowFor(ticker.symbol);
    expect(row).toMatchObject({ signalsEnabled: false, botEnabled: false });
    expect(row).not.toHaveProperty("notes");
  });

  it("after a restart: the closed run is history, the fresh restart shows preparing and no Retry", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    const closedId = await insertRun(ticker.id, "partial", 3);
    await insertRun(ticker.id, "running", 1, closedId);

    expect(await rowFor(ticker.symbol)).toMatchObject({ backfillStatus: "preparing", backfillNeedsRetry: false });
  });

  it("a restart that itself died (running past 30 minutes) offers Retry and no longer shows preparing", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    const closedId = await insertRun(ticker.id, "partial", 90);
    await insertRun(ticker.id, "running", 31, closedId);

    expect(await rowFor(ticker.symbol)).toMatchObject({ backfillStatus: null, backfillNeedsRetry: true });
  });

  it("a run running for just under 30 minutes is still preparing, not Retry", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    await insertRun(ticker.id, "running", 29);

    expect(await rowFor(ticker.symbol)).toMatchObject({ backfillStatus: "preparing", backfillNeedsRetry: false });
  });
});
