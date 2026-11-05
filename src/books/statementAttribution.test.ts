import { describe, expect, it } from "vitest";
import { attributeStatement, interestPeriodOf, statementBaseCurrencyProblem, statementCutOffAt, type StatementAttributionContext } from "./statementAttribution.js";
import { splitAmountByWeights } from "./proRataSplit.js";
import { bookOfLegAt, bookOfTickerAt } from "./tickerBookPeriods.js";

const context: StatementAttributionContext = {
  bookOfSymbolAt: (symbol, at) => (symbol === "AMD" && at.getTime() >= Date.parse("2026-11-05T14:00:00Z") ? "pluto" : symbol === "INTC" ? "pluto" : "manual"),
  isHedgeOptionContract: (conid) => conid === "777",
  bookValueWeightsAt: () => ({ pluto: 600_000, manual: 400_000 }),
  dailyCashWeightsBetween: () => ({ pluto: 13_500_000, manual: 4_500_000 }),
};

function statementWith(sections: Record<string, unknown>) {
  return { fromDate: "20261005", toDate: "20261103", whenGenerated: "20261104;221441", CashReport: { CashReportCurrency: { levelOfDetail: "BaseCurrency", startingCash: "100000", endingCash: "0" } }, ...sections };
}

describe("attributeStatement", () => {
  it("posts a fill to its ticker's book at the fill's time, and a hedge's option to Manual", () => {
    const parsed = attributeStatement(
      statementWith({
        Trades: {
          Trade: [
            { transactionID: "1", levelOfDetail: "EXECUTION", assetCategory: "STK", symbol: "AMD", underlyingSymbol: "", conid: "1", dateTime: "20261105;085900", tradeDate: "20261105", buySell: "BUY", quantity: "100", netCash: "-16241.00" },
            { transactionID: "2", levelOfDetail: "EXECUTION", assetCategory: "STK", symbol: "AMD", underlyingSymbol: "", conid: "1", dateTime: "20261105;090100", tradeDate: "20261105", buySell: "BUY", quantity: "100", netCash: "-16245.00" },
            { transactionID: "3", levelOfDetail: "EXECUTION", assetCategory: "OPT", symbol: "INTC  261113P00090000", underlyingSymbol: "INTC", conid: "777", dateTime: "20261105;100000", tradeDate: "20261105", buySell: "BUY", quantity: "1", netCash: "-120.50" },
          ],
        },
      }),
      context,
    );
    expect(parsed.entries.map((entry) => [entry.sourceRowKey, entry.bookKey, entry.amount])).toEqual([
      ["trade:1", "manual", -16241],
      ["trade:2", "pluto", -16245],
      ["trade:3", "manual", -120.5],
    ]);
  });

  it("splits a fee and its GST by book value and interest by daily cash, adding back up exactly", () => {
    const parsed = attributeStatement(
      statementWith({
        CashTransactions: {
          CashTransaction: [
            { transactionID: "10", levelOfDetail: "DETAIL", type: "Other Fees", amount: "-4.5", dateTime: "20261103;170205", description: "MARKET DATA FOR NOV 2026", symbol: "" },
            { transactionID: "11", levelOfDetail: "DETAIL", type: "Broker Interest Received", amount: "3000", dateTime: "20261105", description: "USD CREDIT INT FOR OCT-2026", symbol: "" },
          ],
        },
        SalesTaxes: { SalesTax: { transactionID: "12", taxableTransactionID: "10", salesTax: "-0.405", date: "20261103", taxableDescription: "MARKET DATA" } },
      }),
      context,
    );
    const amountsOf = (key: string) => parsed.entries.filter((entry) => entry.sourceRowKey === key).map((entry) => [entry.bookKey, entry.amount]);
    expect(amountsOf("cash:10")).toEqual([["pluto", -2.7], ["manual", -1.8]]);
    expect(amountsOf("tax:12")).toEqual([["pluto", -0.243], ["manual", -0.162]]);
    expect(amountsOf("cash:11")).toEqual([["pluto", 2250], ["manual", 750]]);
  });

  it("skips a trade's GST (already in its net cash) and flags a tax row it cannot place", () => {
    const parsed = attributeStatement(
      statementWith({
        Trades: { Trade: { transactionID: "20", levelOfDetail: "EXECUTION", assetCategory: "OPT", symbol: "BMNR  261009P00024500", underlyingSymbol: "BMNR", conid: "5", dateTime: "20261005;102104", tradeDate: "20261005", buySell: "SELL", quantity: "-1", netCash: "13.87663619" } },
        SalesTaxes: {
          SalesTax: [
            { transactionID: "21", taxableTransactionID: "983442016", salesTax: "-0.09275481", date: "20261005", taxableDescription: "SG Goods and Services Tax (Sell 1 BMNR  261009P00024500)" },
            { transactionID: "22", taxableTransactionID: "999", salesTax: "-1", date: "20261005", taxableDescription: "Something else" },
          ],
        },
      }),
      context,
    );
    expect(parsed.entries.filter((entry) => entry.sourceRowKey === "tax:21")).toEqual([]);
    const unplaced = parsed.entries.filter((entry) => entry.sourceRowKey === "tax:22");
    expect(unplaced.map((entry) => [entry.bookKey, entry.amount, entry.needsReview])).toEqual([
      ["pluto", -0.6, true],
      ["manual", -0.4, true],
    ]);
  });

  it("puts deposits and cash transfers in Unallocated, a dividend in the ex-date's book, and reports a securities transfer", () => {
    const parsed = attributeStatement(
      statementWith({
        CashTransactions: {
          CashTransaction: [
            { transactionID: "30", levelOfDetail: "DETAIL", type: "Deposits/Withdrawals", amount: "50000", dateTime: "20261104;101500", description: "CASH RECEIPTS", symbol: "" },
            { transactionID: "31", levelOfDetail: "DETAIL", type: "Dividends", amount: "52", dateTime: "20261105", exDate: "20261104", description: "AMD CASH DIVIDEND", symbol: "AMD" },
          ],
        },
        Transfers: {
          Transfer: [
            { assetCategory: "CASH", direction: "OUT", cashTransfer: "1000", fxRateToBase: "1", date: "20261104", dateTime: "20261104;120000", description: "TRANSFER TO U9813636" },
            { assetCategory: "STK", direction: "IN", cashTransfer: "0", date: "20261104", description: "SHARES IN" },
          ],
        },
      }),
      context,
    );
    expect(parsed.entries.map((entry) => [entry.kind, entry.bookKey, entry.amount])).toEqual([
      ["external_transfer", "unallocated", 50000],
      ["dividend", "manual", 52],
      ["external_transfer", "unallocated", -1000],
    ]);
    expect(parsed.problems).toEqual(["transfer of STK on 20261104: not posted, needs a person"]);
  });
});

