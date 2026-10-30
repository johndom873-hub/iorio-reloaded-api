import { describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): the trigger's Eastern-date filter after the move to easternIsoDate; since 2026-10-30 it asks
// for the finished band cycles of today's Eastern trading date.

type CycleRow = { symbol: string; finishedAt: Date | string };
const harness = vi.hoisted(() => ({ rows: [] as CycleRow[], tables: [] as string[], tradingDates: [] as unknown[] }));

vi.mock("../db/connection.js", () => {
  const queryFor = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["join", "whereNull", "where"]) query[method] = () => query;
    query.whereRaw = (_sql: string, bindings: unknown[]) => {
      harness.tradingDates.push(bindings[0]);
      return query;
    };
    harness.tables.push(table);
    query.select = async () => harness.rows;
    return query;
  };
  return { db: Object.assign((table: string) => queryFor(table), { raw: () => "" }) };
});

const { findNewlyFinishedBandCycles, loadTodaysFinishedBandCycles } = await import("./bandQuoteWatermark.js");

describe("loadTodaysFinishedBandCycles (audit A)", () => {
  it("asks for today's Eastern trading date, across the UTC midnight", async () => {
    harness.tradingDates = [];
    await loadTodaysFinishedBandCycles(new Date("2026-10-07T03:59:00Z")); // 23:59 ET on 10-06
    await loadTodaysFinishedBandCycles(new Date("2026-10-07T04:01:00Z")); // 00:01 ET on 10-07
    expect(harness.tradingDates).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("follows EST in winter (UTC-5)", async () => {
    harness.tradingDates = [];
    await loadTodaysFinishedBandCycles(new Date("2026-12-07T04:30:00Z")); // 23:30 ET on 12-06
    await loadTodaysFinishedBandCycles(new Date("2026-12-07T05:30:00Z")); // 00:30 ET on 12-07
    expect(harness.tradingDates).toEqual(["2026-12-06", "2026-12-07"]);
  });

  it("reads the option quote band's finished cycles, one stamp per ticker", async () => {
    harness.tables = [];
    harness.rows = [{ symbol: "LADR", finishedAt: "2026-10-07T14:01:00Z" }];
    expect(findNewlyFinishedBandCycles(await loadTodaysFinishedBandCycles(new Date("2026-10-07T15:00:00Z")), new Map()).symbols).toEqual(["LADR"]);
    expect(harness.tables).toEqual(["option_quote_band_cycles as c"]);
  });
});
