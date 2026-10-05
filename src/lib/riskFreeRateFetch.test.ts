import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the one table this module touches: risk_free_rates.
let storedRow: { rate_percent: string; fetched_at: Date } | null = null;
const upserts: number[] = [];

vi.mock("../db/connection.js", () => ({
  db: () => ({
    where: () => ({ first: async () => storedRow }),
    insert: (row: { rate_percent: number }) => ({
      onConflict: () => ({
        merge: async () => {
          upserts.push(row.rate_percent);
          storedRow = { rate_percent: String(row.rate_percent), fetched_at: new Date() };
        },
      }),
    }),
  }),
}));
vi.mock("../config/env.js", () => ({ requireEnvironmentVariable: () => "test-key" }));

const { getRiskFreeRate, getRiskFreeRateForJob } = await import("./riskFreeRate.js");

const dayMs = 24 * 60 * 60_000;
const fredOk = (value: string) => new Response(JSON.stringify({ observations: [{ date: "2026-09-01", value }] }), { status: 200 });

beforeEach(() => {
  storedRow = null;
  upserts.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getRiskFreeRate on request paths", () => {
  it("serves a fresh stored rate without calling FRED", async () => {
    storedRow = { rate_percent: "3.72", fetched_at: new Date(Date.now() - 2 * dayMs) };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await getRiskFreeRate()).toBeCloseTo(0.0372);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers from a STALE stored rate at once, even when FRED hangs, and refreshes in the background", async () => {
    storedRow = { rate_percent: "3.72", fetched_at: new Date(Date.now() - 30 * dayMs) };
    let releaseFred: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => (releaseFred = resolve)));
    const answered = await Promise.race([getRiskFreeRate(), new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))]);
    expect(answered).toBeCloseTo(0.0372);
    releaseFred(fredOk("3.9"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upserts).toEqual([3.9]);
  });

  it("makes a single attempt with nothing stored, and does not hammer FRED again during the failure backoff", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    expect(await getRiskFreeRate()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getRiskFreeRate()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getRiskFreeRateForJob (the capture)", () => {
  it("retries and waits for the refresh, then stores the rate", async () => {
    // The backoff state from the previous test does not apply to a job that explicitly waits for a refresh.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(fredOk("3.72"));
    vi.useFakeTimers();
    const rate = getRiskFreeRateForJob();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await rate).toBeCloseTo(0.0372);
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(upserts).toEqual([3.72]);
  });

  it("with a STALE stored rate it still waits for the fresh one (a job stores the rate, it must not settle for the old one)", async () => {
    storedRow = { rate_percent: "3.50", fetched_at: new Date(Date.now() - 30 * dayMs) };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fredOk("3.72"));
    expect(await getRiskFreeRateForJob()).toBeCloseTo(0.0372);
    expect(upserts).toEqual([3.72]);
  });

  it("falls back to the stale stored rate when every attempt fails", async () => {
    storedRow = { rate_percent: "3.50", fetched_at: new Date(Date.now() - 30 * dayMs) };
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    vi.useFakeTimers();
    const rate = getRiskFreeRateForJob();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await rate).toBeCloseTo(0.035);
    vi.useRealTimers();
  });

  it("returns null only after all 3 attempts fail and nothing is stored", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    vi.useFakeTimers();
    const rate = getRiskFreeRateForJob();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await rate).toBeNull();
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
