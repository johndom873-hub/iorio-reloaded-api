import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTreasuryBillRates, parseFredObservations, TreasuryBillRates, treasuryBillCacheCovers, treasuryBillCachePath, type TreasuryBillCache } from "./treasuryBillRates.js";

const directory = mkdtempSync(path.join(tmpdir(), "backtest-dtb3-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("TreasuryBillRates", () => {
  const rates = new TreasuryBillRates(parseFredObservations([{ date: "2026-03-03", value: "4.10" }, { date: "2026-03-02", value: "4.00" }, { date: "2026-03-04", value: "." }, { date: "2026-03-05", value: "4.20" }]));

  it("returns the latest observation on or before a date, skipping FRED's '.' gaps", () => {
    expect(rates.ratePercentOnOrBefore("2026-03-01")).toBeNull();
    expect(rates.ratePercentOnOrBefore("2026-03-02")).toBe(4);
    expect(rates.ratePercentOnOrBefore("2026-03-04")).toBe(4.1);
    expect(rates.ratePercentOnOrBefore("2026-03-09")).toBe(4.2);
  });
});

describe("treasuryBillCacheCovers", () => {
  const cache = (lastDate: string, fetchedAtIso: string): TreasuryBillCache => ({ seriesId: "DTB3", fetchedAtIso, observations: [{ dateIso: "2010-01-04", ratePercent: 0.1 }, { dateIso: lastDate, ratePercent: 4 }] });

  it("covers a session ending within five days of the last observation (weekends, FRED's one-day lag)", () => {
    expect(treasuryBillCacheCovers(cache("2026-10-08", "2026-10-09T00:00:00Z"), "2016-01-04", "2026-10-09")).toBe(true);
  });

  it("is stale for a later session, unless it was fetched well after that session's end", () => {
    expect(treasuryBillCacheCovers(cache("2026-06-30", "2026-07-01T00:00:00Z"), "2016-01-04", "2026-10-09")).toBe(false);
    expect(treasuryBillCacheCovers(cache("2026-06-30", "2026-10-20T00:00:00Z"), "2016-01-04", "2026-10-09")).toBe(true);
  });

  it("is stale for a session starting before the series", () => {
    expect(treasuryBillCacheCovers(cache("2026-10-08", "2026-10-09T00:00:00Z"), "2009-06-01", "2026-10-09")).toBe(false);
  });
});

describe("loadTreasuryBillRates", () => {
  it("fetches once when there is no cache, then serves the cache", async () => {
    let fetches = 0;
    const fetchSeries = async () => {
      fetches += 1;
      return [{ dateIso: "2010-01-04", ratePercent: 0.1 }, { dateIso: "2026-10-08", ratePercent: 4.05 }];
    };
    const first = await loadTreasuryBillRates(directory, "2016-01-04", "2026-10-09", fetchSeries, new Date("2026-10-12T00:00:00Z"));
    const second = await loadTreasuryBillRates(directory, "2016-01-04", "2026-10-09", fetchSeries, new Date("2026-10-12T00:00:00Z"));
    expect(fetches).toBe(1);
    expect(first.ratePercentOnOrBefore("2026-10-09")).toBe(4.05);
    expect(second.ratePercentOnOrBefore("2016-01-04")).toBe(0.1);
    expect(JSON.parse(readFileSync(treasuryBillCachePath(directory), "utf8")).seriesId).toBe("DTB3");
  });
});
