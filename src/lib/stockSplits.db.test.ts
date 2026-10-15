import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

// stock_splits on a private copy of the test tables: recorded once per ticker and effective date, pending until the
// records are rewritten.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("./testSupport/isolatedTestSchema.js");
const { loadPendingStockSplits, recordStockSplit } = await import("./stockSplits.js");
const testDb: Knex = db;
const tickerId = randomUUID();

beforeAll(async () => {
  await testDb("tickers").insert({ id: tickerId, symbol: "SPLT", company_name: "Split Co" });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("stock splits", () => {
  it("records a split once (the morning and the nightly checks both see it) and keeps it pending until the records are rewritten", async () => {
    await recordStockSplit({ tickerId, ratio: 2, effectiveDateIso: "2026-10-20" });
    await recordStockSplit({ tickerId, ratio: 2, effectiveDateIso: "2026-10-20" });
    await recordStockSplit({ tickerId, ratio: 0.1, effectiveDateIso: "2026-11-02" });
    expect(await loadPendingStockSplits([tickerId])).toEqual([
      { tickerId, ratio: 2, effectiveDateIso: "2026-10-20", recordsRewrittenAt: null },
      { tickerId, ratio: 0.1, effectiveDateIso: "2026-11-02", recordsRewrittenAt: null },
    ]);
    await testDb("stock_splits").where({ ticker_id: tickerId, effective_date: "2026-10-20" }).update({ records_rewritten_at: new Date() });
    expect((await loadPendingStockSplits([tickerId])).map((split) => split.effectiveDateIso)).toEqual(["2026-11-02"]);
    expect(await loadPendingStockSplits([])).toEqual([]);
  });
});