describe("statement dates", () => {
  it("cuts a statement off at the start of the next day, New York time (EST after 1 Nov, EDT before)", () => {
    expect(statementCutOffAt("20261103").toISOString()).toBe("2026-11-04T05:00:00.000Z");
    expect(statementCutOffAt("20261029").toISOString()).toBe("2026-10-30T04:00:00.000Z");
  });

  it("reads the month an interest row is for, else takes the month before the row", () => {
    expect(interestPeriodOf("USD CREDIT INT FOR SEP-2026", "2026-10-05")).toEqual({ startIso: "2026-09-01", endIso: "2026-09-30" });
    expect(interestPeriodOf("INTEREST", "2026-03-04")).toEqual({ startIso: "2026-02-01", endIso: "2026-02-28" });
  });
});

describe("splitAmountByWeights", () => {
  it("keeps 6 decimals and gives Manual the rest, so the parts add up exactly", () => {
    const parts = splitAmountByWeights(-0.405, { pluto: 1, manual: 2 });
    expect(parts).toEqual({ pluto: -0.135, manual: -0.27 });
    const odd = splitAmountByWeights(10, { pluto: 1, manual: 2 });
    expect(odd.pluto + odd.manual).toBeCloseTo(10, 9);
    expect(odd).toEqual({ pluto: 3.333333, manual: 6.666667 });
  });

  it("splits in halves when neither book has a positive weight", () => {
    expect(splitAmountByWeights(-3, { pluto: 0, manual: -5 })).toEqual({ pluto: -1.5, manual: -1.5 });
  });
});

describe("ticker book periods", () => {
  const periods = [{ tickerId: "amd", startedAt: new Date("2026-11-05T14:00:00Z"), endedAt: new Date("2026-11-06T14:00:00Z") }];
  it("is Pluto's inside a period and Manual's outside it", () => {
    expect(bookOfTickerAt(periods, "amd", new Date("2026-11-05T13:59:59Z"))).toBe("manual");
    expect(bookOfTickerAt(periods, "amd", new Date("2026-11-05T14:00:00Z"))).toBe("pluto");
    expect(bookOfTickerAt(periods, "amd", new Date("2026-11-06T14:00:00Z"))).toBe("manual");
  });
  it("keeps a hedge in Manual on a Pluto ticker", () => {
    expect(bookOfLegAt(periods, "amd", "hedge", new Date("2026-11-05T15:00:00Z"))).toBe("manual");
    expect(bookOfLegAt(periods, "amd", "covered_call", new Date("2026-11-05T15:00:00Z"))).toBe("pluto");
  });
});

describe("the statement's base currency", () => {
  it("accepts a USD-based statement (USD rows at a rate of 1)", () => {
    expect(statementBaseCurrencyProblem({ Trades: { Trade: [{ currency: "USD", fxRateToBase: "1" }] }, CashTransactions: "" })).toBeNull();
  });

  it("refuses a statement whose USD rows convert to another base", () => {
    expect(statementBaseCurrencyProblem({ Trades: { Trade: { currency: "USD", fxRateToBase: "1.2762" } } })).toBe("IBKR's statement is not in US dollars (a USD row converts to its base at 1.2762), so the books cannot use it");
  });
});
