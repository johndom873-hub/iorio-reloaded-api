import { describe, expect, it } from "vitest";
import { baselineNightFor, buildPnlAnalysis, cashComponentOfKind, nightChanges, type PnlAnalysisInputs, type StoredMoveRow, type StoredRow } from "./pnlAnalysis.js";

// Three nights; Pluto holds AAA's covered call, Manual BBB's put. Every figure below is worked out by hand.
const nights = ["2026-11-04", "2026-11-05", "2026-11-06"];
const capturedAt = (night: string) => new Date(`${night}T22:30:00Z`);

function stored(night: string, symbol: string, book: "pluto" | "manual", bucket: "cc" | "csp", total: number, capital: number): StoredRow {
  return { snapshotDate: night, tickerId: `id-${symbol}`, symbol, bucket, bookKey: book, premiumGross: total + 1, stockGross: 0, commissions: -1, total, unrealized: 0, capital, flaggedTotal: 0, flagReasons: [] };
}

function inputs(): PnlAnalysisInputs {
  const series = (values: number[]) => values.map((bookValue, index) => ({ snapshotDate: nights[index]!, bookValue, movedIn: 0, dailyPnl: index === 0 ? null : bookValue - values[index - 1]! }));
  return {
    accountRows: [1_000, 1_100, 1_050].map((nav, index) => ({ night: nights[index]!, capturedAt: capturedAt(nights[index]!), nav, flow: 0 })),
    plutoSeries: series([500, 560, 530]), // +60, −30
    manualSeries: series([500, 535, 515]), // +35, −20
    bookCaptures: (["pluto", "manual"] as const).flatMap((book) => nights.map((night) => ({ book, night, capturedAt: capturedAt(night) }))),
    attributionNights: new Set(nights),
    storedRows: [
      stored(nights[0]!, "AAA", "pluto", "cc", 10, 1_000),
      stored(nights[1]!, "AAA", "pluto", "cc", 65, 1_000), // +55
      stored(nights[2]!, "AAA", "pluto", "cc", 40, 0), // −25
      stored(nights[1]!, "BBB", "manual", "csp", 35, 5_000), // +35
      stored(nights[2]!, "BBB", "manual", "csp", 20, 5_000), // −15
    ],
    moveRows: [],
    // $5 of interest booked by IBKR before the 5 Nov snapshot, posted to Manual's ledger with the 6 Nov statement.
    ledgerItems: [{ book: "manual", kind: "interest", symbol: null, amount: 5, effectiveAt: new Date("2026-11-05T12:00:00Z"), createdAt: new Date("2026-11-06T21:00:00Z") }],
    accountItems: [],
    closedShortOptions: [],
    riskFreeAt: () => 4,
  };
}

