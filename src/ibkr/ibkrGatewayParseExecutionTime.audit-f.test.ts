import { describe, expect, it } from "vitest";
import { parseIbkrExecutionTime } from "./ibkrGatewayParseExecutionTime.js";

// Audit F (2026-10-07): the per-call Intl.DateTimeFormat became one cached formatter per zone. The result must be exactly
// the removed implementation's for every zone, and alternating zones must never read another zone's formatter.

function removedParseIbkrExecutionTime(raw: string | undefined): Date | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const naiveUtcGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const partsInZone = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(naiveUtcGuess));
  const part = (type: string) => Number(partsInZone.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return new Date(naiveUtcGuess + (naiveUtcGuess - asIfUtc));
}

const zones = ["US/Eastern", "America/New_York", "Asia/Singapore", "Europe/London", "UTC", "US/Central"];
// Ordinary days and the safe hours of the DST Sundays: the removed single correction was an hour off a few hours after
// each switch (03:00 on 03-08 among them), which the DST test below covers instead.
const wallTimes = ["20260105 09:30:00", "20260306 15:59:59", "20260308 01:59:59", "20260308 08:00:00", "20260309 09:30:00", "20261030 16:00:00", "20261101 00:30:00", "20261101 01:30:00", "20261102 09:30:00", "20261007 23:59:59", "20261008 00:00:00"];

describe("parseIbkrExecutionTime with cached per-zone formatters", () => {
  it("equals the removed per-call implementation for every zone and wall time, zones interleaved", () => {
    for (let round = 0; round < 3; round++) {
      for (const wall of wallTimes) {
        for (const zone of round === 1 ? [...zones].reverse() : zones) {
          const raw = `${wall} ${zone}`;
          expect(parseIbkrExecutionTime(raw)?.toISOString()).toBe(removedParseIbkrExecutionTime(raw)?.toISOString());
        }
      }
    }
  });

  it("parses ordinary US session times in both EST and EDT", () => {
    expect(parseIbkrExecutionTime("20260105 09:30:00 US/Eastern")?.toISOString()).toBe("2026-01-05T14:30:00.000Z");
    expect(parseIbkrExecutionTime("20260824 09:44:07 US/Eastern")?.toISOString()).toBe("2026-08-24T13:44:07.000Z");
    expect(parseIbkrExecutionTime("20261102 15:59:59 US/Eastern")?.toISOString()).toBe("2026-11-02T20:59:59.000Z");
  });

  it("throws for an unknown zone every time (nothing is cached for it) and keeps working for valid zones afterwards", () => {
    expect(() => removedParseIbkrExecutionTime("20260105 09:30:00 Not/AZone")).toThrow(RangeError);
    expect(() => parseIbkrExecutionTime("20260105 09:30:00 Not/AZone")).toThrow(RangeError);
    expect(() => parseIbkrExecutionTime("20260105 09:30:00 Not/AZone")).toThrow(RangeError);
    expect(parseIbkrExecutionTime("20260105 09:30:00 US/Eastern")?.toISOString()).toBe("2026-01-05T14:30:00.000Z");
  });

  it("is right on both DST-change Sundays, either side of the switch", () => {
    // Spring forward 2026-03-08: 01:30 EST, then 03:30 and 05:30 EDT.
    expect(parseIbkrExecutionTime("20260308 01:30:00 US/Eastern")?.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(parseIbkrExecutionTime("20260308 03:30:00 US/Eastern")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(parseIbkrExecutionTime("20260308 05:30:00 US/Eastern")?.toISOString()).toBe("2026-03-08T09:30:00.000Z");
    // Fall back 2026-11-01: 00:30 EDT, then 02:30 and 05:00 EST.
    expect(parseIbkrExecutionTime("20261101 00:30:00 US/Eastern")?.toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(parseIbkrExecutionTime("20261101 02:30:00 US/Eastern")?.toISOString()).toBe("2026-11-01T07:30:00.000Z");
    expect(parseIbkrExecutionTime("20261101 05:00:00 US/Eastern")?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("returns null for the shapes it does not parse", () => {
    expect(parseIbkrExecutionTime(undefined)).toBeNull();
    expect(parseIbkrExecutionTime("")).toBeNull();
    expect(parseIbkrExecutionTime("2026-01-05T09:30:00Z")).toBeNull();
  });
});

describe("parseIbkrExecutionTime — IBKR's UTC form (2026-10-08)", () => {
  it("reads YYYYMMDD-HH:mm:ss as UTC", () => {
    expect(parseIbkrExecutionTime("20261007-14:14:54")?.toISOString()).toBe("2026-10-07T14:14:54.000Z");
    expect(parseIbkrExecutionTime("20260308-06:30:00")?.toISOString()).toBe("2026-03-08T06:30:00.000Z");
  });
  it("still refuses anything else", () => {
    expect(parseIbkrExecutionTime("20261007-14:14")).toBeNull();
    expect(parseIbkrExecutionTime("2026-10-07 14:14:54")).toBeNull();
  });
});
