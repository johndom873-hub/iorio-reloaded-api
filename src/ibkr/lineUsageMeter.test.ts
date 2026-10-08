import { describe, expect, it } from "vitest";
import { createLineUsageMeter, describeLineUsage } from "./lineUsageMeter.js";

function clock() {
  let nowMs = 0;
  return { now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
}

describe("createLineUsageMeter", () => {
  it("integrates subscribed and answered lines over time and counts one message per subscribe and per release", () => {
    const time = clock();
    const meter = createLineUsageMeter(time.now);
    meter.subscribed(1);
    meter.subscribed(2);
    time.advance(1_000);
    meter.answered(1);
    meter.answered(1); // a second tick is not a second first reply
    time.advance(1_000);
    meter.released(1);
    time.advance(2_000);
    meter.released(2); // never answered
    expect(meter.drain()).toEqual({
      periodMs: 4_000,
      averageSubscribed: (2 * 2_000 + 1 * 2_000) / 4_000,
      averageAnswered: 1_000 / 4_000,
      messagesPerSecond: 1,
      released: 2,
      releasedUnanswered: 1,
      firstReplyMsP50: 1_000,
      firstReplyMsP90: 1_000,
      holdMsP50: 2_000,
      holdMsP90: 4_000,
    });
  });

  it("attributes line time to the period it falls in, not to the period the line is released in", () => {
    const time = clock();
    const meter = createLineUsageMeter(time.now);
    meter.subscribed(1);
    time.advance(10_000);
    expect(meter.drain()).toMatchObject({ periodMs: 10_000, averageSubscribed: 1, released: 0 });
    time.advance(5_000);
    meter.released(1);
    time.advance(5_000);
    expect(meter.drain()).toMatchObject({ periodMs: 10_000, averageSubscribed: 0.5, released: 1, holdMsP50: 15_000 });
    expect(meter.wholeRun()).toMatchObject({ periodMs: 20_000, averageSubscribed: 0.75, messagesPerSecond: 0.1 });
  });

  it("ignores ticks and releases for requests it was never told about", () => {
    const meter = createLineUsageMeter(clock().now);
    meter.answered(9);
    meter.released(9);
    expect(meter.wholeRun()).toMatchObject({ released: 0, averageAnswered: 0 });
  });
});

describe("describeLineUsage", () => {
  it("formats one fragment", () => {
    expect(
      describeLineUsage({ periodMs: 10_000, averageSubscribed: 49.64, averageAnswered: 21, messagesPerSecond: 19.8, released: 98, releasedUnanswered: 0, firstReplyMsP50: 2_900, firstReplyMsP90: 3_400, holdMsP50: 4_900, holdMsP90: 8_000 }),
    ).toBe("subscribed avg 49.6, answered avg 21.0, 19.8 msg/s, first reply p50 2.9s p90 3.4s (0 never answered of 98)");
  });
});