describe("buildPnlAnalysis", () => {
  const analysis = buildPnlAnalysis(inputs(), null, null);

  it("reconciles each book night by night: book P&L = strategies + cash + Unexplained", () => {
    const pluto = analysis.books.pluto.nights;
    expect(pluto.map((night) => [night.night, night.bookPnl, night.buckets!.cc.total, night.unexplained])).toEqual([
      ["2026-11-05", 60, 55, 5],
      ["2026-11-06", -30, -25, -5],
    ]);
    const manual = analysis.books.manual.nights;
    expect(manual.map((night) => [night.bookPnl, night.buckets!.csp.total, night.cash.interest, night.unexplained])).toEqual([
      [35, 35, 0, 0],
      [-20, -15, 5, -10],
    ]);
  });

  it("names IBKR's valuation of the account apart from the books in All books, and its cash items by IBKR's date", () => {
    const all = analysis.books.all.nights;
    // 5 Nov: account +100, books +95 → $5 of IBKR valuation; strategies +90, interest +5 → nothing unexplained.
    expect(all.map((night) => [night.bookPnl, night.ibkrValuationDifference, night.cash.interest, night.unexplained])).toEqual([
      [100, 5, 5, 0],
      [-50, 0, 0, -10],
    ]);
  });

  it("sums each ticker's range with the capital held each day", () => {
    expect(analysis.books.pluto.tickers).toMatchObject([{ symbol: "AAA", book: "pluto", bucket: "cc", total: 30, premiumGross: 30, commissions: 0, capitalDays: 2_000 }]); // the $1 commission was already in before the range
    expect(analysis.books.all.tickers.map((row) => row.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(analysis.range).toEqual({ baselineNight: "2026-11-04", lastNight: "2026-11-06" });
  });

  it("starts a range at the last night before its first day, and the risk figures from there", () => {
    expect(baselineNightFor(nights, "2026-11-06")).toBe("2026-11-05");
    expect(baselineNightFor(nights, "2026-11-01")).toBe("2026-11-04");
    const lastDay = buildPnlAnalysis(inputs(), "2026-11-06", "2026-11-06");
    expect(lastDay.books.pluto.risk).toMatchObject({ baselineNight: "2026-11-05", pnl: -30 });
    expect(lastDay.books.pluto.nights.map((night) => night.night)).toEqual(["2026-11-06"]);
  });

  it("marks a night whose attribution was never computed instead of counting it as zero", () => {
    const missing = buildPnlAnalysis({ ...inputs(), attributionNights: new Set([nights[0]!, nights[2]!]) }, null, null);
    expect(missing.books.pluto.missingAttributionNights).toEqual(["2026-11-05", "2026-11-06"]);
    expect(missing.books.pluto.nights[0]!.unexplained).toBeNull();
  });
});

describe("cashComponentOfKind", () => {
  it("files withholding with a dividend when it names a symbol, else with interest", () => {
    expect(cashComponentOfKind("withholding_tax", "NVDA")).toBe("dividends");
    expect(cashComponentOfKind("withholding_tax", null)).toBe("interest");
    expect(cashComponentOfKind("sales_tax", null)).toBe("fees");
    expect(cashComponentOfKind("corporate_action", "AAA")).toBe("otherCash");
  });
});

describe("summarizeTickerCycles", () => {
  it("counts the cycles held during the range and says whether one is open", async () => {
    const { summarizeTickerCycles } = await import("./pnlAnalysis.js");
    const at = (iso: string) => new Date(iso);
    const summary = summarizeTickerCycles(
      [
        { symbol: "AAA", cycles: [
          { startAt: at("2026-10-01T15:00:00Z"), endAt: at("2026-11-04T20:00:00Z"), status: "closed" }, // ended on the baseline night: before the range
          { startAt: at("2026-11-05T15:00:00Z"), endAt: at("2026-11-05T20:00:00Z"), status: "closed" },
          { startAt: at("2026-11-06T15:00:00Z"), endAt: null, status: "open" },
        ] },
        { symbol: "BBB", cycles: [{ startAt: at("2026-11-07T15:00:00Z"), endAt: null, status: "open" }] }, // after the range's last night
      ],
      { baselineNight: "2026-11-04", lastNight: "2026-11-06" },
    );
    expect(summary).toEqual({ AAA: { inRange: 2, hasOpenCycle: true }, BBB: { inRange: 0, hasOpenCycle: true } });
  });
});

describe("nightChanges: a ticker moved between the books during the night", () => {
  // WDC moved Manual → Pluto at 10:30 ET on 6 Nov, between the 17:30 ET captures of 5 and 6 Nov (24 h): 17 h in Manual, 7 h in Pluto.
  const before = stored("2026-11-05", "WDC", "manual", "cc", 100, 2_400);
  const now = stored("2026-11-06", "WDC", "pluto", "cc", 130, 2_400);
  const atMove: StoredMoveRow = { ...stored("2026-11-06", "WDC", "manual", "cc", 120, 2_400), movedAt: new Date("2026-11-06T15:30:00Z"), fromBook: "manual", toBook: "pluto" };
  const night = { startsAt: new Date("2026-11-05T22:30:00Z"), endsAt: new Date("2026-11-06T22:30:00Z") };

  it("gives the book it left the change to the move and the book it joined the rest, the capital-days by time", () => {
    const changes = nightChanges([now], [before], 1, [atMove], night);
    expect(changes.map((change) => ({ book: change.book, total: change.total, capitalDays: Math.round(change.capitalDays) }))).toEqual([
      { book: "manual", total: 20, capitalDays: 1_700 },
      { book: "pluto", total: 10, capitalDays: 700 },
    ]);
  });

  it("splits twice when the ticker moves back the same night, and not at all without the night's times", () => {
    const backAtNoon: StoredMoveRow = { ...atMove, movedAt: new Date("2026-11-06T17:30:00Z"), fromBook: "pluto", toBook: "manual", total: 125 };
    const backInManual = { ...now, bookKey: "manual" as const };
    expect(nightChanges([backInManual], [before], 1, [backAtNoon, atMove], night).map((change) => [change.book, change.total])).toEqual([["manual", 20], ["pluto", 5], ["manual", 5]]);
    expect(nightChanges([now], [before], 1, [atMove]).map((change) => [change.book, change.total])).toEqual([["pluto", 30]]);
  });
});
