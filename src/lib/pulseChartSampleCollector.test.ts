import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What each flush wrote and pruned, by table.
const writes: { table: string; rows: Record<string, unknown>[] }[] = [];
const prunes: string[] = [];

vi.mock("../db/connection.js", () => ({
  db: (table: string) => ({
    insert: (rows: Record<string, unknown>[]) => ({
      onConflict: () => ({
        merge: async () => {
          writes.push({ table, rows });
        },
      }),
    }),
    where: () => ({
      del: async () => {
        prunes.push(table);
      },
    }),
  }),
}));

const { flushPulseChartSamples, recordLegDeltaSample, recordUnrealizedPnlSample, sampleStaleAfterMs } = await import("./pulseChartSampleCollector.js");

const startMs = Date.UTC(2026, 10, 23, 15, 0, 0);
const minuteMs = 60_000;

function writtenIds(table: string): string[] {
  return writes.filter((write) => write.table === table).flatMap((write) => write.rows.map((row) => String(row.position_id ?? row.position_leg_id)));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startMs);
  writes.length = 0;
  prunes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pulseChartSampleCollector", () => {
  it("a value no stream refreshes is written for 5 minutes, then no more (a closed position, or Pulse closed)", async () => {
    recordUnrealizedPnlSample("closed-position", -4970.5568);
    recordLegDeltaSample("closed-leg", 0.313698);

    await flushPulseChartSamples(startMs + minuteMs);
    await flushPulseChartSamples(startMs + 4 * minuteMs);
    expect(writtenIds("pulse_unrealized_pnl_samples")).toEqual(["closed-position", "closed-position"]);
    expect(writtenIds("pulse_leg_delta_samples")).toEqual(["closed-leg", "closed-leg"]);

    writes.length = 0;
    await flushPulseChartSamples(startMs + sampleStaleAfterMs);
    await flushPulseChartSamples(startMs + 60 * minuteMs);
    expect(writes).toEqual([]);
    expect(sampleStaleAfterMs).toBe(5 * minuteMs);
  });

  it("a value the stream keeps refreshing, even less than once a minute, is written every minute", async () => {
    recordUnrealizedPnlSample("watched-position", 100);
    await flushPulseChartSamples(startMs + minuteMs);
    vi.setSystemTime(startMs + 3 * minuteMs);
    recordUnrealizedPnlSample("watched-position", 120);
    await flushPulseChartSamples(startMs + 6 * minuteMs);
    await flushPulseChartSamples(startMs + 7 * minuteMs);

    const values = writes.filter((write) => write.table === "pulse_unrealized_pnl_samples").map((write) => write.rows[0]!.unrealized_pnl);
    expect(values).toEqual([100, 120, 120]);
  });

  it("rows past the 8-hour window are pruned on every flush, also when nothing is fresh to write", async () => {
    // The earlier tests' values (the module keeps them) are all stale by then.
    await flushPulseChartSamples(startMs + 10 * minuteMs);
    expect(writes).toEqual([]);
    expect(prunes.sort()).toEqual(["pulse_leg_delta_samples", "pulse_unrealized_pnl_samples"]);
  });
});
