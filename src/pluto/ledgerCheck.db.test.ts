import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// When a ticker's memory and ledger first disagreed is kept on its row (ledger_mismatch_since), so the 120 seconds before a
// hold survive an agent restart; cleared once they agree, left alone while the look settles an option leg.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadLedgerMismatchSince, saveLedgerMismatch } = await import("./ledgerCheck.js");
const testDb: Knex = db;
const tickerId = randomUUID();

beforeAll(async () => {
  await testDb("tickers").insert({ id: tickerId, symbol: "LGR", company_name: "Ledger Check Co" });
  await testDb("pluto_vol_farmer_v4_cycles").insert({ ticker_id: tickerId, memory: JSON.stringify({ state: {}, pending: [] }) });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("the ledger mismatch's first sighting", () => {
  it("is stored with its detail, kept while settling, cleared once they agree", async () => {
    expect(await loadLedgerMismatchSince(tickerId)).toBeNull();
    const sinceMs = Date.parse("2026-11-23T15:00:53Z");
    await saveLedgerMismatch(tickerId, { kind: "catching_up", detail: "shares: Pluto's memory 1600, the ledger 1400", sinceMs });
    expect((await loadLedgerMismatchSince(tickerId))?.getTime()).toBe(sinceMs);
    expect((await testDb("pluto_vol_farmer_v4_cycles").where({ ticker_id: tickerId }).first("ledger_mismatch_detail")).ledger_mismatch_detail).toBe("shares: Pluto's memory 1600, the ledger 1400");
    await saveLedgerMismatch(tickerId, { kind: "settling" });
    expect((await loadLedgerMismatchSince(tickerId))?.getTime()).toBe(sinceMs);
    await saveLedgerMismatch(tickerId, { kind: "matches" });
    expect(await loadLedgerMismatchSince(tickerId)).toBeNull();
    expect((await testDb("pluto_vol_farmer_v4_cycles").where({ ticker_id: tickerId }).first("ledger_mismatch_detail")).ledger_mismatch_detail).toBeNull();
  });

  it("a ticker with no row yet reads none", async () => {
    expect(await loadLedgerMismatchSince(randomUUID())).toBeNull();
  });
});
