import { describe, expect, it } from "vitest";
import { parseIbkrLiquidHours } from "./fetchLiquidHours.js";

describe("parseIbkrLiquidHours", () => {
  it("reads the current format, half days and closed days included", () => {
    expect(parseIbkrLiquidHours("20261125:0930-20261125:1600;20261126:CLOSED;20261127:0930-20261127:1300")).toEqual([
      { dateIso: "2026-11-25", openHhmm: "09:30", closeHhmm: "16:00", closed: false },
      { dateIso: "2026-11-26", openHhmm: null, closeHhmm: null, closed: true },
      { dateIso: "2026-11-27", openHhmm: "09:30", closeHhmm: "13:00", closed: false },
    ]);
  });
  it("reads the legacy format with several ranges, taking the first open and the last close", () => {
    expect(parseIbkrLiquidHours("20090507:0700-1830,1830-2330;20090508:CLOSED")).toEqual([
      { dateIso: "2009-05-07", openHhmm: "07:00", closeHhmm: "23:30", closed: false },
      { dateIso: "2009-05-08", openHhmm: null, closeHhmm: null, closed: true },
    ]);
  });
  it("ignores a range that ends on another day and tolerates junk", () => {
    expect(parseIbkrLiquidHours("20261127:1800-20261128:1700;garbage;")).toEqual([{ dateIso: "2026-11-27", openHhmm: "18:00", closeHhmm: null, closed: false }]);
    expect(parseIbkrLiquidHours("")).toEqual([]);
  });
});
