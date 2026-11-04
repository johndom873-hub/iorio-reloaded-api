import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The simulator's saved portfolios against the real test database, each test in a transaction rolled back at its end:
// stored and read back, saved over, names unique whatever their case, deleted, and the requests' checks.
vi.mock("../../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run saved portfolio tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../../db/connection.js");
const { createSavedPortfolio, deleteSavedPortfolio, listSavedPortfolios, parseSavedPortfolioInput, updateSavedPortfolio } = await import("./savedPortfolioStore.js");
const testDb: Knex = db;

async function inRolledBack(work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const trx = await testDb.transaction();
  try {
    await work(trx);
  } finally {
    await trx.rollback();
  }
}

/** `work` inside a savepoint, so a refused write leaves the test's transaction usable. */
async function refused(trx: Knex.Transaction, work: (savepoint: Knex.Transaction) => Promise<unknown>): Promise<unknown> {
  try {
    await trx.transaction(async (savepoint) => {
      await work(savepoint);
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to be refused");
}

afterAll(async () => {
  await testDb.destroy();
});

describe("saved portfolios", () => {
  it("stores a portfolio and reads it back as saved, by name", async () => {
    await inRolledBack(async (trx) => {
      const created = await createSavedPortfolio({ name: "Fits $1M", tickers: [{ symbol: "XLE", allocationPct: 12.5 }, { symbol: "C", allocationPct: null }], accountDollars: 1_000_000 }, trx);
      await createSavedPortfolio({ name: "all suits", tickers: [], accountDollars: 250_000.5 }, trx);
      const listed = await listSavedPortfolios(trx);
      const names = listed.map((portfolio) => portfolio.name);
      expect(names.indexOf("all suits")).toBeLessThan(names.indexOf("Fits $1M"));
      const read = listed.find((portfolio) => portfolio.id === created.id)!;
      expect(read).toEqual(created);
      expect(read.tickers).toEqual([{ symbol: "XLE", allocationPct: 12.5 }, { symbol: "C", allocationPct: null }]);
      expect(read.accountDollars).toBe(1_000_000);
      expect(listed.find((portfolio) => portfolio.name === "all suits")!.accountDollars).toBe(250_000.5);
    });
  });

  it("saves over a portfolio, its name included, and moves its updated time", async () => {
    await inRolledBack(async (trx) => {
      const created = await createSavedPortfolio({ name: "Book A", tickers: [{ symbol: "XLE", allocationPct: null }], accountDollars: 1_000_000 }, trx);
      await trx("backtest_portfolios").where({ id: created.id }).update({ updated_at: trx.raw("now() - interval '1 hour'") });
      const saved = await updateSavedPortfolio(created.id, { name: "Book B", tickers: [{ symbol: "NVDA", allocationPct: 40 }], accountDollars: 2_000_000 }, trx);
      expect(saved).toMatchObject({ id: created.id, name: "Book B", tickers: [{ symbol: "NVDA", allocationPct: 40 }], accountDollars: 2_000_000, createdAt: created.createdAt });
      // Back from an hour ago to the transaction's now.
      expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt) - 30 * 60_000);
      expect((await listSavedPortfolios(trx)).filter((portfolio) => portfolio.id === created.id)).toEqual([saved]);
    });
  });

  it("refuses a name another portfolio has, whatever its case, on create and on save", async () => {
    await inRolledBack(async (trx) => {
      await createSavedPortfolio({ name: "All suits", tickers: [], accountDollars: 1_000_000 }, trx);
      const other = await createSavedPortfolio({ name: "Other", tickers: [], accountDollars: 1_000_000 }, trx);
      const onCreate = (await refused(trx, (savepoint) => createSavedPortfolio({ name: "ALL SUITS", tickers: [], accountDollars: 1 }, savepoint))) as { httpStatus: number; message: string };
      expect(onCreate.httpStatus).toBe(409);
      expect(onCreate.message).toBe('A portfolio named "ALL SUITS" already exists. Choose another name.');
      const onSave = (await refused(trx, (savepoint) => updateSavedPortfolio(other.id, { name: "all suits", tickers: [], accountDollars: 1 }, savepoint))) as { httpStatus: number };
      expect(onSave.httpStatus).toBe(409);
      // Saving under its own name is fine.
      await updateSavedPortfolio(other.id, { name: "OTHER", tickers: [], accountDollars: 1 }, trx);
    });
  });

  it("deletes a portfolio, and answers 404 for one that is gone", async () => {
    await inRolledBack(async (trx) => {
      const created = await createSavedPortfolio({ name: "Gone soon", tickers: [], accountDollars: 1_000_000 }, trx);
      await deleteSavedPortfolio(created.id, trx);
      expect((await listSavedPortfolios(trx)).some((portfolio) => portfolio.id === created.id)).toBe(false);
      expect(((await refused(trx, (savepoint) => deleteSavedPortfolio(created.id, savepoint))) as { httpStatus: number }).httpStatus).toBe(404);
      expect(((await refused(trx, (savepoint) => updateSavedPortfolio(created.id, { name: "x", tickers: [], accountDollars: 1 }, savepoint))) as { httpStatus: number }).httpStatus).toBe(404);
    });
  });
});

describe("a saved portfolio's request", () => {
  it("trims the name and takes the book as the simulator does, or no tickers yet", () => {
    expect(parseSavedPortfolioInput({ name: "  Fits $1M ", tickers: [{ symbol: "XLE" }, { symbol: "C", allocationPct: 20 }], accountDollars: 1_000_000 })).toEqual({
      name: "Fits $1M",
      tickers: [{ symbol: "XLE", allocationPct: null }, { symbol: "C", allocationPct: 20 }],
      accountDollars: 1_000_000,
    });
    expect(parseSavedPortfolioInput({ name: "Empty", tickers: [], accountDollars: 1_000_000 })).toEqual({ name: "Empty", tickers: [], accountDollars: 1_000_000 });
  });

  it("refuses an empty or over-long name, a bad book and a bad account", () => {
    const book = { tickers: [{ symbol: "XLE" }], accountDollars: 1_000_000 };
    expect(() => parseSavedPortfolioInput({ ...book, name: "   " })).toThrow("name must not be empty.");
    expect(() => parseSavedPortfolioInput({ ...book, name: "x".repeat(61) })).toThrow("name may be at most 60 characters.");
    expect(() => parseSavedPortfolioInput({ name: "A", tickers: [{ symbol: "XLE" }, { symbol: "XLE" }], accountDollars: 1 })).toThrow("tickers lists a ticker twice.");
    expect(() => parseSavedPortfolioInput({ name: "A", tickers: [], accountDollars: 0 })).toThrow("accountDollars must be a number above 0.");
    expect(() => parseSavedPortfolioInput({ name: "A", accountDollars: 1 })).toThrow("tickers must list at least one ticker.");
  });
});
