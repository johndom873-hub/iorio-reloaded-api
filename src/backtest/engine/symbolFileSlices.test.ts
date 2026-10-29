import { describe, expect, it } from "vitest";
import { decodeSlice, packSlice, sliceValueAt, tenOClockQuoteColumns, type SliceRow } from "./symbolFileSlices.js";

// The slices of schema 4 (symbolFileSlices.ts, Marcelo 2026-10-29) hold every value exactly.

const decodedRows = (rows: readonly SliceRow[]) => {
  const slice = decodeSlice(packSlice(rows, tenOClockQuoteColumns), tenOClockQuoteColumns);
  return Array.from({ length: slice.count }, (_, index) => tenOClockQuoteColumns.map((kind, column) => (kind === "right" ? (slice.puts[index] === 1 ? "P" : "C") : sliceValueAt(slice.columns[column]!, index))));
};

describe("slices", () => {
  it("give back every value exactly, whatever width each column needs", () => {
    const rows: SliceRow[] = [
      [100, "C", 1.25, 1.3, 10, 12, 1500],
      [100, "P", null, 0.05, null, 3, null],
      [102.5, "C", 0, 0, 0, 0, 0],
      [105, "P", 655.36, 700.01, 70_000, 65_536, 3_000_000_000],
      [1000.125, "C", 2, 1.5, 1, 1, 0],
    ];
    expect(decodedRows(rows)).toStrictEqual(rows);
  });

  it("keep a column that is not exact in its unit as stored, and a slice of equal values", () => {
    const halfCent: SliceRow[] = [
      [50, "C", 0.015, 1, 5, 5, 0],
      [55, "P", 0.02, 1.01, 5, 5, 0],
    ];
    expect(decodedRows(halfCent)).toStrictEqual(halfCent);
    const equal: SliceRow[] = [[50, "C", 1, 1, 5, 5, 0]];
    expect(decodedRows(equal)).toStrictEqual(equal);
  });

  it("refuse a right other than C or P", () => {
    expect(() => packSlice([[50, "X", 1, 1, 5, 5, 0]], tenOClockQuoteColumns)).toThrow("right X");
  });
});
