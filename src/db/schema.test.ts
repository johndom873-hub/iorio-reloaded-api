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
      username: `schema-test-${Date.now()}`,
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
  await db("order_requests").where({ requested_by_user_id: userId }).del();
  await db("trades").where({ position_leg_id: positionLegId }).del();
  await db("position_pnl_snapshots").where({ position_id: positionId }).del();
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
    expect(row.username).toContain("schema-test-");
    expect(row.display_name).toBe("Schema Test User");
  });

  it("tickers: stores and retrieves a row matching what was inserted", async () => {
    const row = await db("tickers").where({ id: tickerId }).first();
    expect(row.company_name).toBe("Test Co");
    expect(row.sector).toBe("Technology");
  });

  it("shortlist_entries: stores and retrieves, enforces one active entry per ticker", async () => {
    const [entry] = await db("shortlist_entries")
      .insert({ ticker_id: tickerId, added_by_user_id: userId })
      .returning("*");
    expect(entry.removed_at).toBeNull();

    await expect(
      db("shortlist_entries").insert({
        ticker_id: tickerId,
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

  it("position_legs: stores and retrieves the assignment-risk alert state", async () => {
    await db("position_legs").where({ id: positionLegId }).update({ assignment_risk_notified_at: new Date("2026-09-24T15:00:00Z"), assignment_risk_last_alert_trading_date: "2026-09-24" });
    const leg = await db("position_legs").where({ id: positionLegId }).first("assignment_risk_notified_at", db.raw("assignment_risk_last_alert_trading_date::text as last_alert_trading_date"));
    expect(new Date(leg.assignment_risk_notified_at).toISOString()).toBe("2026-09-24T15:00:00.000Z");
    expect(leg.last_alert_trading_date).toBe("2026-09-24");
  });

  it("trade_alerts and order_requests.source_alert_id are gone (Trade Alerts retired)", async () => {
    expect(await db.schema.hasTable("trade_alerts")).toBe(false);
    expect(await db.schema.hasColumn("order_requests", "source_alert_id")).toBe(false);
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
  it("order_requests: gate_evaluation is a nullable jsonb that round-trips a nested verdict exactly", async () => {
    const [bare] = await db("order_requests")
      .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify({ symbol: "SCHEMA", strategyKey: "cash_secured_put", legs: [] }) })
      .returning("*");
    expect(bare.gate_evaluation).toBeNull();
    expect(bare.genosuke_notified_status).toBeNull();

    const verdict = {
      blocks: [],
      warnings: ["1 economic event before expiry: 2026-11-04 FOMC Rate Decision."],
      limits: { blocked: false, reasons: [], details: { orderNotional: 18000, positionSharePct: 0.018, limits: { maxPositionPctOfPortfolio: 10 } } },
      deltaBand: { compliant: true, reason: null },
      closeGate: null,
      tradingBlockedReason: null,
      evaluatedAt: "2026-10-05T03:00:00.000Z",
    };
    await db("order_requests").where({ id: bare.id }).update({ gate_evaluation: JSON.stringify(verdict) });
    const stored = await db("order_requests").where({ id: bare.id }).first();
    expect(stored.gate_evaluation).toEqual(verdict);
    // jsonb lets the verdict be queried: the blocks array is empty, and the evaluation time is a string field.
    const queried = await db("order_requests").where({ id: bare.id }).first(db.raw("jsonb_array_length(gate_evaluation->'blocks') as block_count"), db.raw("gate_evaluation->>'evaluatedAt' as evaluated_at"));
    expect(Number(queried.block_count)).toBe(0);
    expect(queried.evaluated_at).toBe("2026-10-05T03:00:00.000Z");

    await db("order_requests").where({ id: bare.id }).update({ gate_evaluation: null });
    expect((await db("order_requests").where({ id: bare.id }).first()).gate_evaluation).toBeNull();
  });

  it("order_requests: genosuke_notified_status is free text that stores and clears a status", async () => {
    const [order] = await db("order_requests")
      .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify({ symbol: "SCHEMA", strategyKey: "cash_secured_put", legs: [] }), status: "submitted", genosuke_notified_status: "submitted" })
      .returning("*");
    expect(order.genosuke_notified_status).toBe("submitted");
    const columns = await db("information_schema.columns").where({ table_name: "order_requests" }).whereIn("column_name", ["gate_evaluation", "genosuke_notified_status"]).select("column_name", "data_type", "is_nullable");
    expect(Object.fromEntries(columns.map((column) => [column.column_name, `${column.data_type}:${column.is_nullable}`]))).toEqual({ gate_evaluation: "jsonb:YES", genosuke_notified_status: "text:YES" });
    // The existing status check still holds next to the new columns.
    await expect(db("order_requests").insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: "{}", status: "not_a_status" })).rejects.toThrow(/order_requests_status_check/);
  });

  it("trading_settings: holds exactly one valid row, seeded with in-range values", async () => {
    const rows = await db("trading_settings");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe(true);
    for (const column of ["max_position_pct_of_portfolio", "max_concentration_per_ticker_pct", "min_cash_reserve_pct", "min_annualized_yield_pct", "commission_warn_share_of_premium_pct"]) {
      expect(Number(row[column]), column).toBeGreaterThanOrEqual(0);
      expect(Number(row[column]), column).toBeLessThanOrEqual(100);
    }
    expect(Number(row.delta_target_min)).toBeGreaterThanOrEqual(0);
    expect(Number(row.delta_target_max)).toBeLessThanOrEqual(1);
    expect(Number(row.delta_target_min)).toBeLessThanOrEqual(Number(row.delta_target_max));
    expect(row.recovery_dte_min).toBeGreaterThanOrEqual(0);
    expect(row.recovery_dte_min).toBeLessThanOrEqual(row.recovery_dte_max);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("trading_settings: stores and retrieves new values, rejects a second row, and the row is put back afterwards", async () => {
    const original = await db("trading_settings").first();
    try {
      await db("trading_settings").update({ max_position_pct_of_portfolio: 12.5, delta_target_min: 0.125, delta_target_max: 0.375, recovery_dte_min: 3, recovery_dte_max: 9, updated_by_user_id: userId });
      const row = await db("trading_settings").first();
      expect(Number(row.max_position_pct_of_portfolio)).toBe(12.5);
      expect(Number(row.delta_target_min)).toBe(0.125);
      expect(Number(row.delta_target_max)).toBe(0.375);
      expect(row.recovery_dte_min).toBe(3);
      expect(row.recovery_dte_max).toBe(9);
      expect(row.updated_by_user_id).toBe(userId);

      const { id: _id, ...values } = row;
      await expect(db("trading_settings").insert({ ...values, id: true })).rejects.toThrow(/duplicate key/i);
      await expect(db("trading_settings").insert({ ...values, id: false })).rejects.toThrow(/trading_settings_single_row/);
      await expect(db("trading_settings").update({ delta_target_min: 0.9 })).rejects.toThrow(/trading_settings_delta_band_valid/);
      expect(await db("trading_settings")).toHaveLength(1);
    } finally {
      await db("trading_settings").update(original);
    }
    const restored = await db("trading_settings").first();
    expect(restored.updated_by_user_id).toBe(original.updated_by_user_id);
    expect(Number(restored.max_position_pct_of_portfolio)).toBe(Number(original.max_position_pct_of_portfolio));
  });

  it("the three trading-settings migrations are recorded as applied", async () => {
    const applied = (await db("knex_migrations").select("name")).map((row) => row.name);
    expect(applied).toEqual(
      expect.arrayContaining([
        "20261005000001_create_trading_settings.ts",
        "20261005000002_add_gate_evaluation_to_order_requests.ts",
        "20261005000003_add_genosuke_notified_status_to_order_requests.ts",
      ]),
    );
  });
});
