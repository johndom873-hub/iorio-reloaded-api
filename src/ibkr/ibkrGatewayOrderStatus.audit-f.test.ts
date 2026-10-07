import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));

const { cancellationReasonForIbkrCancel } = await import("./ibkrGatewayOrderStatus.js");
const { isWithinChainCaptureClockWindow } = await import("../lib/optionChainCaptureClock.js");
const { daysBetween } = await import("./fetchOptionChain.js");
const { easternDayStart, easternInstant: reExportedEasternInstant } = await import("../lib/marketSessionStatus.js");
const { easternInstant } = await import("../lib/easternIsoDate.js");

// Audit F (2026-10-07): callers that moved from easternDateIso to easternIsoDate, at the boundaries where Eastern and UTC
// calendar dates differ (20:00-24:00 ET) and on the DST weeks.

const utc = (iso: string) => new Date(iso);

describe("cancellationReasonForIbkrCancel", () => {
  it("an order from the previous Eastern day expired at that close, even when both instants share a UTC date", () => {
    // created 19:30 ET 10-06 (23:30Z 10-06), cancelled 09:31 ET 10-07 (13:31Z)
    expect(cancellationReasonForIbkrCancel(utc("2026-10-06T23:30:00Z"), utc("2026-10-07T13:31:00Z"))).toBe("expired_at_close");
  });
  it("an order created after 20:00 ET (already the next UTC day) and ended the same Eastern evening counts as after that day's close", () => {
    // created 20:30 ET 10-07 (00:30Z 10-08), ended 21:00 ET 10-07 (01:00Z 10-08): same Eastern day, after the 16:00 close
    expect(cancellationReasonForIbkrCancel(utc("2026-10-08T00:30:00Z"), utc("2026-10-08T01:00:00Z"))).toBe("expired_at_close");
  });
  it("a same-day cancel before the close is IBKR's, on both sides of each DST change", () => {
    expect(cancellationReasonForIbkrCancel(utc("2026-03-06T15:00:00Z"), utc("2026-03-06T20:59:00Z"))).toBe("cancelled_by_ibkr"); // 15:59 EST
    expect(cancellationReasonForIbkrCancel(utc("2026-03-09T14:00:00Z"), utc("2026-03-09T19:59:00Z"))).toBe("cancelled_by_ibkr"); // 15:59 EDT
    expect(cancellationReasonForIbkrCancel(utc("2026-03-09T14:00:00Z"), utc("2026-03-09T20:00:00Z"))).toBe("expired_at_close"); // 16:00 EDT
    expect(cancellationReasonForIbkrCancel(utc("2026-11-02T15:00:00Z"), utc("2026-11-02T20:30:00Z"))).toBe("cancelled_by_ibkr"); // 15:30 EST
    expect(cancellationReasonForIbkrCancel(utc("2026-11-02T15:00:00Z"), utc("2026-11-02T21:00:00Z"))).toBe("expired_at_close"); // 16:00 EST
  });
  it("uses a half-day close", () => {
    expect(cancellationReasonForIbkrCancel(utc("2026-11-27T15:00:00Z"), utc("2026-11-27T18:00:00Z"), "13:00")).toBe("expired_at_close");
    expect(cancellationReasonForIbkrCancel(utc("2026-11-27T15:00:00Z"), utc("2026-11-27T17:59:00Z"), "13:00")).toBe("cancelled_by_ibkr");
  });
});

describe("isWithinChainCaptureClockWindow", () => {
  it.each([
    ["2026-03-06T14:59:59Z", false], // 09:59:59 EST
    ["2026-03-06T15:00:00Z", true], // 10:00 EST
    ["2026-03-06T15:29:59Z", true],
    ["2026-03-06T15:30:00Z", false],
    ["2026-03-09T13:59:59Z", false], // 09:59:59 EDT, first Monday of EDT
    ["2026-03-09T14:00:00Z", true],
    ["2026-03-09T15:00:00Z", false], // 11:00 EDT (the EST slot)
    ["2026-11-02T14:00:00Z", false], // 09:00 EST, first Monday of EST
    ["2026-11-02T15:00:00Z", true],
  ])("%s -> %s", (iso, expected) => {
    expect(isWithinChainCaptureClockWindow(utc(iso))).toBe(expected);
  });
});

describe("daysBetween (fetchOptionChain)", () => {
  it("counts from the Eastern date, so 20:00-24:00 ET is still today", () => {
    const expiry = utc("2026-10-09T00:00:00Z");
    expect(daysBetween(utc("2026-10-07T23:59:00Z"), expiry)).toBe(2); // 19:59 ET 10-07
    expect(daysBetween(utc("2026-10-08T03:59:00Z"), expiry)).toBe(2); // 23:59 ET 10-07
    expect(daysBetween(utc("2026-10-08T04:00:00Z"), expiry)).toBe(1); // 00:00 ET 10-08
  });
  it("across the fall-back weekend", () => {
    expect(daysBetween(utc("2026-10-31T03:00:00Z"), utc("2026-11-02T00:00:00Z"))).toBe(3); // 23:00 EDT 10-30
    expect(daysBetween(utc("2026-11-02T04:30:00Z"), utc("2026-11-02T00:00:00Z"))).toBe(1); // 23:30 EST 11-01
  });
});

describe("marketSessionStatus re-exports", () => {
  it("easternInstant is the same function from both modules (callers import it from either)", () => {
    expect(reExportedEasternInstant).toBe(easternInstant);
  });
  it("easternDayStart is 00:00 ET of the Eastern day on ordinary days", () => {
    expect(easternDayStart(utc("2026-10-08T03:30:00Z")).toISOString()).toBe("2026-10-07T04:00:00.000Z");
    expect(easternDayStart(utc("2026-01-08T04:30:00Z")).toISOString()).toBe("2026-01-07T05:00:00.000Z");
  });
});
