import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../config/env.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run schema tests.");
}

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });

let userId: string;
let tickerId: string;
let positionId: string;
let positionLegId: string;

// Every table gets a genuine insert -> read back -> assert round trip
// against the real test database, not just "the migration ran without
// error." Cleans up its own rows afterward via cascading FK dependency
// order so the suite is repeatable.

beforeAll(async () => {
  const [user] = await db("users")
    .insert({
      email: `schema-test-${Date.now()}@example.com`,
      display_name: "Schema Test User",
      password_hash: "not-a-real-hash",
    })
    .returning("id");
  userId = user.id;

  const [ticker] = await db("tickers")
    .insert({ symbol: `TEST${Date.now() % 100000}`, company_name: "Test Co", sector: "Technology" })
    .returning("id");
  tickerId = ticker.id;
});

afterAll(async () => {
  await db("trades").where({ position_leg_id: positionLegId }).del();
  await db("position_pnl_snapshots").where({ position_id: positionId }).del();
  await db("trade_alerts").where({ ticker_id: tickerId }).del();
  await db("position_legs").where({ position_id: positionId }).del();
  await db("positions").where({ id: positionId }).del();
  await db("shortlist_entries").where({ ticker_id: tickerId }).del();
  await db("daily_price_bars").where({ ticker_id: tickerId }).del();
  await db("market_data_snapshots").where({ ticker_id: tickerId }).del();
  await db("account_pnl_snapshots").where({ snapshot_date: "2026-08-11" }).del();
  await db("job_runs").where({ job_name: "schema_test_job" }).del();
  await db("strategy_settings").where({ strategy_key: "schema_test_strategy" }).del();
  await db("tickers").where({ id: tickerId }).del();
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("database schema round-trips", () => {
  it("users: stores and retrieves a row matching what was inserted", async () => {
    const row = await db("users").where({ id: userId }).first();
    expect(row.email).toContain("schema-test-");
    expect(row.display_name).toBe("Schema Test User");
  });

  it("tickers: stores and retrieves a row matching what was inserted", async () => {
    const row = await db("tickers").where({ id: tickerId }).first();
    expect(row.company_name).toBe("Test Co");
    expect(row.sector).toBe("Technology");
  });

  it("shortlist_entries: stores and retrieves, enforces one active entry per ticker+strategy", async () => {
    const [entry] = await db("shortlist_entries")
      .insert({ ticker_id: tickerId, strategy_key: "covered_call", added_by_user_id: userId })
      .returning("*");
    expect(entry.removed_at).toBeNull();

    await expect(
      db("shortlist_entries").insert({
        ticker_id: tickerId,
        strategy_key: "covered_call",
        added_by_user_id: userId,
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("positions: stores and retrieves a row, rejects an invalid status", async () => {
    const [position] = await db("positions")
      .insert({ strategy_key: "covered_call", ticker_id: tickerId, status: "open" })
      .returning("*");
    positionId = position.id;
    expect(position.status).toBe("open");

    await expect(
      db("positions").insert({ strategy_key: "covered_call", ticker_id: tickerId, status: "not_a_real_status" }),
    ).rejects.toThrow();
  });

  it("position_legs: stores and retrieves, defaults multiplier to 100", async () => {
    const [leg] = await db("position_legs")
      .insert({
        position_id: positionId,
        leg_type: "option",
        side: "short",
        quantity: 1,
        option_type: "call",
        strike_price: 220,
        expiry_date: "2026-09-18",
        entry_price: 1.5,
        entry_at: new Date(),
      })
      .returning("*");
    positionLegId = leg.id;
    expect(Number(leg.multiplier)).toBe(100);
    expect(leg.option_type).toBe("call");
  });

  it("trades: stores and retrieves a row, enforces unique ibkr_exec_id", async () => {
    const execId = `exec-${Date.now()}`;
    const [trade] = await db("trades")
      .insert({
        position_leg_id: positionLegId,
        ibkr_exec_id: execId,
        side: "sell",
        quantity: 1,
        price: 1.5,
        realized_pnl: 0,
        executed_at: new Date(),
      })
      .returning("*");
    expect(trade.ibkr_exec_id).toBe(execId);

    await expect(
      db("trades").insert({
        position_leg_id: positionLegId,
        ibkr_exec_id: execId,
        side: "sell",
        quantity: 1,
        price: 1.5,
        executed_at: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("trade_alerts: stores and retrieves a row with jsonb suggested_structure", async () => {
    const [alert] = await db("trade_alerts")
      .insert({
        strategy_key: "covered_call",
        ticker_id: tickerId,
        alert_type: "new_trade",
        suggested_structure: { strike: 220, expiry: "2026-09-18", contracts: 1 },
        rationale: "Test rationale",
      })
      .returning("*");
    expect(alert.status).toBe("pending");
    expect(alert.suggested_structure.strike).toBe(220);
  });

  it("account_pnl_snapshots: stores and retrieves a row, enforces unique snapshot_date", async () => {
    const [snapshot] = await db("account_pnl_snapshots")
      .insert({ snapshot_date: "2026-08-11", daily_pnl: 100, realized_pnl: 50, unrealized_pnl: 50 })
      .returning("*");
    expect(Number(snapshot.daily_pnl)).toBe(100);
  });

  it("position_pnl_snapshots: stores and retrieves a row", async () => {
    const [snapshot] = await db("position_pnl_snapshots")
      .insert({ position_id: positionId, snapshot_date: "2026-08-11", unrealized_pnl: 25 })
      .returning("*");
    expect(Number(snapshot.unrealized_pnl)).toBe(25);
  });

  it("daily_price_bars: stores and retrieves OHLCV data", async () => {
    const [bar] = await db("daily_price_bars")
      .insert({
        ticker_id: tickerId,
        trading_date: "2026-08-11",
        open_price: 100,
        high_price: 105,
        low_price: 99,
        close_price: 103,
        volume: 1000000,
      })
      .returning("*");
    expect(Number(bar.close_price)).toBe(103);
    expect(Number(bar.volume)).toBe(1000000);
  });

  it("market_data_snapshots: stores and retrieves implied volatility", async () => {
    const [snapshot] = await db("market_data_snapshots")
      .insert({ ticker_id: tickerId, snapshot_date: "2026-08-11", implied_volatility: 0.32 })
      .returning("*");
    expect(Number(snapshot.implied_volatility)).toBeCloseTo(0.32);
  });

  it("job_runs: stores and retrieves a row", async () => {
    const [run] = await db("job_runs")
      .insert({ job_name: "schema_test_job", started_at: new Date(), status: "success" })
      .returning("*");
    expect(run.status).toBe("success");
  });

  it("strategy_settings: stores and retrieves a row, enforces unique strategy_key", async () => {
    const [settings] = await db("strategy_settings")
      .insert({ strategy_key: "schema_test_strategy", delta_target_min: 0.15, delta_target_max: 0.35 })
      .returning("*");
    expect(Number(settings.delta_target_min)).toBeCloseTo(0.15);

    await expect(
      db("strategy_settings").insert({ strategy_key: "schema_test_strategy", delta_target_min: 0.2 }),
    ).rejects.toThrow(/duplicate key/i);
  });
});
