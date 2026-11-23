import { describe, expect, it } from "vitest";
import { newVolFarmerV4SymbolState, type VolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import { describeHoldingsMismatch, describeLedgerVerdict, judgeTickerLedger, ledgerHoldingsOf, ledgerMismatchHoldSeconds, memoryHoldingsOf, memoryOptionLegIds } from "./ledgerCheck.js";

// Pluto's memory against the ledger (Marcelo 2026-11-23): the 23 Nov IBIT case, a top-up of 200 filled while the ledger
// still showed 1,400 shares, then the rules for expiries, Calls sold outside Pluto and the 120 seconds before a hold.

function ibitState(shares: number, callLegId: string | null = "call-leg"): VolFarmerV4SymbolState {
  const state = newVolFarmerV4SymbolState();
  state.first = { shares, costPerShare: 41.08, premiums: [], calls: callLegId === null ? [] : [{ legId: callLegId, shares: 1600 }], puts: [] };
  return state;
}

const stockLeg = (quantity: number, id = "stock-leg") => ({ id, legType: "stock" as const, side: "long" as const, optionType: null, quantity, multiplier: 1, exitAt: null });
const shortCall = (contracts: number, id = "call-leg") => ({ id, legType: "option" as const, side: "short" as const, optionType: "call" as const, quantity: contracts, multiplier: 100, exitAt: null });
const openStatus = { closed: false, assigned: false };
const nowMs = Date.parse("2026-11-23T15:00:53Z");

describe("the holdings each side counts", () => {
  it("the memory: both positions' shares, the shares under their Calls and Puts, the LEAPS legs", () => {
    const state = ibitState(1600);
    state.second = { shares: 300, costPerShare: 30, premiums: [], calls: [{ legId: "c2", shares: 300 }], puts: [{ legId: "p1", shares: 500 }] };
    state.leaps = { legIds: ["l2", "l1"] } as VolFarmerV4SymbolState["leaps"];
    expect(memoryHoldingsOf(state)).toEqual({ shares: 1900, callShares: 1900, putShares: 500, longOptionLegIds: ["l1", "l2"] });
  });

  it("the ledger: open long stock, short Calls and Puts by their shares, long options by leg; closed legs left out", () => {
    const legs = [stockLeg(1600), stockLeg(200, "leftover"), shortCall(16), { ...shortCall(2, "old"), exitAt: new Date() }, { id: "put", legType: "option" as const, side: "short" as const, optionType: "put" as const, quantity: 5, multiplier: 100, exitAt: null }, { id: "leaps", legType: "option" as const, side: "long" as const, optionType: "call" as const, quantity: 3, multiplier: 100, exitAt: null }];
    expect(ledgerHoldingsOf(legs)).toEqual({ shares: 1800, callShares: 1600, putShares: 500, longOptionLegIds: ["leaps"] });
  });

  it("names each difference", () => {
    expect(describeHoldingsMismatch({ shares: 1600, callShares: 1600, putShares: 0, longOptionLegIds: [] }, { shares: 1400, callShares: 1600, putShares: 0, longOptionLegIds: [] })).toBe("shares: Pluto's memory 1600, the ledger 1400");
    expect(describeHoldingsMismatch({ shares: 1600, callShares: 0, putShares: 0, longOptionLegIds: [] }, { shares: 1600, callShares: 1600, putShares: 0, longOptionLegIds: [] })).toBe("shares under short Calls: Pluto's memory 0, the ledger 1600");
    expect(describeHoldingsMismatch({ shares: 1, callShares: 2, putShares: 3, longOptionLegIds: ["a"] }, { shares: 1, callShares: 2, putShares: 3, longOptionLegIds: ["a"] })).toBeNull();
  });

  it("the memory's option legs leave out orders still to settle", () => {
    const state = ibitState(1600, "action:abc");
    state.first!.calls.push({ legId: "real", shares: 100 }, { legId: "planned:1", shares: 100 }, { legId: "unsent-planned:2", shares: 100 });
    expect(memoryOptionLegIds(state)).toEqual(["real"]);
  });
});

describe("judgeTickerLedger: the 23 Nov IBIT top-up", () => {
  const statuses = new Map([["call-leg", openStatus]]);

  it("memory 1,600 against a ledger still at 1,400: catching up, first seen now", () => {
    const verdict = judgeTickerLedger({ state: ibitState(1600, null), openLegs: [stockLeg(1400)], legStatusById: statuses, nowMs, mismatchSinceMs: null });
    expect(verdict).toEqual({ kind: "catching_up", detail: "shares: Pluto's memory 1600, the ledger 1400", sinceMs: nowMs });
  });

  it("the ledger caught up: matches", () => {
    expect(judgeTickerLedger({ state: ibitState(1600, null), openLegs: [stockLeg(1600)], legStatusById: statuses, nowMs, mismatchSinceMs: nowMs - 10_000 })).toEqual({ kind: "matches" });
  });

  it("still apart 119 s after first seen: catching up; 120 s: held, the first time kept", () => {
    const since = nowMs - (ledgerMismatchHoldSeconds * 1000 - 1000);
    expect(judgeTickerLedger({ state: ibitState(1600, null), openLegs: [stockLeg(1400)], legStatusById: statuses, nowMs, mismatchSinceMs: since }).kind).toBe("catching_up");
    const held = judgeTickerLedger({ state: ibitState(1600, null), openLegs: [stockLeg(1400)], legStatusById: statuses, nowMs: since + ledgerMismatchHoldSeconds * 1000, mismatchSinceMs: since });
    expect(held).toEqual({ kind: "held", detail: "shares: Pluto's memory 1600, the ledger 1400", sinceMs: since });
  });

  it("the account holding 200 more than the memory (today's IBIT): a disagreement too", () => {
    expect(judgeTickerLedger({ state: ibitState(1600), openLegs: [stockLeg(1600), stockLeg(200, "leftover"), shortCall(16)], legStatusById: statuses, nowMs, mismatchSinceMs: null }).kind).toBe("catching_up");
  });

  it("a Call of the memory expired or assigned in the ledger: not compared until the look settles it", () => {
    for (const status of [{ closed: true, assigned: false }, { closed: false, assigned: true }]) {
      expect(judgeTickerLedger({ state: ibitState(1600), openLegs: [stockLeg(1600)], legStatusById: new Map([["call-leg", status]]), nowMs, mismatchSinceMs: null })).toEqual({ kind: "settling" });
    }
    // A leg the ledger does not know at all is settled by the look too.
    expect(judgeTickerLedger({ state: ibitState(1600), openLegs: [stockLeg(1600)], legStatusById: new Map(), nowMs, mismatchSinceMs: null })).toEqual({ kind: "settling" });
  });

  it("memory and ledger alike, Calls included: matches", () => {
    expect(judgeTickerLedger({ state: ibitState(1600), openLegs: [stockLeg(1400), stockLeg(200, "leftover"), shortCall(16)], legStatusById: statuses, nowMs, mismatchSinceMs: null })).toEqual({ kind: "matches" });
  });
});

describe("describeLedgerVerdict", () => {
  it("says what disagrees and since when, in ET", () => {
    expect(describeLedgerVerdict({ kind: "catching_up", detail: "shares: Pluto's memory 1600, the ledger 1400", sinceMs: nowMs })).toBe("the ledger is catching up on a fill (shares: Pluto's memory 1600, the ledger 1400), since 10:00 ET");
    expect(describeLedgerVerdict({ kind: "held", detail: "shares: Pluto's memory 1600, the ledger 1800", sinceMs: nowMs })).toBe("held: Pluto's memory and the ledger disagree since 10:00 ET (shares: Pluto's memory 1600, the ledger 1800); a person needs to look");
  });
});
