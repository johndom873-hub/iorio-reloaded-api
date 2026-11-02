import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import type { BacktestOrderShortfall } from "../backtestTypes.js";
import { buildCycleGaps, buildStockOnlyStretches, closeLookupOf, type NoSaleRecords } from "./backtestIdleStretches.js";
import type { LedgerLeg } from "./ledger/simulatedLedger.js";

// Weekdays, Good Friday 2021 (2 April) closed.
const calendar = {
  openDaysBetween(fromIso: string, toIso: string): string[] {
    const days: string[] = [];
    for (let dateIso = fromIso; dateIso <= toIso; dateIso = addCalendarDays(dateIso, 1)) {
      const weekday = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6 && dateIso !== "2021-04-02") days.push(dateIso);
    }
    return days;
  },
};

const shortfall = (tradingDate: string, step: BacktestOrderShortfall["step"], reason: BacktestOrderShortfall["reason"], symbol = "INTC"): BacktestOrderShortfall => ({
  tradingDate,
  at: `${tradingDate}T14:00:00.000Z`,
  lookTimeEt: "10:00",
  symbol,
  step,
  right: step === "held_calls" ? "C" : "P",
  wantedContracts: null,
  filledContracts: 0,
  unsoldContracts: null,
  reason,
  lookCount: 1,
  bestCandidate: null,
});
const noReasons = { extensionZ: 0, ivRank: 0, ladderPutInstead: 0, cash: 0, volume: 0, noCandidate: 0, unrecorded: 0 };

describe("closeLookupOf", () => {
  it("reads a close on a date and the last close before one", () => {
    const closes = closeLookupOf([
      { date: "2021-04-08", close: 62 },
      { date: "2021-04-09", close: 63 },
      { date: "2021-04-12", close: 61 },
    ]);
    expect(closes.closeOn("2021-04-09")).toBe(63);
    expect(closes.closeOn("2021-04-10")).toBeNull();
    expect(closes.closeBefore("2021-04-12")).toBe(63);
    expect(closes.closeBefore("2021-04-11")).toBe(63);
    expect(closes.closeBefore("2021-04-13")).toBe(61);
    expect(closes.closeBefore("2021-04-08")).toBeNull();
  });
});

describe("buildCycleGaps", () => {
  const closes = closeLookupOf([
    { date: "2021-03-24", close: 50 },
    { date: "2021-03-26", close: 51 },
    { date: "2021-04-09", close: 63 },
    { date: "2021-04-14", close: 60.48 },
    { date: "2021-04-16", close: 62 },
  ]);
  const cycles = [
    { cycleNumber: 1, openedOn: "2021-03-29", closedOn: "2021-04-01" },
    // Opens the session after #1 closed (Good Friday between): no gap.
    { cycleNumber: 2, openedOn: "2021-04-05", closedOn: "2021-04-09" },
    { cycleNumber: 3, openedOn: "2021-04-15", closedOn: "2021-04-16" },
  ];
  const records: NoSaleRecords = {
    shortfalls: [
      shortfall("2021-04-12", "entry", "no_candidate"),
      shortfall("2021-04-13", "entry", "cash"),
      // The calls' order, and another symbol: not the gap's.
      shortfall("2021-04-14", "held_calls", "volume"),
      shortfall("2021-04-14", "entry", "volume", "HOOD"),
    ],
  };

  it("finds the sessions with no cycle open before the first, between two and after the last, with the stock's move and the entry's shortfalls", () => {
    const gaps = buildCycleGaps({ symbol: "INTC", cycles, firstDay: "2021-03-25", lastDay: "2021-04-21", calendar, closes, records });
    expect(gaps).toEqual([
      // 50 → 51 from the close before the session's first day.
      { symbol: "INTC", afterCycleNumber: null, beforeCycleNumber: 1, firstIdleDay: "2021-03-25", lastIdleDay: "2021-03-26", idleSessions: 2, stockMove: expect.closeTo(0.02, 10), noSaleDays: { ...noReasons, unrecorded: 2 }, noCandidate: null, entryFilterLimits: { extensionZ: null, ivRank: null } },
      // 63.00 on the closing day → 60.48: −4.0%. Each day under the entry's shortfall seen on it.
      { symbol: "INTC", afterCycleNumber: 2, beforeCycleNumber: 3, firstIdleDay: "2021-04-12", lastIdleDay: "2021-04-14", idleSessions: 3, stockMove: expect.closeTo(-0.04, 10), noSaleDays: { ...noReasons, noCandidate: 1, cash: 1, unrecorded: 1 }, noCandidate: null, entryFilterLimits: { extensionZ: null, ivRank: null } },
      // To the session's end; no close on its last day.
      { symbol: "INTC", afterCycleNumber: 3, beforeCycleNumber: null, firstIdleDay: "2021-04-19", lastIdleDay: "2021-04-21", idleSessions: 3, stockMove: null, noSaleDays: { ...noReasons, unrecorded: 3 }, noCandidate: null, entryFilterLimits: { extensionZ: null, ivRank: null } },
    ]);
  });

  it("makes no gap after an open cycle, and one gap of every day for a symbol with none", () => {
    const openLast = [...cycles.slice(0, 2), { cycleNumber: 3, openedOn: "2021-04-15", closedOn: null }];
    expect(buildCycleGaps({ symbol: "INTC", cycles: openLast, firstDay: "2021-03-29", lastDay: "2021-04-21", calendar, closes, records }).map((gap) => [gap.firstIdleDay, gap.lastIdleDay])).toEqual([["2021-04-12", "2021-04-14"]]);
    expect(buildCycleGaps({ symbol: "INTC", cycles: [], firstDay: "2021-04-12", lastDay: "2021-04-14", calendar, closes, records })).toEqual([
      expect.objectContaining({ afterCycleNumber: null, beforeCycleNumber: null, firstIdleDay: "2021-04-12", lastIdleDay: "2021-04-14", idleSessions: 3 }),
    ]);
  });
});

