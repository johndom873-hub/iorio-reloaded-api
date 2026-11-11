import { describe, expect, it } from "vitest";
import { buildCycleScoreboard } from "./cycleScoreboard.js";
import type { SymbolCycles } from "./cycleQueries.js";
import type { Cycle } from "./cycles.js";

const now = new Date("2026-11-11T15:00:00Z");
// NVDA is Pluto's from 9 Nov 12:00 UTC on; AMD was Pluto's on 5 Nov only.
const periods = [
  { tickerId: "nvda", startedAt: new Date("2026-11-09T12:00:00Z"), endedAt: null },
  { tickerId: "amd", startedAt: new Date("2026-11-05T12:00:00Z"), endedAt: new Date("2026-11-06T00:00:00Z") },
];

/** A cycle whose CC bucket made `cc` on `capital` and whose Hedge bucket made `hedge`. */
function cycle(endAt: string | null, cc: number, hedge = 0, dataFlags: string[] = []): Cycle {
  const bucket = (total: number, capital = 0) => ({ premium: total, stock: 0, total, capital });
  return {
    startAt: new Date("2026-10-01T14:00:00Z"),
    endAt: endAt === null ? null : new Date(endAt),
    status: endAt === null ? "open" : "closed",
    buckets: { csp: bucket(0), unstructured: bucket(0), cc: bucket(cc, 10_000), hedge: bucket(hedge), leaps: bucket(0) },
    total: cc + hedge,
    dataFlags,
  } as unknown as Cycle;
}

const symbolCycles: SymbolCycles[] = [
  // Closed before Pluto took NVDA (Manual's), then open now with a hedge (Pluto's, its hedge Manual's).
  { symbol: "NVDA", tickerId: "nvda", cycles: [cycle("2026-11-02T20:00:00Z", 100), cycle(null, 50, -20)] },
  // Closed inside AMD's Pluto day (Pluto's), and one closed after it with an untrusted ledger (Manual's, left out).
  { symbol: "AMD", tickerId: "amd", cycles: [cycle("2026-11-05T18:00:00Z", 30), cycle("2026-11-07T18:00:00Z", 999, 0, ["missing fills"])] },
];

describe("buildCycleScoreboard", () => {
  it("All books counts every trusted cycle and lists the untrusted one", () => {
    const board = buildCycleScoreboard(symbolCycles, null, periods, now);
    expect(board.total).toBe(160);
    expect(board.buckets.cc.total).toBe(180);
    expect(board.buckets.hedge.total).toBe(-20);
    expect(board.cyclesIncluded).toBe(3);
    expect(board.cyclesExcluded).toEqual([{ symbol: "AMD", reason: "missing fills" }]);
  });

  it("each cycle counts in its ticker's book at its end (an open one, now); its hedge always in Manual's", () => {
    const pluto = buildCycleScoreboard(symbolCycles, "pluto", periods, now);
    expect(pluto.buckets.cc.total).toBe(80);
    expect(pluto.buckets.cc.returnOnCapital).toBeCloseTo(80 / 20_000);
    expect(pluto.buckets.hedge.total).toBe(0);
    expect(pluto.cyclesIncluded).toBe(2);
    expect(pluto.cyclesExcluded).toEqual([]);

    const manual = buildCycleScoreboard(symbolCycles, "manual", periods, now);
    expect(manual.buckets.cc.total).toBe(100);
    expect(manual.buckets.hedge.total).toBe(-20);
    expect(manual.total).toBe(80);
    expect(manual.cyclesIncluded).toBe(1);
    expect(manual.cyclesExcluded).toEqual([{ symbol: "AMD", reason: "missing fills" }]);

    // The two books add up to All books.
    expect(pluto.total + manual.total).toBe(buildCycleScoreboard(symbolCycles, null, periods, now).total);
  });
});
