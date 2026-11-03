import { afterAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// A Call Vol Farmer v4's commission cap kept from being sold reaches Pluto's activity once per ticker, contract and
// trading day, however many looks find it again. On a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { recordCommissionCapSkip } = await import("./ledger.js");
const testDb: Knex = db;

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const skip = { passId: "pass-1", symbol: "VFT", tradingDate: "2026-11-04", position: "first" as const, expiry: "2026-11-04", strike: 105, dte: 0, fillPrice: 0.05, premiumDollars: 5, commissionDollars: 1.11, maxShareOfPremium: 0.2 };
const events = async () => testDb("pluto_events").where({ type: "call_skipped_commission" }).orderBy("id").select("payload");

describe("recordCommissionCapSkip", () => {
  it("records a contract once a day; another strike, ticker or day is recorded too", async () => {
    await recordCommissionCapSkip(skip);
    await recordCommissionCapSkip({ ...skip, passId: "pass-2" });
    expect((await events()).map((row) => row.payload.passId)).toEqual(["pass-1"]);

    await recordCommissionCapSkip({ ...skip, strike: 106 });
    await recordCommissionCapSkip({ ...skip, symbol: "OTH" });
    await recordCommissionCapSkip({ ...skip, tradingDate: "2026-11-05" });
    expect((await events()).map((row) => [row.payload.symbol, row.payload.strike, row.payload.tradingDate])).toEqual([
      ["VFT", 105, "2026-11-04"],
      ["VFT", 106, "2026-11-04"],
      ["OTH", 105, "2026-11-04"],
      ["VFT", 105, "2026-11-05"],
    ]);
  });
});
