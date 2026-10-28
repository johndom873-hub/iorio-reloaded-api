import { describe, expect, it } from "vitest";
import type { BacktestNoSaleDays, BacktestPositionLeg } from "./backtestTypes.js";
import { cycleNoCallDays, recordedRunReasons, volFarmerNoCallReason, volFarmerNoteOn, volFarmerRunReasons, volFarmerV2NoCallReasons, volFarmerV2NoteOn, volFarmerV2RunReasons } from "./cycleNoCallDays.js";

type Leg = Pick<BacktestPositionLeg, "legType" | "optionType" | "side" | "entryAt" | "exitAt">;
const stock = (entryAt: string, exitAt: string | null): Leg => ({ legType: "stock", optionType: null, side: "long", entryAt, exitAt });
const option = (optionType: "call" | "put", side: "long" | "short", entryAt: string, exitAt: string | null): Leg => ({ legType: "option", optionType, side, entryAt, exitAt });
// September 2026 is on Eastern daylight time: 10:00 ET = 14:00Z, the 16:00 close = 20:00Z.
const sessionDays = ["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];

describe("cycleNoCallDays", () => {
  it("counts the share days with no Call open at any time, in runs of consecutive session days", () => {
    // Shares bought Mon 14 Sep at 10:00 and sold Fri 25 Sep at 10:00; a Call from the 14th to its expiry on the 16th, one
    // sold on the 22nd and bought back on the 23rd; a hedge Put held from the 14th to Thu 17 at 10:00.
    const coverage = cycleNoCallDays({
      sessionDays,
      cycle: { openedOn: "2026-09-14", closedOn: "2026-09-25" },
      positions: [
        { strategyKey: "covered_call", legs: [stock("2026-09-14T14:00:00.000Z", "2026-09-25T14:00:00.000Z"), option("call", "short", "2026-09-14T14:00:00.000Z", "2026-09-16T20:00:00.000Z")] },
        { strategyKey: "covered_call", legs: [option("call", "short", "2026-09-22T14:00:00.000Z", "2026-09-23T15:00:00.000Z")] },
        { strategyKey: "hedge", legs: [option("put", "long", "2026-09-14T14:00:00.000Z", "2026-09-17T14:00:00.000Z")] },
      ],
    });
    // 10 share days (the 11th is before the cycle); the Calls cover 14–16 and 22–23, both ends included.
    expect(coverage.shareDays).toBe(10);
    expect(coverage.runs).toEqual([
      ["2026-09-17", "2026-09-18", "2026-09-21"],
      ["2026-09-24", "2026-09-25"],
    ]);
    expect([...coverage.hedgePutDays]).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
  });

  it("counts shares delivered at the 16:00 close from the next session, and an open leg to the session's last day", () => {
    // A put assigned at Fri 18 Sep's close; the first Call sold Tue 22 and still open; the cycle still open.
    const coverage = cycleNoCallDays({
      sessionDays,
      cycle: { openedOn: "2026-09-14", closedOn: null },
      positions: [
        { strategyKey: "cash_secured_put", legs: [option("put", "short", "2026-09-14T14:00:00.000Z", "2026-09-18T20:00:00.000Z")] },
        { strategyKey: "covered_call", legs: [stock("2026-09-18T20:00:00.000Z", null), option("call", "short", "2026-09-22T14:00:00.000Z", null)] },
      ],
    });
    expect(coverage.shareDays).toBe(5);
    expect(coverage.runs).toEqual([["2026-09-21"]]);
    expect(coverage.hedgePutDays.size).toBe(0);
  });

  it("has no runs for a cycle that never held shares", () => {
    const coverage = cycleNoCallDays({ sessionDays, cycle: { openedOn: "2026-09-14", closedOn: "2026-09-18" }, positions: [{ strategyKey: "cash_secured_put", legs: [option("put", "short", "2026-09-14T14:00:00.000Z", "2026-09-18T20:00:00.000Z")] }] });
    expect(coverage).toEqual({ shareDays: 0, runs: [], hedgePutDays: new Set() });
  });
});

describe("volFarmerNoteOn", () => {
  it("reads the symbol's note, after the look's time when the day names it", () => {
    const note = "no Call passes the hedge rule with the Put held and expires by it (shares at 324.38, the cycle's expired Puts +$1,002)";
    expect(volFarmerNoteOn(`AAPL: ${note}`, "AAPL")).toBe(note);
    expect(volFarmerNoteOn(`10:00 AAPL: ${note} · no action at the 11 later looks either · AAPL $322.5 Call · 28 Feb expired worthless at the 273.36 close, 200 shares kept`, "AAPL")).toBe(note);
  });

  it("finds a symbol's note among other symbols' parts, and none where the day has none", () => {
    const summary = "10:00 AAPL Sell $250 Put · 16 Oct (224DTE) · 2× @ 19.35 · COIN: no Call within the rules (delta 12, spread 3)";
    expect(volFarmerNoteOn(summary, "COIN")).toBe("no Call within the rules (delta 12, spread 3)");
    expect(volFarmerNoteOn(summary, "AAPL")).toBeNull();
    expect(volFarmerNoteOn("10:00 No action · no action at the 11 later looks either", "AAPL")).toBeNull();
    expect(volFarmerNoteOn(null, "AAPL")).toBeNull();
  });
});

describe("volFarmerNoCallReason", () => {
  it("names a hedge-rule note's reason with the break-even it states, else the shares' cost", () => {
    expect(volFarmerNoCallReason("no Call passes the hedge rule with the Put held and expires by it (shares at 324.38, the cycle's expired Puts +$1,002)")).toEqual({ reason: "no Call passed the hedge rule", figure: { kind: "shareCost", dollars: 324.38 } });
    expect(volFarmerNoCallReason("no Call passes the hedge rule on the shares alone (shares at 324.38, the cycle's Puts sold or expired +$1,002, so the shares break even at 319.37)")).toEqual({ reason: "no Call passed the hedge rule", figure: { kind: "breakEven", dollars: 319.37 } });
    expect(volFarmerNoCallReason("no Call has a Put that passes the hedge rule (4 Call(s), 9 Put(s) tried; shares at 101.50)")).toEqual({ reason: "no Call with a Put passed the hedge rule", figure: { kind: "shareCost", dollars: 101.5 } });
  });

  it("shortens the other notes, an unknown one to itself without its parenthesis", () => {
    expect(volFarmerNoCallReason("no Call within the rules (delta 12, spread 3)")).toEqual({ reason: "no Call within the rules", figure: null });
    expect(volFarmerNoCallReason("no Call sold: the volume limit allows none")).toEqual({ reason: "the volume limit", figure: null });
    expect(volFarmerNoCallReason("no Put with a usable quote from 30 to 400 days")).toEqual({ reason: "no Put with a usable quote from 30 to 400 days", figure: null });
    expect(volFarmerNoCallReason("no Put quotes (none listed)")).toEqual({ reason: "no Put quotes", figure: null });
  });
});

describe("volFarmerRunReasons", () => {
  it("counts each reason's days, most first, with the first day's note and figure; a day with no note under no reason recorded", () => {
    const hedgeRule = (cost: string) => `no Call passes the hedge rule with the Put held and expires by it (shares at ${cost})`;
    expect(
      volFarmerRunReasons([
        { date: "2026-09-17", note: "no Call within the rules (delta 12)" },
        { date: "2026-09-18", note: hedgeRule("50.10") },
        { date: "2026-09-21", note: hedgeRule("50.20") },
        { date: "2026-09-22", note: null },
      ]),
    ).toEqual([
      { reason: "no Call passed the hedge rule", days: 2, figure: { kind: "shareCost", dollars: 50.1 }, firstNote: { date: "2026-09-18", text: hedgeRule("50.10") } },
      { reason: "no Call within the rules", days: 1, figure: null, firstNote: { date: "2026-09-17", text: "no Call within the rules (delta 12)" } },
      { reason: "no reason recorded", days: 1, figure: null, firstNote: null },
    ]);
  });
});

describe("Vol Farmer v2's No Call reasons", () => {
  // The notes as backtestVolFarmerV2Look.ts writes them, one per position, the Puts' after them.
  const first = "first position: no Call at or above its break-even 14.20 (expiry 130, below cost 20, quote 9)";
  const second = "second position: no Call at or above its break-even 8.35 (below cost 12, delta 4)";
  const noPut = "no Put: no Call at or above the first break-even 14.20, but none qualifies at or below 11.42 (Step 19.6%: IV 67.8% × √(21 ÷ 252)) (quote 10)";

  it("reads the symbol's whole note, past its own orders' labels, up to the next symbol's note", () => {
    // AAOI on 15 Mar 2021: the LEAPS sale's label comes before the first position's note.
    const leapsSold = "AAOI Sell $7.5 Call · 21 Jan (312DTE) · 18× @ 3.33 (LEAPS: the second position was called away)";
    const day = `AAOI: the second position's Call was assigned: 100 shares called away; ${leapsSold}; ${first} · AAOI $8.5 Call · 12 Mar assigned at the 8.62 close: 100 shares called away at the strike`;
    expect(volFarmerV2NoteOn(day, "AAOI")).toBe(`the second position's Call was assigned: 100 shares called away; ${leapsSold}; ${first} · AAOI $8.5 Call · 12 Mar assigned at the 8.62 close: 100 shares called away at the strike`);
    expect(volFarmerV2NoCallReasons(volFarmerV2NoteOn(day, "AAOI")!).map((entry) => entry.reason)).toEqual(["no Call at or above B-E¹"]);
    // Another symbol's note ends it; the look's time before the symbol is dropped; no note on the symbol: null.
    expect(volFarmerV2NoteOn(`10:00 AAOI: ${first} · MSTR: ${second}`, "AAOI")).toBe(first);
    expect(volFarmerV2NoteOn(`MSTR: ${second}`, "AAOI")).toBeNull();
  });

  it("reads each position's note as its reason with its break-even, and leaves the Puts' note out", () => {
    expect(volFarmerV2NoCallReasons(`${first}; ${noPut}`)).toEqual([{ reason: "no Call at or above B-E¹", figure: { kind: "level", dollars: 14.2 }, text: first }]);
    expect(volFarmerV2NoCallReasons(`${first}; ${second}`).map((entry) => entry.reason)).toEqual(["no Call at or above B-E¹", "no Call at or above B-E²"]);
    expect(volFarmerV2NoCallReasons("first position: no Call sold: the volume limit allows none")).toEqual([{ reason: "the volume limit", figure: null, text: "first position: no Call sold: the volume limit allows none" }]);
    expect(volFarmerV2NoCallReasons("no option orders while the open cycle spans a split")[0]!.reason).toBe("a split inside the cycle");
    expect(volFarmerV2NoCallReasons(noPut)).toEqual([]);
    // Premiums past the shares' cost: a break-even below zero.
    expect(volFarmerV2NoCallReasons("the second position's Call was assigned: 300 shares called away, 7700 left; second position: no Call at or above its break-even -0.53 (quote 21)")[0]!.figure).toEqual({ kind: "level", dollars: -0.53 });
  });

  it("counts a day under every reason its note gives, most days first; a day with none under no reason recorded", () => {
    expect(
      volFarmerV2RunReasons([
        { date: "2021-03-22", note: `${first}; ${noPut}` },
        { date: "2021-03-23", note: `${first}; ${second}` },
        { date: "2021-03-24", note: noPut },
        { date: "2021-03-25", note: null },
      ]),
    ).toEqual([
      { reason: "no Call at or above B-E¹", days: 2, figure: { kind: "level", dollars: 14.2 }, firstNote: { date: "2021-03-22", text: first } },
      { reason: "no reason recorded", days: 2, figure: null, firstNote: null },
      { reason: "no Call at or above B-E²", days: 1, figure: { kind: "level", dollars: 8.35 }, firstNote: { date: "2021-03-23", text: second } },
    ]);
  });
});

describe("recordedRunReasons", () => {
  const none: BacktestNoSaleDays = { extensionZ: 0, ivRank: 0, ladderPutInstead: 0, cash: 0, volume: 0, noCandidate: 0, unrecorded: 0 };

  it("takes a stock-only stretch's stored counts for its days and each other day's records", () => {
    // The stretch (17–18 Sep) stored 2 no-candidate days; the 21st recorded the volume limit and the cash, the 22nd a
    // ladder put sold instead, the 23rd nothing.
    const reasons = recordedRunReasons({
      days: ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"],
      stretches: [{ firstIdleDay: "2026-09-17", lastIdleDay: "2026-09-18", noSaleDays: { ...none, noCandidate: 2 } }],
      reasonsOn: (date) => (date === "2026-09-21" ? ["volume", "cash"] : date === "2026-09-22" ? ["ladderPutInstead"] : date === "2026-09-17" ? ["volume"] : []),
    });
    expect(reasons).toEqual([
      { reason: "no candidate", days: 2, figure: null, firstNote: null },
      { reason: "a ladder put sold instead", days: 1, figure: null, firstNote: null },
      { reason: "not enough cash", days: 1, figure: null, firstNote: null },
      { reason: "the volume limit", days: 1, figure: null, firstNote: null },
      { reason: "no reason recorded", days: 1, figure: null, firstNote: null },
    ]);
  });
});
