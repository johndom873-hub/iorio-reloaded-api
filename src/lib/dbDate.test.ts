import { describe, expect, it } from "vitest";
import { isoDateFromDbDate } from "./dbDate.js";

describe("isoDateFromDbDate", () => {
  it("reads a local-midnight Date by its calendar parts, never via UTC", () => {
    expect(isoDateFromDbDate(new Date(2026, 8, 28, 0, 0, 0))).toBe("2026-09-28");
    expect(isoDateFromDbDate("2026-09-28")).toBe("2026-09-28");
    expect(isoDateFromDbDate("2026-09-28T00:00:00.000Z")).toBe("2026-09-28");
    expect(isoDateFromDbDate(null)).toBeNull();
  });
});
