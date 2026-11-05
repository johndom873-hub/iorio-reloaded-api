import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The books' statement import against a private copy of the test tables (Marcelo 2026-11-05); the books' tables are
// cleared before each test.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { applyBooksCutover } = await import("./cutover.js");
const { importStatementIntoBooks } = await import("./statementImport.js");
const { statementCutOffAt } = await import("./statementAttribution.js");
const { loadLedgerCashByBook } = await import("./bookLedger.js");

const plutoSymbol = "ZZBOOKSP";
const manualSymbol = "ZZBOOKSM";

async function clearBooks() {
  await db("book_cash_entries").whereNotNull("allocates_entry_id").del();
  for (const table of ["book_cash_entries", "book_leg_transfers", "ticker_book_periods", "book_value_snapshots", "book_statement_imports", "books_cutover"]) await db(table).del();
}

async function startBooks(statementRowKeys: string[] = []) {
  for (const symbol of [plutoSymbol, manualSymbol]) if (!(await db("tickers").where({ symbol }).first("id"))) await db("tickers").insert({ symbol });
  await applyBooksCutover(
    {
      mode: "statement",
      cutOverAt: statementCutOffAt("20990105"),
      statementToDate: "2099-01-05",
      ibkrCash: 100_000,
      plutoStartingValue: 60_000,
      plutoPositionsValue: 0,
      manualPositionsValue: 0,
      plutoOpeningCash: 60_000,
      manualOpeningCash: 40_000,
      plutoSymbols: [plutoSymbol],
      statementRowKeys,
      legsWithoutClosingPrice: [],
    },
    null,
  );
}

/** A statement through 6 Jan 2099: a Pluto fill, a Manual fill, a fee with its GST and a deposit. Ending cash adds them up. */
function statement(overrides: { endingCash?: string; omit?: string } = {}) {
  const sections: Record<string, unknown> = {
    fromDate: "20981208",
    toDate: "20990106",
    whenGenerated: "20990107;221441",
    CashReport: { CashReportCurrency: { levelOfDetail: "BaseCurrency", startingCash: "100000", endingCash: overrides.endingCash ?? "148989.505" } },
    Trades: {
      Trade: [
        { transactionID: "t-old", levelOfDetail: "EXECUTION", assetCategory: "STK", symbol: plutoSymbol, underlyingSymbol: "", conid: "1", dateTime: "20990105;100000", tradeDate: "20990105", buySell: "BUY", quantity: "10", netCash: "-999" },
        { transactionID: "t1", levelOfDetail: "EXECUTION", assetCategory: "STK", symbol: plutoSymbol, underlyingSymbol: "", conid: "1", dateTime: "20990106;100000", tradeDate: "20990106", buySell: "BUY", quantity: "10", netCash: "-1000" },
        { transactionID: "t2", levelOfDetail: "EXECUTION", assetCategory: "OPT", symbol: `${manualSymbol}  990116P00050000`, underlyingSymbol: manualSymbol, conid: "2", dateTime: "20990106;110000", tradeDate: "20990106", buySell: "SELL", quantity: "-1", netCash: "-5.495" },
      ],
    },
    CashTransactions: { CashTransaction: { transactionID: "c1", levelOfDetail: "DETAIL", type: "Other Fees", amount: "-4.5", dateTime: "20990106;170205", description: "MARKET DATA", symbol: "" } },
    SalesTaxes: { SalesTax: { transactionID: "s1", taxableTransactionID: "c1", salesTax: "-0.5", date: "20990106", taxableDescription: "MARKET DATA" } },
    Transfers: { Transfer: { assetCategory: "CASH", direction: "IN", cashTransfer: "50000", fxRateToBase: "1", date: "20990106", dateTime: "20990106;120000", description: "TRANSFER IN" } },
  };
  if (overrides.omit) delete sections[overrides.omit];
  return sections;
}

beforeEach(clearBooks);
afterAll(async () => {
  await dropIsolatedTestDatabase(db);
});

describe("importStatementIntoBooks", () => {
  it("posts each row to its book, skips the rows already in the opening cash and closes against IBKR's ending cash", async () => {
    await startBooks(["trade:t-old"]);
    const result = await importStatementIntoBooks(statement());
    // 100,000 opening − 1,000 (Pluto fill) − 5.495 (Manual fill) − 4.5 fee − 0.5 GST + 50,000 deposit = 148,989.505
    expect(result).toMatchObject({ posted: true, toDate: "20990106", gap: 0, needsReviewCount: 0, problems: [] });
    const cash = await loadLedgerCashByBook(null);
    // The fee and its GST split by the cut-over's book values, 60,000 / 40,000.
    expect(cash.pluto).toBeCloseTo(60_000 - 1_000 - 2.7 - 0.3, 6);
    expect(cash.manual).toBeCloseTo(40_000 - 5.495 - 1.8 - 0.2, 6);
    expect(cash.unallocated).toBe(50_000);
    expect(await db("book_cash_entries").where({ source_row_key: "trade:t-old" }).first("id")).toBeUndefined();
  });

  it("adds nothing when the same statement is read again", async () => {
    await startBooks(["trade:t-old"]);
    await importStatementIntoBooks(statement());
    const again = await importStatementIntoBooks(statement());
    expect(again).toMatchObject({ posted: true, newEntryCount: 0, gap: 0 });
    expect(Number((await db("book_cash_entries").count({ count: "*" }).first())?.count)).toBe(2 + 1 + 1 + 2 + 2 + 1);
  });

  it("reports a gap against IBKR's ending cash", async () => {
    await startBooks(["trade:t-old"]);
    const result = await importStatementIntoBooks(statement({ endingCash: "148990.505" }));
    expect(result.gap).toBeCloseTo(1, 6);
    expect(result.problems).toEqual(["the books' cash differs from IBKR's ending cash of 20990106 by 1.00"]);
  });

  it("posts nothing from a statement missing a section the books need", async () => {
    await startBooks();
    const result = await importStatementIntoBooks(statement({ omit: "SalesTaxes" }));
    expect(result.posted).toBe(false);
    expect(result.problems).toEqual(["IBKR's statement lacks SalesTaxes: the books keep counting from the app's own fills"]);
    expect(await db("book_statement_imports").first("id")).toBeUndefined();
    expect(Number((await db("book_cash_entries").count({ count: "*" }).first())?.count)).toBe(2);
  });
});
