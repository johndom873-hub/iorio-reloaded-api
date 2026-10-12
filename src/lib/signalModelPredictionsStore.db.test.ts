import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SignalCandidate } from "./signalCandidates.js";
import { fixtureCandidateModel } from "./testSupport/valuationModelFixtures.js";
import { volatilityModelTables } from "./volatilityModelTables.generated.js";

// The model prediction log against the real test database: one row per ticker, trading date and contract; a re-run
// seed replaces the day's row; unvalued candidates are not logged.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the prediction log tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { modelPredictionsFromCandidates, recordSignalModelPredictions } = await import("./signalModelPredictionsStore.js");
const testDb: Knex = db;
const symbol = `SMP${Date.now() % 100000}`;
let tickerId: string;

const candidate = (strike: number, strategyKey: SignalCandidate["strategyKey"], model: SignalCandidate["model"]) =>
  ({ strategyKey, expiry: "2026-10-16", strike, bid: 0.95, ask: 1.05, quoteSource: "snapshot", model }) as SignalCandidate;

beforeAll(async () => {
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Prediction Log Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
});

afterAll(async () => {
  await testDb("signal_model_predictions").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
});

async function storedRows() {
  return testDb("signal_model_predictions")
    .where({ ticker_id: tickerId })
    .orderBy(["trading_date", "strike", "option_right"])
    .select(
      db.raw("trading_date::text as trading_date"),
      db.raw("expiry::text as expiry"),
      db.raw("strike::float8 as strike"),
      "option_right",
      "quote_source",
      db.raw("edge_margin::float8 as edge_margin"),
      db.raw("expected_pnl_dollars::float8 as expected_pnl_dollars"),
      db.raw("calibrated_expected_pnl_dollars::float8 as calibrated_expected_pnl_dollars"),
      db.raw("probability_of_profit::float8 as probability_of_profit"),
      db.raw("variance_sessions::float8 as variance_sessions"),
      db.raw("forward::float8 as forward"),
      "grade",
      "tables_built_at",
      db.raw("to_char(valued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as valued_at"),
    );
}

describe("signal model prediction log", () => {
  it("logs every valued candidate with the model's figures and the tables' build, and skips unvalued ones", async () => {
    const predictions = modelPredictionsFromCandidates(tickerId, "2026-10-12", [
      candidate(90, "cash_secured_put", fixtureCandidateModel({ edgeMargin: 0.3456, expectedPnlDollars: 21.37, calibratedExpectedPnlDollars: 7.5, probabilityOfProfit: 0.873, varianceSessions: 4.309, forward: 100.2 })),
      candidate(110, "covered_call", fixtureCandidateModel({ edgeMargin: -1.25, expectedPnlDollars: -40, grade: "avoid" })),
      candidate(85, "cash_secured_put", null),
    ]);
    expect(predictions).toHaveLength(2);
    await recordSignalModelPredictions(predictions);
    expect(await storedRows()).toEqual([
      { trading_date: "2026-10-12", expiry: "2026-10-16", strike: 90, option_right: "P", quote_source: "snapshot", edge_margin: 0.3456, expected_pnl_dollars: 21.37, calibrated_expected_pnl_dollars: 7.5, probability_of_profit: 0.873, variance_sessions: 4.309, forward: 100.2, grade: "strong", tables_built_at: volatilityModelTables.builtAtIso, valued_at: "2026-09-21T14:00:00Z" },
      { trading_date: "2026-10-12", expiry: "2026-10-16", strike: 110, option_right: "C", quote_source: "snapshot", edge_margin: -1.25, expected_pnl_dollars: -40, calibrated_expected_pnl_dollars: 3, probability_of_profit: 0.8, variance_sessions: 5, forward: 100, grade: "avoid", tables_built_at: volatilityModelTables.builtAtIso, valued_at: "2026-09-21T14:00:00Z" },
    ]);
  });

  it("a re-run seed on the same day replaces the ticker's whole set for that day; another day adds its own", async () => {
    await recordSignalModelPredictions(modelPredictionsFromCandidates(tickerId, "2026-10-12", [candidate(90, "cash_secured_put", fixtureCandidateModel({ edgeMargin: 0.31, expectedPnlDollars: 18 }))]));
    await recordSignalModelPredictions(modelPredictionsFromCandidates(tickerId, "2026-10-13", [candidate(90, "cash_secured_put", fixtureCandidateModel({ edgeMargin: 0.2, expectedPnlDollars: 9 }))]));
    const rows = await storedRows();
    // The 110 call of the first 10-12 run is gone: the re-run did not value it.
    expect(rows.map((row) => [row.trading_date, row.strike, row.edge_margin, row.expected_pnl_dollars])).toEqual([["2026-10-12", 90, 0.31, 18], ["2026-10-13", 90, 0.2, 9]]);
  });

  it("writes nothing for an empty list", async () => {
    const before = (await storedRows()).length;
    await recordSignalModelPredictions([]);
    expect((await storedRows()).length).toBe(before);
  });
});
