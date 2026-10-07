import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../config/env.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run Pluto schema tests.");
}

// Genuine insert → read back round trips against the real test database for every Pluto
// table (same discipline as src/db/schema.test.ts), plus the two constraints that matter:
// single-row settings/state and the mode CHECK.
const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });

let userId: string;
let tickerId: string;
let passId: string;

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `pluto-schema-${Date.now()}`, display_name: "Pluto Schema Test", password_hash: "x" }).returning("id");
  userId = user.id;
  const [ticker] = await db("tickers").insert({ symbol: `PLT${Date.now() % 100000}`, company_name: "Pluto Test Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
});

afterAll(async () => {
  if (passId) await db("pluto_passes").where({ id: passId }).del(); // cascades decisions + actions
  await db("pluto_events").where("payload", "@>", JSON.stringify({ test: true })).del();
  await db("pluto_settings_audit").where({ user_id: userId }).del();
  await db("shortlist_entries").where({ ticker_id: tickerId }).del();
  await db("tickers").where({ id: tickerId }).del();
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("Pluto schema", () => {
  it("pluto_settings and pluto_state are seeded single rows with the approved defaults", async () => {
    const settings = await db("pluto_settings");
    expect(settings).toHaveLength(1);
    expect(settings[0].model_id).toBe("openai/gpt-6-luna");
    // Approved 2026-10-06 for the $1M paper account: budget 50 %, order size 10 % of it, 15 positions, $1/day, 20 calls.
    expect(Number(settings[0].capital_budget_pct)).toBe(50);
    expect(Number(settings[0].order_size_pct_of_budget)).toBe(10);
    expect(settings[0].max_open_positions).toBe(15);
    expect(Number(settings[0].daily_cost_ceiling_usd)).toBe(1);
    expect(settings[0].prompt_version).toBe("v3.4");
    expect(settings[0].day_signals_poll_seconds).toBe(1);
    await expect(db("pluto_settings").insert({ id: 2 })).rejects.toThrow();

    const state = await db("pluto_state");
    expect(state).toHaveLength(1);
    expect(state[0].mode).toBe("off");
    expect(state[0].paused).toBe(true);
    await expect(db("pluto_state").where({ id: 1 }).update({ mode: "shadow" })).rejects.toThrow();
  });

  it("passes → decisions → actions round-trip and cascade", async () => {
    const [pass] = await db("pluto_passes").insert({ trigger: "spot_move", trigger_detail: JSON.stringify({ symbol: "HOOD", movePct: 1.8 }) }).returning("*");
    passId = pass.id;
    expect(pass.candidate_count).toBe(0);
    expect(pass.served_model_ids).toEqual([]);

    const [decision] = await db("pluto_decisions").insert({ pass_id: passId, call_index: 1, model_id: "openai/gpt-6-luna", input_payload: JSON.stringify({ tickers: [] }), schema_valid: true }).returning("*");
    expect(decision.input_payload).toEqual({ tickers: [] });

    const [action] = await db("pluto_actions")
      .insert({ pass_id: passId, kind: "open_cash_secured_put", symbol: "HOOD", ticker_id: tickerId, outcome: "validated", gate_results: JSON.stringify([{ gate: "ticker_enabled", ok: true, detail: "" }]) })
      .returning("*");
    expect(action.gate_results).toEqual([{ gate: "ticker_enabled", ok: true, detail: "" }]);

    await db("pluto_passes").where({ id: passId }).del();
    expect(await db("pluto_actions").where({ id: action.id }).first()).toBeUndefined();
    expect(await db("pluto_decisions").where({ id: decision.id }).first()).toBeUndefined();
    passId = "";
  });

  it("pluto_events, settings audit and the shortlist flag store what was written", async () => {
    const [event] = await db("pluto_events").insert({ type: "paused", payload: JSON.stringify({ test: true, by: "Juan" }) }).returning("*");
    expect(event.payload).toEqual({ test: true, by: "Juan" });

    const [audit] = await db("pluto_settings_audit").insert({ user_id: userId, field: "capitalBudgetPct", old_value: "30", new_value: "25" }).returning("*");
    expect(audit.new_value).toBe("25");

    const [entry] = await db("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId }).returning("*");
    expect(entry.bot_enabled).toBe(false);
    expect(entry.signals_enabled).toBe(false);
    // Pluto only trades Signals tickers: the database refuses Pluto on with Signals off.
    await expect(db("shortlist_entries").where({ id: entry.id }).update({ bot_enabled: true })).rejects.toThrow(/shortlist_entries_bot_requires_signals/);
    await db("shortlist_entries").where({ id: entry.id }).update({ signals_enabled: true, bot_enabled: true, bot_enabled_changed_by_user_id: userId, bot_enabled_changed_at: db.fn.now() });
    await expect(db("shortlist_entries").where({ id: entry.id }).update({ signals_enabled: false })).rejects.toThrow(/shortlist_entries_bot_requires_signals/);
    const updated = await db("shortlist_entries").where({ id: entry.id }).first();
    expect(updated.bot_enabled).toBe(true);
    expect(updated.bot_enabled_changed_by_user_id).toBe(userId);
  });
});
