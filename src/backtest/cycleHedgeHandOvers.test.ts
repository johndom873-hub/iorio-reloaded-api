import { describe, expect, it } from "vitest";
import type { BacktestCycleTimelineRow } from "./backtestTypes.js";
import { withHedgeMarkedAtHandOvers, type HedgePutMarkOf } from "./cycleHedgeHandOvers.js";

function row(fields: Partial<BacktestCycleTimelineRow> & Pick<BacktestCycleTimelineRow, "at" | "tradingDate" | "label" | "bucket" | "instrument">): BacktestCycleTimelineRow {
  return { quantity: 0, strike: null, expiryDate: null, stockPrice: null, stockPriceSource: null, commissionDollars: null, premiumDollars: 0, stockDollars: 0, unrealized: false, ...fields };
}
const noSplits = () => 1;
const marks = (byDate: Record<string, number>): HedgePutMarkOf => (tradingDate) => byDate[tradingDate] ?? null;
const hedgeTotal = (rows: readonly BacktestCycleTimelineRow[]) => rows.filter((r) => r.bucket === "hedge").reduce((sum, r) => sum + r.premiumDollars, 0);

describe("withHedgeMarkedAtHandOvers", () => {
  // COIN #1 of "Vol Farmer · COIN · $100k · Put min 90 DTE": the $310 Put bought @ 51.40 ($10,281.36 with commission).
  const coin: BacktestCycleTimelineRow[] = [
    row({ at: "2021-04-21T14:00:00.000Z", tradingDate: "2021-04-21", label: "Sold call @ 10.45", bucket: "cc", instrument: "option", quantity: 200, strike: 355, expiryDate: "2021-05-21", premiumDollars: 2088.64 }),
    row({ at: "2021-04-21T14:00:00.000Z", tradingDate: "2021-04-21", label: "Bought put @ 51.40", bucket: "hedge", instrument: "option", quantity: 200, strike: 310, expiryDate: "2021-09-17", premiumDollars: -10281.36 }),
    row({ at: "2021-04-21T14:00:00.000Z", tradingDate: "2021-04-21", label: "Bought shares", bucket: "cc", instrument: "stock", quantity: 200, stockPrice: 310.75 }),
    row({ at: "2021-05-21T20:00:00.000Z", tradingDate: "2021-05-21", label: "Shares handed to Unstructured", bucket: "cc", instrument: "stock", quantity: 200, stockPrice: 224.35, stockDollars: -17281 }),
    row({ at: "2021-05-24T14:00:00.000Z", tradingDate: "2021-05-24", label: "Sold call @ 1.35", bucket: "cc", instrument: "option", quantity: 200, strike: 350, expiryDate: "2021-07-02", premiumDollars: 268.64 }),
    row({ at: "2021-05-24T14:00:00.000Z", tradingDate: "2021-05-24", label: "Shares handed to CC", bucket: "unstructured", instrument: "stock", quantity: 200, stockPrice: 225.3, stockDollars: 190 }),
    row({ at: "2021-07-02T20:00:00.000Z", tradingDate: "2021-07-02", label: "Shares handed to Unstructured", bucket: "cc", instrument: "stock", quantity: 200, stockPrice: 240.72, stockDollars: 3084 }),
    row({ at: "2021-09-17T20:00:00.000Z", tradingDate: "2021-09-17", label: "Sold put @ 64.81", bucket: "hedge", instrument: "option", quantity: 200, strike: 310, expiryDate: "2021-09-17", premiumDollars: 12962 }),
  ];

  it("marks the Put at each hand-over, books each period's change, and keeps the cycle's total", () => {
    const { rows, sourceIndexes } = withHedgeMarkedAtHandOvers(coin, marks({ "2021-05-21": 96.85, "2021-05-24": 94.45, "2021-07-02": 75.45 }), noSplits);
    const hedge = rows.filter((r) => r.bucket === "hedge").map((r) => [r.tradingDate, r.label, Math.round(r.premiumDollars * 100) / 100]);
    expect(hedge).toEqual([
      ["2021-04-21", "Bought put @ 51.40", 0],
      ["2021-05-21", "Put handed to Unstructured @ 96.85", 9088.64],
      ["2021-05-24", "Put handed to CC @ 94.45", -480],
      ["2021-07-02", "Put handed to Unstructured @ 75.45", -3800],
      ["2021-09-17", "Sold put @ 64.81", -2128],
    ]);
    expect(hedgeTotal(rows)).toBeCloseTo(hedgeTotal(coin), 6);
    // The added rows follow their moment's hand-over row, after the moment's Call; every other row is unchanged.
    expect(rows.map((r) => r.label).slice(3, 8)).toEqual(["Shares handed to Unstructured", "Put handed to Unstructured @ 96.85", "Sold call @ 1.35", "Shares handed to CC", "Put handed to CC @ 94.45"]);
    expect(sourceIndexes.slice(3, 8)).toEqual([3, 3, 4, 5, 5]);
    expect(rows.filter((r) => r.bucket !== "hedge")).toEqual(coin.filter((r) => r.bucket !== "hedge"));
  });

  it("gives a Put that expires worthless a row at its expiry", () => {
    const timeline = [
      row({ at: "2024-01-02T15:00:00.000Z", tradingDate: "2024-01-02", label: "Bought put @ 2.00", bucket: "hedge", instrument: "option", quantity: 100, strike: 50, expiryDate: "2024-01-05", premiumDollars: -200 }),
      row({ at: "2024-01-03T21:00:00.000Z", tradingDate: "2024-01-03", label: "Shares handed to Unstructured", bucket: "cc", instrument: "stock", quantity: 100, stockPrice: 51 }),
      row({ at: "2024-01-08T15:00:00.000Z", tradingDate: "2024-01-08", label: "Sold call @ 0.40", bucket: "cc", instrument: "option", quantity: 100, strike: 53, expiryDate: "2024-01-12", premiumDollars: 40 }),
    ];
    const { rows } = withHedgeMarkedAtHandOvers(timeline, marks({ "2024-01-03": 1.5 }), noSplits);
    expect(rows.map((r) => [r.label, r.premiumDollars])).toEqual([
      ["Bought put @ 2.00", 0],
      ["Shares handed to Unstructured", 0],
      ["Put handed to Unstructured @ 1.50", -50],
      ["Put expired worthless", -150],
      ["Sold call @ 0.40", 40],
    ]);
    expect(rows[3]).toMatchObject({ at: "2024-01-05T21:00:00.000Z", tradingDate: "2024-01-05", strike: 50, quantity: 100, expiryDate: "2024-01-05" });
    expect(hedgeTotal(rows)).toBeCloseTo(-200, 6);
  });

  it("leaves what a Put still held made since its last mark to its mark row, and books no row for a Put bought at the hand-over", () => {
    const timeline = [
      row({ at: "2024-03-01T15:00:00.000Z", tradingDate: "2024-03-01", label: "Bought put @ 3.00", bucket: "hedge", instrument: "option", quantity: 100, strike: 40, expiryDate: "2024-06-21", premiumDollars: -300, unrealized: true }),
      row({ at: "2024-03-08T21:00:00.000Z", tradingDate: "2024-03-08", label: "Shares handed to Unstructured", bucket: "cc", instrument: "stock", quantity: 100, stockPrice: 41 }),
      row({ at: "2024-03-11T14:00:00.000Z", tradingDate: "2024-03-11", label: "Bought put @ 1.00", bucket: "hedge", instrument: "option", quantity: 100, strike: 38, expiryDate: "2024-04-19", premiumDollars: -100, unrealized: true }),
      row({ at: "2024-03-11T14:00:00.000Z", tradingDate: "2024-03-11", label: "Shares handed to CC", bucket: "unstructured", instrument: "stock", quantity: 100, stockPrice: 40.5 }),
      row({ at: null, tradingDate: "2024-03-15", label: "Open put marked to market", bucket: "hedge", instrument: "option", quantity: 100, strike: 40, expiryDate: "2024-06-21", premiumDollars: 180 }),
    ];
    const { rows } = withHedgeMarkedAtHandOvers(timeline, marks({ "2024-03-08": 2.5, "2024-03-11": 2.4 }), noSplits);
    expect(rows.map((r) => [r.label, Math.round(r.premiumDollars * 100) / 100])).toEqual([
      ["Bought put @ 3.00", 0],
      ["Shares handed to Unstructured", 0],
      ["Put handed to Unstructured @ 2.50", -50],
      ["Bought put @ 1.00", 0],
      ["Shares handed to CC", 0],
      ["Put handed to CC @ 2.40", -10],
      ["Open put marked to market", -60],
    ]);
  });

  it("puts a Put's whole result on its sale when the shares were never handed over", () => {
    const timeline = [
      row({ at: "2024-05-01T14:00:00.000Z", tradingDate: "2024-05-01", label: "Bought put @ 3.27", bucket: "hedge", instrument: "option", quantity: 300, strike: 20, expiryDate: "2024-05-03", premiumDollars: -981.36 }),
      row({ at: "2024-05-02T15:00:00.000Z", tradingDate: "2024-05-02", label: "Sold put @ 4.00", bucket: "hedge", instrument: "option", quantity: 300, strike: 20, expiryDate: "2024-05-03", premiumDollars: 1197.96 }),
    ];
    const { rows } = withHedgeMarkedAtHandOvers(timeline, marks({}), noSplits);
    expect(rows.map((r) => Math.round(r.premiumDollars * 100) / 100)).toEqual([0, 216.6]);
  });

  it("carries a Put across a split on the split-adjusted scale and shows it as traded", () => {
    // A 2:1 split between the purchase and the hand-over: the factor halves, the strike as traded halves, the contracts double.
    const factor = (tradingDate: string) => (tradingDate < "2024-06-10" ? 1 : 0.5);
    const timeline = [
      row({ at: "2024-06-03T14:00:00.000Z", tradingDate: "2024-06-03", label: "Bought put @ 5.00", bucket: "hedge", instrument: "option", quantity: 100, strike: 100, expiryDate: "2024-09-20", premiumDollars: -500 }),
      row({ at: "2024-06-14T20:00:00.000Z", tradingDate: "2024-06-14", label: "Shares handed to Unstructured", bucket: "cc", instrument: "stock", quantity: 200, stockPrice: 49 }),
      row({ at: "2024-07-01T14:00:00.000Z", tradingDate: "2024-07-01", label: "Sold put @ 3.50", bucket: "hedge", instrument: "option", quantity: 200, strike: 50, expiryDate: "2024-09-20", premiumDollars: 700 }),
    ];
    const seen: [string, number][] = [];
    const { rows } = withHedgeMarkedAtHandOvers(timeline, (tradingDate, _expiry, strike) => (seen.push([tradingDate, strike]), 3), factor);
    expect(seen).toEqual([["2024-06-14", 50]]);
    expect(rows.map((r) => [r.label, r.quantity, r.strike, Math.round(r.premiumDollars * 100) / 100])).toEqual([
      ["Bought put @ 5.00", 100, 100, 0],
      ["Shares handed to Unstructured", 200, null, 0],
      ["Put handed to Unstructured @ 3.00", 200, 50, 100],
      ["Sold put @ 3.50", 200, 50, 100],
    ]);
  });
});
