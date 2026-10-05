import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";
import type { Contract, Execution } from "@stoqey/ib";

// Runs the real execution_quotes insert against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run execution quote database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { captureExecutionQuote } = await import("./ibkrGatewayExecutionQuotes.js");

const execId = "test-exec-quote-0001";
const now = new Date("2026-10-05T15:00:10Z");
const contract = { conId: 123456, secType: "OPT" } as Contract;

function execution(time: string): Execution {
  return { execId, time, price: 1.31 } as Execution;
}

afterEach(async () => {
  await db("execution_quotes").where({ ibkr_exec_id: execId }).del();
});
afterAll(async () => {
  await db.destroy();
});

describe("captureExecutionQuote", () => {
  it("stores the bid and ask of the executed contract, once per execution", async () => {
    let requests = 0;
    const dependencies = {
      fetchQuotes: async (contracts: Contract[]) => {
        requests += 1;
        expect(contracts).toEqual([{ conId: 123456, exchange: "SMART" }]);
        return { quotes: [{ bid: 1.29, ask: 1.32 }], notes: [] };
      },
      now: () => now,
    };
    await captureExecutionQuote({} as never, contract, execution("20261005 11:00:05 US/Eastern"), dependencies);
    await captureExecutionQuote({} as never, contract, execution("20261005 11:00:05 US/Eastern"), dependencies);
    const rows = await db("execution_quotes").where({ ibkr_exec_id: execId });
    expect(rows).toHaveLength(1);
    expect(requests).toBe(1);
    expect(Number(rows[0].bid)).toBe(1.29);
    expect(Number(rows[0].ask)).toBe(1.32);
    expect(Number(rows[0].execution_price)).toBe(1.31);
    expect(rows[0].sec_type).toBe("OPT");
    expect(rows[0].note).toBeNull();
  });

  it("keeps IBKR's explanation when a side is missing", async () => {
    const dependencies = { fetchQuotes: async () => ({ quotes: [{ bid: null, ask: null }], notes: ["IBKR sent only delayed quotes for leg 1"] }), now: () => now };
    await captureExecutionQuote({} as never, contract, execution("20261005 11:00:05 US/Eastern"), dependencies);
    const row = await db("execution_quotes").where({ ibkr_exec_id: execId }).first();
    expect(row.bid).toBeNull();
    expect(row.note).toBe("IBKR sent only delayed quotes for leg 1");
  });
});
