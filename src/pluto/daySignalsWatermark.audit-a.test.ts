import { describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): loadTodaysDaySignalQuoteStamps' Eastern-date filter after the move to easternIsoDate.

const harness = vi.hoisted(() => ({ rows: [] as { symbol: string; expiry: string; strike: string; right: string; quotedAt: Date | string }[] }));

vi.mock("../db/connection.js", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["join", "whereNull", "where"]) query[method] = () => query;
  query.select = async () => harness.rows;
  return { db: Object.assign(() => query, { raw: () => "" }) };
});

const { findNewlyQuotedContracts, loadTodaysDaySignalQuoteStamps, rememberAnalysed } = await import("./daySignalsWatermark.js");

describe("loadTodaysDaySignalQuoteStamps (audit A)", () => {
  it("keeps only quotes stamped on today's Eastern date, across the UTC midnight", async () => {
    harness.rows = [
      { symbol: "AAA", expiry: "2026-10-16", strike: "30.0", right: "C", quotedAt: "2026-10-07T03:59:00Z" }, // 23:59 ET on 10-06
      { symbol: "AAA", expiry: "2026-10-16", strike: "31.0", right: "C", quotedAt: "2026-10-07T04:01:00Z" }, // 00:01 ET on 10-07
      { symbol: "BBB", expiry: "2026-10-16", strike: "12.5", right: "P", quotedAt: new Date("2026-10-08T03:30:00Z") }, // 23:30 ET on 10-07
    ];
    const stamps = await loadTodaysDaySignalQuoteStamps(new Date("2026-10-07T14:00:00Z"));
    expect(stamps.map((stamp) => `${stamp.symbol}:${stamp.strike}`)).toEqual(["AAA:31", "BBB:12.5"]);
  });

  it("follows EST in winter (UTC-5)", async () => {
    harness.rows = [
      { symbol: "AAA", expiry: "2026-12-18", strike: "30", right: "C", quotedAt: "2026-12-07T04:30:00Z" }, // 23:30 ET on 12-06
      { symbol: "AAA", expiry: "2026-12-18", strike: "31", right: "C", quotedAt: "2026-12-07T05:30:00Z" }, // 00:30 ET on 12-07
    ];
    const stamps = await loadTodaysDaySignalQuoteStamps(new Date("2026-12-07T15:00:00Z"));
    expect(stamps.map((stamp) => stamp.strike)).toEqual([31]);
  });

  it("a strike stored as '30.0' and one as '30' are the same contract key once loaded", async () => {
    harness.rows = [{ symbol: "AAA", expiry: "2026-10-16", strike: "30.0", right: "C", quotedAt: "2026-10-07T14:00:00Z" }];
    const memory = new Map<string, number>();
    rememberAnalysed(await loadTodaysDaySignalQuoteStamps(new Date("2026-10-07T15:00:00Z")), memory);
    harness.rows = [{ symbol: "AAA", expiry: "2026-10-16", strike: "30", right: "C", quotedAt: "2026-10-07T14:00:00Z" }];
    expect(findNewlyQuotedContracts(await loadTodaysDaySignalQuoteStamps(new Date("2026-10-07T15:00:00Z")), memory).contractCount).toBe(0);
  });
});
