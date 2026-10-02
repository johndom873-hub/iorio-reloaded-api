import { describe, expect, it } from "vitest";
import { findNonLiveSnapshotQuoteReason } from "./signalSnapshotLiveQuotes.js";

const now = new Date("2026-10-01T14:09:43.000Z");

describe("findNonLiveSnapshotQuoteReason", () => {
  it("accepts a roll whose legs are both live and fresh (a held leg may carry no quotedAt)", () => {
    const snapshot = { kind: "roll", closeLeg: { quoteSource: "live", quotedAt: null }, replacement: { quoteSource: "live", quotedAt: "2026-10-01T14:09:40.000Z" } };
    expect(findNonLiveSnapshotQuoteReason(snapshot, now)).toBeNull();
  });

  it("rejects the DRAM roll built from the previous session's day quotes", () => {
    const snapshot = {
      kind: "roll",
      closeLeg: { quoteSource: "day", quotedAt: "2026-09-30T19:59:55.718Z" },
      replacement: { quoteSource: "day", quotedAt: "2026-09-30T19:59:56.041Z" },
    };
    expect(findNonLiveSnapshotQuoteReason(snapshot, now)).toMatch(/leg being closed is priced from a day quote/);
  });

  it("rejects a roll whose new leg alone is not live", () => {
    const snapshot = { kind: "roll", closeLeg: { quoteSource: "live" }, replacement: { quoteSource: "snapshot", quotedAt: null } };
    expect(findNonLiveSnapshotQuoteReason(snapshot, now)).toMatch(/new leg is priced from a snapshot quote/);
  });

  it("rejects a live quote older than 15 seconds and accepts one exactly 15 seconds old", () => {
    const stale = { kind: "roll", closeLeg: { quoteSource: "live" }, replacement: { quoteSource: "live", quotedAt: "2026-10-01T14:09:27.999Z" } };
    const edge = { kind: "roll", closeLeg: { quoteSource: "live" }, replacement: { quoteSource: "live", quotedAt: "2026-10-01T14:09:28.000Z" } };
    expect(findNonLiveSnapshotQuoteReason(stale, now)).toMatch(/older than 15 seconds/);
    expect(findNonLiveSnapshotQuoteReason(edge, now)).toBeNull();
  });

  it("rejects an unparseable quotedAt rather than trusting it", () => {
    const snapshot = { kind: "roll", closeLeg: { quoteSource: "live" }, replacement: { quoteSource: "live", quotedAt: "not a date" } };
    expect(findNonLiveSnapshotQuoteReason(snapshot, now)).toMatch(/older than 15 seconds/);
  });

  it("checks an open order's candidate", () => {
    expect(findNonLiveSnapshotQuoteReason({ version: 1, candidate: { quoteSource: "live", quotedAt: "2026-10-01T14:09:40.000Z" } }, now)).toBeNull();
    expect(findNonLiveSnapshotQuoteReason({ version: 1, candidate: { quoteSource: "day", quotedAt: "2026-10-01T14:09:40.000Z" } }, now)).toMatch(/contract is priced from a day quote/);
  });

  it("rejects a snapshot with the quote missing and ignores a null or non-Signals one", () => {
    expect(findNonLiveSnapshotQuoteReason({ kind: "roll", replacement: { quoteSource: "live" } }, now)).toMatch(/no quote recorded/);
    expect(findNonLiveSnapshotQuoteReason(null, now)).toBeNull();
    expect(findNonLiveSnapshotQuoteReason({ version: 1 }, now)).toBeNull();
  });
});