describe("buildStockOnlyStretches", () => {
  let legNumber = 0;
  const leg = (fields: Partial<LedgerLeg> & Pick<LedgerLeg, "legType" | "side" | "quantity" | "entryAt">): LedgerLeg => ({
    id: `leg-${++legNumber}`,
    positionId: "position",
    parentLegId: null,
    settledAs: null,
    expiryClose: null,
    optionType: null,
    strikePrice: null,
    expiryDate: null,
    multiplier: fields.legType === "stock" ? 1 : 100,
    entryPrice: 1,
    exitPrice: null,
    exitAt: null,
    ...fields,
  });
  const at = (dateIso: string, hour: number) => easternInstant(dateIso, hour, 0);
  // A put sold Mon 5 April, assigned Fri 9 April (500 shares); no option Mon 12 and Tue 13; a ladder put alone Wed 14,
  // assigned at its expiry Fri 16 (200 more), a call on 500 from Thu 15; a call on 300 of them Mon 19 to Tue 20; none Wed 21.
  const legs = [
    leg({ legType: "option", side: "short", optionType: "put", quantity: 5, entryAt: at("2021-04-05", 10), exitAt: at("2021-04-09", 16), settledAs: "assigned" }),
    // The ledger keeps one stock leg at its last quantity: the 200 shares the put assigned on Fri 16 are on it from the 9th.
    leg({ legType: "stock", side: "long", quantity: 700, entryAt: at("2021-04-09", 16) }),
    leg({ legType: "option", side: "short", optionType: "put", quantity: 2, entryAt: at("2021-04-14", 10), exitAt: at("2021-04-16", 16), settledAs: "assigned" }),
    leg({ legType: "option", side: "short", optionType: "call", quantity: 5, entryAt: at("2021-04-15", 10), exitAt: at("2021-04-16", 16), settledAs: "worthless" }),
    leg({ legType: "option", side: "short", optionType: "call", quantity: 3, entryAt: at("2021-04-19", 10), exitAt: at("2021-04-20", 16), settledAs: "worthless" }),
  ];
  // The cycle's own trades: 500 shares from the first assignment, 200 more from the second.
  const sharesHeldAt = (atMs: number) => (atMs >= at("2021-04-09", 16).getTime() ? 500 : 0) + (atMs >= at("2021-04-16", 16).getTime() ? 200 : 0);
  const closes = closeLookupOf([
    { date: "2021-04-09", close: 95 },
    { date: "2021-04-13", close: 93.1 },
    { date: "2021-04-20", close: 97 },
    { date: "2021-04-21", close: 98.94 },
  ]);
  const records: NoSaleRecords = {
    // The entry's shortfall on the 13th is not the shares'.
    shortfalls: [shortfall("2021-04-12", "held_calls", "no_candidate"), shortfall("2021-04-13", "entry", "cash"), shortfall("2021-04-20", "held_calls", "volume")],
  };

  it("counts the whole sessions with shares and no option open: a put alone or a call on some of them makes none, nor a weekend roll; the shares from the cycle's trades", () => {
    const stretches = buildStockOnlyStretches({ symbol: "INTC", cycle: { openedOn: "2021-04-05", closedOn: null }, lastDay: "2021-04-21", legs, calendar, closes, records, sharesHeldAt, sharesAsTradedOn: () => 1 });
    expect(stretches).toEqual([
      // Assigned Friday, no option Monday and Tuesday, a put Wednesday: 95 → 93.10, −2%.
      { firstIdleDay: "2021-04-12", lastIdleDay: "2021-04-13", idleSessions: 2, stockMove: expect.closeTo(-0.02, 10), noSaleDays: { ...noReasons, noCandidate: 1, unrecorded: 1 }, noCandidate: null, sharesHeld: 500 },
      // The call on 300 shares expired Tuesday: none open Wednesday (97 → 98.94, +2%), 700 shares since Friday's assignment.
      { firstIdleDay: "2021-04-21", lastIdleDay: "2021-04-21", idleSessions: 1, stockMove: expect.closeTo(0.02, 10), noSaleDays: { ...noReasons, unrecorded: 1 }, noCandidate: null, sharesHeld: 700 },
    ]);
  });

  it("gives the shares as traded on the stretch's first day, and stops at the cycle's close", () => {
    const split = buildStockOnlyStretches({ symbol: "INTC", cycle: { openedOn: "2021-04-05", closedOn: null }, lastDay: "2021-04-21", legs, calendar, closes, records, sharesHeldAt, sharesAsTradedOn: (dateIso) => (dateIso >= "2021-04-19" ? 2 : 1) });
    expect(split.map((stretch) => stretch.sharesHeld)).toEqual([500, 1400]);
    const closedEarly = buildStockOnlyStretches({ symbol: "INTC", cycle: { openedOn: "2021-04-05", closedOn: "2021-04-12" }, lastDay: "2021-04-21", legs, calendar, closes, records, sharesHeldAt, sharesAsTradedOn: () => 1 });
    expect(closedEarly.map((stretch) => [stretch.firstIdleDay, stretch.lastIdleDay])).toEqual([["2021-04-12", "2021-04-12"]]);
  });
});
