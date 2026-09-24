import { describe, expect, it } from "vitest";
import { clearsNotificationHysteresis, isGradeUpgrade } from "./daySignalsNotifications.js";

describe("isGradeUpgrade", () => {
  it("counts only a strictly higher grade against a previously recorded one, and never a baseline (null)", () => {
    expect(isGradeUpgrade(null, "strong")).toBe(false);
    expect(isGradeUpgrade("weak", "good")).toBe(true);
    expect(isGradeUpgrade("good", "good")).toBe(false);
    expect(isGradeUpgrade("good", "weak")).toBe(false);
  });
});

describe("clearsNotificationHysteresis", () => {
  it("never clears into avoid", () => {
    expect(clearsNotificationHysteresis("avoid", 0)).toBe(false);
    expect(clearsNotificationHysteresis("avoid", -0.5)).toBe(false);
  });

  it("requires a margin above each grade's own cut point (2vp, approved 2026-09-24)", () => {
    // weak: cut point 0vp, so >= 2vp required.
    expect(clearsNotificationHysteresis("weak", 0.015)).toBe(false);
    expect(clearsNotificationHysteresis("weak", 0.02)).toBe(true);
    // good: cut point 5vp, so >= 7vp required -- this is the HOOD $116 put case from staging
    // (2026-09-24), which oscillated 5.0-7.5vp and re-notified 8 times in 11 minutes.
    expect(clearsNotificationHysteresis("good", 0.05)).toBe(false);
    expect(clearsNotificationHysteresis("good", 0.06)).toBe(false);
    expect(clearsNotificationHysteresis("good", 0.07)).toBe(true);
    expect(clearsNotificationHysteresis("good", 0.075)).toBe(true);
    // strong: cut point 10vp, so >= 12vp required.
    expect(clearsNotificationHysteresis("strong", 0.10)).toBe(false);
    expect(clearsNotificationHysteresis("strong", 0.11)).toBe(false);
    expect(clearsNotificationHysteresis("strong", 0.12)).toBe(true);
  });
});
