import { describe, expect, it } from "vitest";
import { describeDaySignalsWatch, type DaySignalsWatchInput } from "./daySignalsWatchStatus.js";

// HOOD on 2026-10-06: ATM IV 62.7%, 10:00 spot $113.93, trigger 1.97% either way ($111.68 / $116.18).
const hood: DaySignalsWatchInput = { openDay: true, seedFinished: true, pooledExpiries: [], atmImpliedVolatility: 0.627, snapshotSpotPrice: 113.93, rerankState: null };

describe("describeDaySignalsWatch", () => {
  it("says the market is closed on a closed day and waits for the capture before the seed", () => {
    expect(describeDaySignalsWatch({ ...hood, openDay: false }).kind).toBe("market_closed");
    expect(describeDaySignalsWatch({ ...hood, seedFinished: false }).kind).toBe("waiting_for_capture");
  });

  it("reports no surface when today has no usable fit", () => {
    expect(describeDaySignalsWatch({ ...hood, atmImpliedVolatility: null }).kind).toBe("no_surface");
  });

  it("an unpooled ticker: not watched, with its trigger prices from the 10:00 spot and the hourly re-check after first sight", () => {
    const firstSeenAt = new Date("2026-10-06T14:07:16Z");
    const status = describeDaySignalsWatch({ ...hood, rerankState: { referenceSpotPrice: 113.93, reranks: 0, firstSeenAt, lastLookAt: null, lastLookKind: null } });
    expect(status).toEqual({ kind: "not_watched", pooledExpiries: [], lastLookAt: null, lastLookKind: null, nextTimedCheckAt: "2026-10-06T15:07:16.000Z", triggerLowPrice: 111.68, triggerHighPrice: 116.18 });
  });

  it("after a look, the triggers and the next re-check move to that look", () => {
    // WDC: re-checked at 14:22 ET on a move to $407.29 (ATM IV 67.4%, trigger 2.12%).
    const lastLookAt = new Date("2026-10-06T18:22:48Z");
    const status = describeDaySignalsWatch({ ...hood, atmImpliedVolatility: 0.674, snapshotSpotPrice: 416.13, rerankState: { referenceSpotPrice: 407.29, reranks: 1, firstSeenAt: new Date("2026-10-06T14:07:16Z"), lastLookAt, lastLookKind: "price" } });
    expect(status.kind).toBe("not_watched");
    expect(status.lastLookKind).toBe("price");
    expect(status.nextTimedCheckAt).toBe("2026-10-06T19:22:48.000Z");
    expect([status.triggerLowPrice, status.triggerHighPrice]).toEqual([398.64, 415.94]);
  });

  it("a pooled ticker is watched and lists its expiries, with no timed re-check", () => {
    const status = describeDaySignalsWatch({ ...hood, pooledExpiries: ["2026-10-09"] });
    expect(status.kind).toBe("watched");
    expect(status.pooledExpiries).toEqual(["2026-10-09"]);
    expect(status.nextTimedCheckAt).toBeNull();
  });
});
