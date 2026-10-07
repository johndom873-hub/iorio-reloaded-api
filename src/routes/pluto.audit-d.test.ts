import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Audit D (2026-10-07): GET /pluto/day-signals-watch on the real router against the test database, with the clock (Date only)
// frozen on a far-future Monday so the fixtures decide each ticker's kind.
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Pluto route audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("./pluto.js");
const testDb: Knex = db;

const tradingDate = "2031-03-03";
const suffix = String(Date.now() % 1_000_000);
let server: Server;
let baseUrl: string;
let userId: string;
const ids = { tickers: [] as string[], snapshots: [] as string[], jobRuns: [] as string[] };
const tickerBySymbol = new Map<string, string>();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-03T16:00:00Z")); // 11:00 ET
  const [user] = await testDb("users").insert({ username: `pluto-audit-d-${suffix}`, display_name: "Audit D", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const symbols = [`AWP${suffix}`, `AWU${suffix}`, `AWO${suffix}`, `AWR${suffix}`];
  const tickers = await testDb("tickers").insert(symbols.map((symbol) => ({ symbol }))).returning(["id", "symbol"]);
  for (const ticker of tickers) {
    ids.tickers.push(ticker.id);
    tickerBySymbol.set(ticker.symbol, ticker.id);
  }
  const [pooled, unpooled, botOff, removed] = symbols.map((symbol) => tickerBySymbol.get(symbol)!);
  await testDb("shortlist_entries").insert([
    { ticker_id: pooled, added_by_user_id: userId, signals_enabled: true, bot_enabled: true },
    { ticker_id: unpooled, added_by_user_id: userId, signals_enabled: true, bot_enabled: true },
    { ticker_id: botOff, added_by_user_id: userId, signals_enabled: true, bot_enabled: false },
    { ticker_id: removed, added_by_user_id: userId, signals_enabled: true, bot_enabled: true, removed_at: new Date() },
  ]);
  for (const tickerId of [pooled!, unpooled!]) {
    const [snapshot] = await testDb("option_chain_snapshots").insert({ ticker_id: tickerId, trading_date: tradingDate, captured_at: new Date("2031-03-03T15:00:00Z"), status: "complete", underlying_price: 100 }).returning(["id"]);
    ids.snapshots.push(snapshot.id);
    await testDb("option_surface_fits").insert({ snapshot_id: snapshot.id, expiry: "2031-04-02", years_to_expiry: 30 / 365, forward_price: 100, status: "ok", point_count: 20, dropped_counts: JSON.stringify({}), param_a: 0.09 * (30 / 365), param_b: 0, param_rho: 0, param_m: 0, param_sigma: 0.1 });
    if (tickerId === pooled) await testDb("day_signal_expiries").insert({ ticker_id: tickerId, expiry: "2031-03-14", trading_date: tradingDate, snapshot_id: snapshot.id, rank: 1, seed_best_edge_dollars: 10, seed_best_net_edge: 0.01, seeded_at: new Date("2031-03-03T15:07:00Z") });
  }
  const [run] = await testDb("job_runs").insert({ job_name: "day_signals_seed", started_at: "2031-03-03T15:05:00Z", finished_at: "2031-03-03T15:07:00Z", status: "success" }).returning(["id"]);
  ids.jobRuns.push(run.id);

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
  vi.useRealTimers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("job_runs").whereIn("id", ids.jobRuns).del();
  await testDb("day_signal_expiries").whereIn("ticker_id", ids.tickers).del();
  await testDb("day_signal_rerank_state").whereIn("ticker_id", ids.tickers).del();
  await testDb("option_surface_fits").whereIn("snapshot_id", ids.snapshots).del();
  await testDb("option_chain_snapshots").whereIn("id", ids.snapshots).del();
  await testDb("shortlist_entries").whereIn("ticker_id", ids.tickers).del();
  await testDb("tickers").whereIn("id", ids.tickers).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("GET /pluto/day-signals-watch — audit D", () => {
  it("answers for bot-enabled shortlist tickers only (not bot-off, not removed), keyed by ticker id, with today's date and session", async () => {
    const response = await fetch(`${baseUrl}/pluto/day-signals-watch`);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { tradingDateIso: string; sessionOpen: boolean; tickers: Record<string, { kind: string; pooledExpiries: string[]; triggerLowPrice: number | null; triggerHighPrice: number | null; nextTimedCheckAt: string | null }> };
    expect(json.tradingDateIso).toBe(tradingDate);
    expect(json.sessionOpen).toBe(true);
    const pooled = tickerBySymbol.get(`AWP${suffix}`)!;
    const unpooled = tickerBySymbol.get(`AWU${suffix}`)!;
    expect(json.tickers[pooled]).toMatchObject({ kind: "watched", pooledExpiries: ["2031-03-14"], triggerLowPrice: 99, triggerHighPrice: 101 });
    expect(json.tickers[unpooled]).toMatchObject({ kind: "not_watched", pooledExpiries: [], nextTimedCheckAt: null });
    expect(json.tickers[tickerBySymbol.get(`AWO${suffix}`)!]).toBeUndefined();
    expect(json.tickers[tickerBySymbol.get(`AWR${suffix}`)!]).toBeUndefined();
  });
});
