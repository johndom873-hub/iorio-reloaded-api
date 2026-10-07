import { describe, expect, it } from "vitest";
import { easternInstant } from "./easternIsoDate.js";
import { expirySpansEarnings, expirySpansMacroEvent } from "./volatilityEdge.js";

// Audit E (2026-10-07): the earnings exclusion window and the macro flag's 16:00 ET expiry-close rule at their edges.

describe("expirySpansEarnings edges", () => {
  it("counts a report on today's date when the expiry is today (0 DTE, after-close report)", () => {
    expect(expirySpansEarnings("2026-10-07", "2026-10-07", ["2026-10-07"])).toBe(true);
  });

  it("does not count yesterday's report, and counts one on the expiry day itself", () => {
    expect(expirySpansEarnings("2026-10-07", "2026-10-16", ["2026-10-06"])).toBe(false);
    expect(expirySpansEarnings("2026-10-07", "2026-10-16", ["2026-10-16"])).toBe(true);
    expect(expirySpansEarnings("2026-10-07", "2026-10-16", ["2026-10-17"])).toBe(false);
  });

  it("an expiry already past today spans nothing, even with today's date in the list", () => {
    expect(expirySpansEarnings("2026-10-07", "2026-10-06", ["2026-10-07"])).toBe(false);
  });

  it("compares across a year end as text", () => {
    expect(expirySpansEarnings("2026-12-30", "2027-01-15", ["2027-01-05"])).toBe(true);
  });
});

describe("expirySpansMacroEvent edges", () => {
  const event = (iso: string) => ({ eventAtMs: Date.parse(iso) });

  it("an event exactly at the scoring moment is no longer ahead", () => {
    const at = Date.parse("2026-10-28T18:00:00Z"); // Fed 14:00 EDT
    expect(expirySpansMacroEvent(at, "2026-11-20", [event("2026-10-28T18:00:00Z")])).toBe(false);
    expect(expirySpansMacroEvent(at - 1, "2026-11-20", [event("2026-10-28T18:00:00Z")])).toBe(true);
  });

  it("16:00 EDT on an expiry in daylight time is 20:00Z (exclusive)", () => {
    const scoredAt = Date.parse("2026-10-01T14:30:00Z");
    expect(expirySpansMacroEvent(scoredAt, "2026-10-16", [event("2026-10-16T19:59:59Z")])).toBe(true);
    expect(expirySpansMacroEvent(scoredAt, "2026-10-16", [event("2026-10-16T20:00:00Z")])).toBe(false);
  });

  it("uses the expiry date's own offset across the November DST change (scored in EDT, expiry in EST)", () => {
    const scoredAtEdt = Date.parse("2026-10-30T14:30:00Z");
    // 2026-11-06 is EST: the close is 21:00Z, so 20:30Z (15:30 EST) is still before it.
    expect(expirySpansMacroEvent(scoredAtEdt, "2026-11-06", [event("2026-11-06T20:30:00Z")])).toBe(true);
    expect(expirySpansMacroEvent(scoredAtEdt, "2026-11-06", [event("2026-11-06T21:00:00Z")])).toBe(false);
  });

  it("uses the expiry date's own offset across the March DST change (scored in EST, expiry in EDT)", () => {
    const scoredAtEst = Date.parse("2027-03-01T15:00:00Z");
    // 2027-03-19 is EDT: the close is 20:00Z, so 20:30Z (16:30 EDT) is after it.
    expect(expirySpansMacroEvent(scoredAtEst, "2027-03-19", [event("2027-03-19T20:30:00Z")])).toBe(false);
    expect(expirySpansMacroEvent(scoredAtEst, "2027-03-19", [event("2027-03-19T12:30:00Z")])).toBe(true); // CPI 08:30 EDT
  });

  it("an election (19:00 ET) the day before the expiry counts; one on the expiry day does not", () => {
    const scoredAt = Date.parse("2026-10-07T14:30:00Z");
    const election = event(easternInstant("2026-11-03", 19, 0).toISOString());
    expect(new Date(election.eventAtMs).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(expirySpansMacroEvent(scoredAt, "2026-11-03", [election])).toBe(false);
    expect(expirySpansMacroEvent(scoredAt, "2026-11-04", [election])).toBe(true);
  });

  it("is false for an empty list and for an event with an unparseable time (NaN)", () => {
    const scoredAt = Date.parse("2026-10-07T14:30:00Z");
    expect(expirySpansMacroEvent(scoredAt, "2026-11-20", [])).toBe(false);
    expect(expirySpansMacroEvent(scoredAt, "2026-11-20", [{ eventAtMs: Number.NaN }])).toBe(false);
  });

  it("an event after the expiry close that is still ahead does not count, any event before it does", () => {
    const scoredAt = Date.parse("2026-10-07T14:30:00Z");
    expect(expirySpansMacroEvent(scoredAt, "2026-10-16", [event("2026-10-20T12:30:00Z"), event("2026-10-15T12:30:00Z")])).toBe(true);
    expect(expirySpansMacroEvent(scoredAt, "2026-10-16", [event("2026-10-20T12:30:00Z")])).toBe(false);
  });
});
