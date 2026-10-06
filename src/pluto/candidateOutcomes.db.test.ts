import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../config/env.js";
import { labelExpiredCandidateOutcomes, loadCandidateOutcomes } from "./candidateOutcomes.js";
import { ensurePlutoPrompt, loadPlutoPrompt } from "./prompts.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run Pluto outcome tests.");
}

// Labelling against the real test database: a settled put (labelled from the expiry bar), one
// expiring in the future (pending), and one with no bar near its expiry (skipped and listed).
const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `PLO${Date.now() % 100000}`;
let tickerId: string;
let passId: string;

beforeAll(async () => {
  const [ticker] = await db("tickers").insert({ symbol, company_name: "Pluto Outcome Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
  await db("daily_price_bars").insert({ ticker_id: tickerId, trading_date: "2026-09-18", open_price: 100, high_price: 101, low_price: 99, close_price: 97.5, volume: 1000 });
  const [pass] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: true }), model_called: true }).returning("id");
  passId = pass.id;
  const payload = {
    tickers: [
      {
        symbol,
        candidates: [
          { id: `${symbol}:cash_secured_put:2026-09-18:100`, kind: "open_cash_secured_put", expiry: "2026-09-18", strike: 100, bid: 1.5 },
          { id: `${symbol}:cash_secured_put:2099-01-15:100`, kind: "open_cash_secured_put", expiry: "2099-01-15", strike: 100, bid: 9 },
          { id: `${symbol}:covered_call:2026-08-21:120`, kind: "open_covered_call", expiry: "2026-08-21", strike: 120, bid: 0.8 },
        ],
      },
    ],
  };
  await db("pluto_decisions").insert({ pass_id: passId, call_index: 1, model_id: "test", input_payload: JSON.stringify(payload), schema_valid: true });
});

afterAll(async () => {
  await db("pluto_passes").where({ id: passId }).del();
  await db("daily_price_bars").where({ ticker_id: tickerId }).del();
  await db("tickers").where({ id: tickerId }).del();
  await db("pluto_prompts").where({ version: "test-v0" }).del();
  await db.destroy();
});

describe("labelExpiredCandidateOutcomes", () => {
  it("labels settled candidates from the expiry close, leaves future ones pending and lists missing bars", async () => {
    const result = await labelExpiredCandidateOutcomes(new Date("2026-09-28T21:00:00Z"), db);
    const mine = (await loadCandidateOutcomes([passId], db)).get(passId)!;
    // put struck 100, close 97.5, premium 1.5 → (1.5 − 2.5) × 100 = −100
    expect(mine.get(`${symbol}:cash_secured_put:2026-09-18:100`)).toBe(-100);
    expect(mine.has(`${symbol}:cash_secured_put:2099-01-15:100`)).toBe(false);
    expect(result.pending).toBeGreaterThanOrEqual(1);
    expect(result.missingBars).toContain(`${symbol} 2026-08-21`);
    // idempotent
    const again = await labelExpiredCandidateOutcomes(new Date("2026-09-28T21:00:00Z"), db);
    expect((await loadCandidateOutcomes([passId], db)).get(passId)!.size).toBe(1);
    expect(again.labelled).toBe(0);
  });
});

describe("ensurePlutoPrompt", () => {
  it("stores a prompt once per distinct text and returns the same id again", async () => {
    const first = await ensurePlutoPrompt("test-v0", "You are Pluto (test).", db);
    const second = await ensurePlutoPrompt("test-v0", "You are Pluto (test).", db);
    expect(second).toBe(first);
    expect((await loadPlutoPrompt(first, db))?.content).toBe("You are Pluto (test).");
  });
});
