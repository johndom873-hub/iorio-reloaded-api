import { describe, expect, it } from "vitest";
import { eventFactorOf } from "./portfolioProjectionInputs.js";

const samplesOf = (eventRatios: number[], otherRatios: number[]) => [...eventRatios.map((atMoneyRatio) => ({ atMoneyRatio, onEvent: true })), ...otherRatios.map((atMoneyRatio) => ({ atMoneyRatio, onEvent: false }))];

describe("an event factor", () => {
  it("is the median at-the-money IV ratio on event days ÷ the median on others", () => {
    // Event days 1.10–1.30 (median 1.20), other days 0.95–1.05 (median 1.00): 1.20.
    const events = Array.from({ length: 11 }, (_, at) => 1.1 + at * 0.02);
    const others = Array.from({ length: 51 }, (_, at) => 0.95 + at * 0.002);
    expect(eventFactorOf(samplesOf(events, others))).toBeCloseTo(1.2, 12);
  });

  it("is 1 with under 10 event days or 50 other days", () => {
    expect(eventFactorOf(samplesOf(Array(9).fill(1.3), Array(60).fill(1)))).toBe(1);
    expect(eventFactorOf(samplesOf(Array(12).fill(1.3), Array(49).fill(1)))).toBe(1);
  });

  it("is clamped to 0.8–1.5", () => {
    expect(eventFactorOf(samplesOf(Array(10).fill(2), Array(50).fill(1)))).toBe(1.5);
    expect(eventFactorOf(samplesOf(Array(10).fill(0.5), Array(50).fill(1)))).toBe(0.8);
  });
});
