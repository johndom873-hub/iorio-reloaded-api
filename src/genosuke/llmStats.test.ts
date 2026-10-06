import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitted = vi.hoisted(() => [] as string[]);
vi.mock("../lib/pulseEmitter.js", () => ({ emitPulse: (edgeId: string) => void emitted.push(edgeId) }));

describe("llmStats", () => {
  let llmStats: typeof import("./llmStats.js");

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    emitted.length = 0;
    vi.resetModules();
    llmStats = await import("./llmStats.js");
  });
  afterEach(() => vi.useRealTimers());

  it("reports zero calls and a null latency when nothing was recorded", () => {
    expect(llmStats.stats()).toEqual({ callsPerMinute: 0, avgLatencyMs: null });
  });

  it("pulses the genosuke-llm edge on every recorded call", () => {
    llmStats.record(100);
    llmStats.record(200);
    expect(emitted).toEqual(["genosuke-llm", "genosuke-llm"]);
  });

  it("averages latency (rounded) and spreads the calls over the 15-minute window", () => {
    llmStats.record(100);
    llmStats.record(200);
    llmStats.record(301);
    // 3 calls / 15 minutes = 0.2 per minute; mean latency 200.33 rounds to 200.
    expect(llmStats.stats()).toEqual({ callsPerMinute: 0.2, avgLatencyMs: 200 });
  });

  it("rounds calls per minute to one decimal place", () => {
    for (let call = 0; call < 10; call += 1) llmStats.record(50);
    // 10 / 15 = 0.666... -> 0.7
    expect(llmStats.stats().callsPerMinute).toBe(0.7);
  });

  it("keeps a call exactly 15 minutes old and drops one a millisecond older", () => {
    llmStats.record(100);
    vi.advanceTimersByTime(15 * 60_000);
    expect(llmStats.stats().avgLatencyMs).toBe(100);
    vi.advanceTimersByTime(1);
    expect(llmStats.stats()).toEqual({ callsPerMinute: 0, avgLatencyMs: null });
  });

  it("only averages calls still inside the window", () => {
    llmStats.record(1000);
    vi.advanceTimersByTime(16 * 60_000);
    llmStats.record(100);
    // One call left in a 15-minute window: 1 / 15 = 0.0666 -> 0.1.
    expect(llmStats.stats()).toEqual({ callsPerMinute: 0.1, avgLatencyMs: 100 });
  });
});
