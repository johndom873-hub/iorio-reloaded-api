import { describe, expect, it } from "vitest";
import { easternIsoDate } from "./easternIsoDate.js";

// Audit D (2026-10-07): daySignalsLiveness, daySignalsLoop and routes/signals switched from marketSessionStatus's easternDateIso
// (en-CA with explicit year/month/day) to easternIsoDate (en-CA defaults). Both must give the same Eastern date everywhere.
const previousEasternDateIso = (instant: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);

describe("easternIsoDate replaces easternDateIso — audit D", () => {
  it("gives the same YYYY-MM-DD around Eastern midnight, both DST switches and year end", () => {
    const instants = [
      "2026-10-07T03:59:59Z", "2026-10-07T04:00:00Z", // EDT midnight
      "2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", // spring forward
      "2026-11-01T05:59:00Z", "2026-11-01T06:00:00Z", // fall back
      "2026-12-31T04:59:59Z", "2027-01-01T04:59:59Z", "2027-01-01T05:00:00Z", // EST year end
    ];
    for (const iso of instants) {
      const instant = new Date(iso);
      expect(easternIsoDate(instant)).toBe(previousEasternDateIso(instant));
      expect(easternIsoDate(instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(easternIsoDate(new Date("2026-10-07T03:59:59Z"))).toBe("2026-10-06");
    expect(easternIsoDate(new Date("2027-01-01T04:59:59Z"))).toBe("2026-12-31");
  });
});
