import { describe, expect, it } from "vitest";
import { easternInstant } from "./easternIsoDate.js";
import { tradingSessionsFromCalendarRows } from "./marketSessionStatus.js";
import { earlyCloseSessionWeight, remainingSessionVariance, remainingSessionVarianceCurveMeasured2020To2026, sessionVarianceWeight, varianceSessionsToExpiry } from "./varianceClock.js";

const at = (dateIso: string, hour: number, minute: number) => easternInstant(dateIso, hour, minute).getTime();
const weekdays = (fromIso: string, toIso: string, rows: { dateIso: string; isOpen: boolean; closeTime: string | null }[] = []) => tradingSessionsFromCalendarRows(fromIso, toIso, rows);

describe("remainingSessionVariance (P1, approved 2026-10-10)", () => {
  it("reads the measured curve and interpolates between its points", () => {
    expect(remainingSessionVariance(10 * 60)).toBeCloseTo(0.309, 12);
    expect(remainingSessionVariance(13 * 60)).toBeCloseTo(0.113, 12);
    expect(remainingSessionVariance(15 * 60)).toBeCloseTo(0.061, 12);
    expect(remainingSessionVariance(10 * 60 + 30)).toBeCloseTo((0.309 + 0.193) / 2, 12);
  });
  it("is the whole session before the open and nothing after the close", () => {
    expect(remainingSessionVariance(8 * 60)).toBe(1);
    expect(remainingSessionVariance(16 * 60)).toBe(0);
    expect(remainingSessionVariance(17 * 60)).toBe(0);
  });
  it("compresses and scales the curve on a half day", () => {
    expect(remainingSessionVariance(8 * 60, 13 * 60)).toBeCloseTo(earlyCloseSessionWeight, 12);
    expect(remainingSessionVariance(13 * 60, 13 * 60)).toBe(0);
    // 09:30 on a half day: half of the regular open-to-close share
    expect(remainingSessionVariance(9 * 60 + 30, 13 * 60)).toBeCloseTo(0.496 * 0.551, 12);
  });
  it("weighs a whole half day at about 0.70", () => {
    expect(earlyCloseSessionWeight).toBeCloseTo(0.412 + 0.496 * 0.588, 12);
    expect(sessionVarianceWeight({ dateIso: "2026-11-27", closeMinutesEt: 780 })).toBeCloseTo(0.7036, 3);
    expect(sessionVarianceWeight({ dateIso: "2026-11-30", closeMinutesEt: 960 })).toBe(1);
  });
});

describe("varianceSessionsToExpiry", () => {
  const sessions = weekdays("2026-10-05", "2026-10-30");
  it("Thu 10:00 → Fri expiry: the rest of Thursday plus Friday", () => {
    expect(varianceSessionsToExpiry(at("2026-10-08", 10, 0), "2026-10-09", sessions)).toBeCloseTo(1.309, 12);
  });
  it("Fri 10:00 → Mon expiry: the rest of Friday plus Monday; the weekend adds no session", () => {
    expect(varianceSessionsToExpiry(at("2026-10-09", 10, 0), "2026-10-12", sessions)).toBeCloseTo(1.309, 12);
  });
  it("counts the expiry day's whole session and stops after its close", () => {
    expect(varianceSessionsToExpiry(at("2026-10-09", 8, 0), "2026-10-09", sessions)).toBe(1);
    expect(varianceSessionsToExpiry(at("2026-10-09", 16, 0), "2026-10-09", sessions)).toBe(0);
  });
  it("from a weekend counts only the sessions ahead", () => {
    expect(varianceSessionsToExpiry(at("2026-10-10", 12, 0), "2026-10-16", sessions)).toBe(5);
  });
  it("skips holidays and weighs half days from the calendar", () => {
    const thanksgiving = weekdays("2026-11-23", "2026-11-30", [{ dateIso: "2026-11-26", isOpen: false, closeTime: null }]);
    // Tue 10:00 → Mon 30 Nov: rest of Tue + Wed + (Thu holiday) + Fri half day + Mon
    expect(varianceSessionsToExpiry(at("2026-11-24", 10, 0), "2026-11-30", thanksgiving)).toBeCloseTo(0.309 + 1 + earlyCloseSessionWeight + 1, 12);
  });
  it("uses the stored close time over the early-close list", () => {
    const sessionsWithStoredClose = weekdays("2026-12-21", "2026-12-24", [{ dateIso: "2026-12-24", isOpen: true, closeTime: "13:00:00" }]);
    expect(sessionsWithStoredClose.find((session) => session.dateIso === "2026-12-24")!.closeMinutesEt).toBe(780);
  });
});

describe("the 2020–2026 rest-of-day curve (a backtest session's choice, Edge Margin audit 2026-10-22)", () => {
  const sessions = weekdays("2026-10-05", "2026-10-30");
  it("reads its own points and leaves live's curve the default", () => {
    expect(remainingSessionVariance(10 * 60, 16 * 60, remainingSessionVarianceCurveMeasured2020To2026)).toBeCloseTo(0.438, 12);
    expect(remainingSessionVariance(12 * 60 + 15, 16 * 60, remainingSessionVarianceCurveMeasured2020To2026)).toBeCloseTo((0.232 + 0.203) / 2, 12);
    expect(remainingSessionVariance(10 * 60)).toBeCloseTo(0.309, 12);
  });
  it("Thu 10:00 → Fri expiry is 1.438 sessions on it, 1.309 on live's", () => {
    expect(varianceSessionsToExpiry(at("2026-10-08", 10, 0), "2026-10-09", sessions, remainingSessionVarianceCurveMeasured2020To2026)).toBeCloseTo(1.438, 12);
    expect(varianceSessionsToExpiry(at("2026-10-08", 10, 0), "2026-10-09", sessions)).toBeCloseTo(1.309, 12);
  });
});
