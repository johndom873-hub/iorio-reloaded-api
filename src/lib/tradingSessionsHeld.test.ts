import { describe, expect, it } from "vitest";
import { easternInstant } from "./easternIsoDate.js";
import { saleSessionAt, sessionsHeldAmong } from "./tradingSessionsHeld.js";

// November 2026: Thanksgiving Thursday the 26th closed, Friday the 27th a 13:00 half day.
const novemberSessions = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01"];

describe("sessions held", () => {
  it("counts the sale's session and the expiry's, every session between, and no weekend or holiday", () => {
    // Friday 0DTE 1, Thursday for Friday 2, Monday for Friday 5; Thanksgiving week's Monday for Friday 4.
    const october = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"];
    expect(sessionsHeldAmong(october, "2026-10-30", "2026-10-30")).toBe(1);
    expect(sessionsHeldAmong(october, "2026-10-29", "2026-10-30")).toBe(2);
    expect(sessionsHeldAmong(october, "2026-10-26", "2026-10-30")).toBe(5);
    expect(sessionsHeldAmong(novemberSessions, "2026-11-23", "2026-11-27")).toBe(4);
    // Friday for Monday: the weekend counts for nothing.
    expect(sessionsHeldAmong(october, "2026-10-30", "2026-11-02")).toBe(2);
    // Never below one.
    expect(sessionsHeldAmong(october, "2026-10-30", "2026-10-29")).toBe(1);
  });

  it("sells in today's session until its close, else in the next one, a half day's close included", () => {
    const sessions = novemberSessions.slice(3).map((dateIso) => ({ dateIso, closeMinutesEt: dateIso === "2026-11-27" ? 13 * 60 : 16 * 60 }));
    // Friday the 27th: before 13:00 today, after it Monday the 30th; on Thanksgiving itself, Friday.
    expect(saleSessionAt(easternInstant("2026-11-27", 9, 0), sessions)).toBe("2026-11-27");
    expect(saleSessionAt(easternInstant("2026-11-27", 12, 59), sessions)).toBe("2026-11-27");
    expect(saleSessionAt(easternInstant("2026-11-27", 13, 0), sessions)).toBe("2026-11-30");
    expect(saleSessionAt(easternInstant("2026-11-26", 10, 0), sessions)).toBe("2026-11-27");
  });
});
