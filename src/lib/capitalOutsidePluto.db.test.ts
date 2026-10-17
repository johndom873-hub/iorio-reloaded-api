import knexLibrary from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// The loaders' SQL against the real schema. The totals depend on whatever the shared test database holds, so only their
// shape is checked here; the boundary itself is unit-tested in capitalOutsidePluto.test.ts.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { loadTraderCapitalFigures } = await import("./capitalOutsidePluto.js");

afterAll(async () => {
  await db.destroy();
});

describe("loadTraderCapitalFigures", () => {
  it("reads the capital in use outside Pluto and Pluto's capital budget", async () => {
    const figures = await loadTraderCapitalFigures("00000000-0000-0000-0000-000000000000");
    expect(Number.isFinite(figures.capitalInUseOutsidePluto)).toBe(true);
    expect(figures.plutoCapitalBudgetPct).toBeGreaterThanOrEqual(0);
    expect(figures.plutoCapitalBudgetPct).toBeLessThanOrEqual(100);
  });
});
