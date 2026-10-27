import { describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): loadTodaysBandQuoteStamps' Eastern-date filter after the move to easternIsoDate.

type StampRow = { symbol: string; expiry: string; strike: string; right: string; quotedAt: Date | string };
const harness = vi.hoisted(() => ({ rows: [] as StampRow[], tables: [] as string[] }));

vi.mock("../db/connection.js", () => {
  const queryFor = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["join", "whereNull", "where"]) query[method] = () => query;
    harness.tables.push(table);
    query.select = async () => harness.rows;
    return query;
  };
  return { db: Object.assign((table: string) => queryFor(table), { raw: () => "" }) };
});

const { findNewlyQuotedContracts, loadTodaysBandQuoteStamps, rememberAnalysed } = await import("./bandQuoteWatermark.js");

describe("loadTodaysBandQuoteStamps (audit A)", () => {
  it("keeps only quotes stamped on today's Eastern date, across the UTC midnight", async () => {
    harness.rows = [
      { symbol: "AAA", expiry: "2026-10-16", strike: "30.0", right: "C", quotedAt: "2026-10-07T03:59:00Z" }, // 23:59 ET on 10-06
      { symbol: "AAA", expiry: "2026-10-16", strike: "31.0", right: "C", quotedAt: "2026-10-07T04:01:00Z" }, // 00:01 ET on 10-07
      { symbol: "BBB", expiry: "2026-10-16", strike: "12.5", right: "P", quotedAt: new Date("2026-10-08T03:30:00Z") }, // 23:30 ET on 10-07
    ];
    const stamps = await loadTodaysBandQuoteStamps(new Date("2026-10-07T14:00:00Z"));
    expect(stamps.map((stamp) => `${stamp.symbol}:${stamp.strike}`)).toEqual(["AAA:31", "BBB:12.5"]);
  });

  it("follows EST in winter (UTC-5)", async () => {
    harness.rows = [
      { symbol: "AAA", expiry: "2026-12-18", strike: "30", right: "C", quotedAt: "2026-12-07T04:30:00Z" }, // 23:30 ET on 12-06
      { symbol: "AAA", expiry: "2026-12-18", strike: "31", right: "C", quotedAt: "2026-12-07T05:30:00Z" }, // 00:30 ET on 12-07
    ];
    const stamps = await loadTodaysBandQuoteStamps(new Date("2026-12-07T15:00:00Z"));
    expect(stamps.map((stamp) => stamp.strike)).toEqual([31]);
  });

  it("reads only the CC + Put Ladder's band quotes", async () => {
    harness.tables = [];
    harness.rows = [{ symbol: "LADR", expiry: "2026-11-20", strike: "45", right: "P", quotedAt: "2026-10-07T14:01:00Z" }];
    expect(findNewlyQuotedContracts(await loadTodaysBandQuoteStamps(new Date("2026-10-07T15:00:00Z")), new Map()).symbols).toEqual(["LADR"]);
    expect(harness.tables).toEqual(["ladder_band_quotes as q"]);
  });

  it("a strike stored as '30.0' and one as '30' are the same contract key once loaded", async () => {
    harness.rows = [{ symbol: "AAA", expiry: "2026-10-16", strike: "30.0", right: "C", quotedAt: "2026-10-07T14:00:00Z" }];
    const memory = new Map<string, number>();
    rememberAnalysed(await loadTodaysBandQuoteStamps(new Date("2026-10-07T15:00:00Z")), memory);
    harness.rows = [{ symbol: "AAA", expiry: "2026-10-16", strike: "30", right: "C", quotedAt: "2026-10-07T14:00:00Z" }];
    expect(findNewlyQuotedContracts(await loadTodaysBandQuoteStamps(new Date("2026-10-07T15:00:00Z")), memory).contractCount).toBe(0);
  });
});
