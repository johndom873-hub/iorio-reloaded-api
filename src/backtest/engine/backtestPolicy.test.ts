import { describe, expect, it } from "vitest";
import type { RollSignalCandidate, RollSignalFlag } from "../../lib/rollSignalCandidates.js";
import type { SignalCandidate } from "../../lib/signalCandidates.js";
import { fixtureCandidateModel, fixtureRollModel } from "../../lib/testSupport/valuationModelFixtures.js";
import type { PlutoOpenCandidate, PlutoRollCandidate } from "../../pluto/candidateFilters.js";
import type { CloseOffer } from "../../pluto/closeActions.js";
import type { HeldPositionEntry } from "../../pluto/heldPositionMetrics.js";
import { defaultBacktestPolicySettings, type BacktestPolicySettings } from "../backtestTypes.js";
import { chooseBacktestAction, eventCloseRuleApplies, openClosedAtOnceByEventRule, type BacktestPassOffers } from "./backtestPolicy.js";

// The stand-in for the AI model: which offer a pass takes under each decision rule.

function candidate(strategyKey: "cash_secured_put" | "covered_call", strike: number, edgeYield: number, edgeDollars = 20): SignalCandidate {
  return { strategyKey, expiry: "2026-03-20", strike, dte: 10, delta: strategyKey === "covered_call" ? 0.25 : -0.25, bid: 0.95, ask: 1.05, model: fixtureCandidateModel({ expectedAnnualizedReturn: edgeYield, expectedPnlDollars: edgeDollars }) } as SignalCandidate;
}
function openOffer(symbol: string, strategyKey: "cash_secured_put" | "covered_call", strike: number, edgeYield: number, heldShares = false): PlutoOpenCandidate {
  return { id: `${symbol}:${strategyKey}:2026-03-20:${strike}`, kind: strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", symbol, candidate: candidate(strategyKey, strike, edgeYield), ...(heldShares ? { heldShares: { contracts: 1, breakEvenAfter: 48, profitIfCalledAway: 300 } } : {}) };
}
function rollOffer(symbol: string, legId: string, netRollDollars: number, flags: RollSignalFlag[]): PlutoRollCandidate {
  const roll = { legId, positionId: `position-of-${legId}`, strategyKey: "cash_secured_put", quantity: 1, replacement: candidate("cash_secured_put", 45, 0.3), flags, warnings: [], netRollEdgeDollars: netRollDollars, netRollEdge: 0.01, model: fixtureRollModel({ netExpectedPnl: netRollDollars, netExpectedPnlPerContract: netRollDollars }) } as unknown as RollSignalCandidate;
  return { id: `${symbol}:roll:${legId}:2026-03-27:45`, kind: "roll", symbol, roll };
}
function closeOffer(overrides: Partial<CloseOffer> & Pick<CloseOffer, "kind" | "symbol">): CloseOffer {
  return { id: `${overrides.symbol}:${overrides.kind}:x`, description: "close", cycle_pnl: 100, detail: {}, positionId: "position-1", legIds: ["leg-1"], automatic: false, automaticReason: null, limitPrice: 1, side: "buy", multiplier: 100, quantity: 1, ...overrides };
}
const sharesInProfit = closeOffer({ kind: "close_shares", symbol: "AAA", id: "AAA:close_shares:position-9", legIds: ["leg-9"], side: "sell", multiplier: 1, quantity: 100 });
const buyback = closeOffer({ kind: "close_leg", symbol: "AAA", id: "AAA:close_leg:leg-1" });
const offers = (overrides: Partial<BacktestPassOffers>): BacktestPassOffers => ({ closeOffers: [], heldPositions: [], eligibleRolls: [], eligibleOpens: [], coolingDownSymbols: new Set(), ...overrides });
const policy = (overrides: Partial<BacktestPolicySettings> = {}): BacktestPolicySettings => ({ ...defaultBacktestPolicySettings, ...overrides });

describe("the order of a pass", () => {
  it("takes a close before a roll, and a roll before an open", () => {
    const everything = offers({ closeOffers: [buyback], eligibleRolls: [rollOffer("AAA", "leg-2", 50, ["near_expiry"])], eligibleOpens: [openOffer("AAA", "cash_secured_put", 45, 0.4)] });
    expect(chooseBacktestAction(policy(), everything).choice).toMatchObject({ kind: "close", offer: buyback });
    expect(chooseBacktestAction(policy(), { ...everything, closeOffers: [] }).choice).toMatchObject({ kind: "roll" });
    expect(chooseBacktestAction(policy(), { ...everything, closeOffers: [], eligibleRolls: [] }).choice).toMatchObject({ kind: "open" });
    expect(chooseBacktestAction(policy(), offers({})).choice).toBeNull();
  });

  it("opens Pluto's top pick: the highest Edge Yield, then the highest Edge $", () => {
    const low = openOffer("AAA", "cash_secured_put", 44, 0.2);
    const high = openOffer("AAA", "cash_secured_put", 46, 0.5);
    const decision = chooseBacktestAction(policy(), offers({ eligibleOpens: [low, high] }));
    expect(decision.choice).toEqual({ kind: "open", open: high, chosenBecause: "Pluto's top pick by Edge Yield" });
  });
});

describe("roll or hold", () => {
  const flagged = rollOffer("AAA", "leg-1", 30, ["near_expiry"]);
  const unflaggedBetter = rollOffer("AAA", "leg-2", 90, []);
  const decayed = rollOffer("AAA", "leg-3", 60, ["decayed", "assignment_risk"]);

  it("rolls only a flagged leg by default, the best by net roll $", () => {
    const decision = chooseBacktestAction(policy(), offers({ eligibleRolls: [flagged, unflaggedBetter, decayed] }));
    expect(decision.choice).toMatchObject({ kind: "roll", roll: decayed, chosenBecause: "the best eligible roll on a leg flagged decayed, assignment risk" });
  });

  it("takes any eligible roll when the rule says so, and none when it says never", () => {
    expect(chooseBacktestAction(policy({ roll: "any_eligible" }), offers({ eligibleRolls: [flagged, unflaggedBetter] })).choice).toMatchObject({ kind: "roll", roll: unflaggedBetter });
    const open = openOffer("AAA", "cash_secured_put", 45, 0.4);
    expect(chooseBacktestAction(policy({ roll: "never" }), offers({ eligibleRolls: [flagged], eligibleOpens: [open] })).choice).toMatchObject({ kind: "open", open });
    expect(chooseBacktestAction(policy(), offers({ eligibleRolls: [unflaggedBetter] })).choice).toBeNull();
  });

  it("never rolls on a ticker cooling down after a fill", () => {
    const otherTicker = rollOffer("BBB", "leg-7", 10, ["near_expiry"]);
    const decision = chooseBacktestAction(policy(), offers({ eligibleRolls: [flagged, otherTicker], coolingDownSymbols: new Set(["AAA"]) }));
    expect(decision.choice).toMatchObject({ kind: "roll", roll: otherTicker });
  });
});

describe("a buyback because holding no longer pays", () => {
  it("is taken when offered, unless the rule is never", () => {
    expect(chooseBacktestAction(policy(), offers({ closeOffers: [buyback] })).choice).toEqual({ kind: "close", offer: buyback, chosenBecause: "holding the put no longer pays its closing cost" });
    const declined = chooseBacktestAction(policy({ buyback: "never" }), offers({ closeOffers: [buyback] }));
    expect(declined.choice).toBeNull();
    expect(declined.declined).toEqual([{ id: buyback.id, reason: "the rule is never to buy back" }]);
  });
});

describe("shares in profit above the floor", () => {
  const callOnThem = openOffer("AAA", "covered_call", 52, 0.1, true);
  const betterPut = openOffer("AAA", "cash_secured_put", 45, 0.9);

  it("sells a call on them when one clears the break-even rule, whatever else ranks higher", () => {
    const decision = chooseBacktestAction(policy(), offers({ closeOffers: [sharesInProfit], eligibleOpens: [betterPut, callOnThem] }));
    expect(decision.choice).toEqual({ kind: "open", open: callOnThem, chosenBecause: "shares in profit above the floor: a call on them clears the break-even rule" });
  });

  it("sells the shares when no call clears it", () => {
    const decision = chooseBacktestAction(policy(), offers({ closeOffers: [sharesInProfit], eligibleOpens: [betterPut] }));
    expect(decision.choice).toMatchObject({ kind: "close", offer: sharesInProfit, chosenBecause: "shares in profit above the floor: no call on them clears the break-even rule" });
  });

  it("waits when the ticker is cooling down after a fill, since no call can be offered then", () => {
    const decision = chooseBacktestAction(policy(), offers({ closeOffers: [sharesInProfit, buyback], coolingDownSymbols: new Set(["AAA"]) }));
    // The buyback further down the offers is still taken.
    expect(decision.choice).toMatchObject({ kind: "close", offer: buyback });
    expect(decision.declined).toEqual([{ id: sharesInProfit.id, reason: expect.stringContaining("cooling down") }]);
  });

  it("waits when no open can be sent on the ticker at this look (market stress, no room in the account)", () => {
    const barred = new Map([["AAA", "market stress bars new opens"]]);
    const decision = chooseBacktestAction(policy(), offers({ closeOffers: [sharesInProfit, buyback], opensBarredBySymbol: barred }));
    expect(decision.choice).toMatchObject({ kind: "close", offer: buyback });
    expect(decision.declined).toEqual([{ id: sharesInProfit.id, reason: "shares in profit: market stress bars new opens, so no call can be offered now; decided at a later look" }]);
    // The rule to always sell does not wait for a call.
    expect(chooseBacktestAction(policy({ sharesInProfit: "always_sell" }), offers({ closeOffers: [sharesInProfit], opensBarredBySymbol: barred })).choice).toMatchObject({ kind: "close", offer: sharesInProfit });
    // Another ticker's bar does not hold these shares back.
    expect(chooseBacktestAction(policy(), offers({ closeOffers: [sharesInProfit], opensBarredBySymbol: new Map([["BBB", "market stress bars new opens"]]) })).choice).toMatchObject({ kind: "close", offer: sharesInProfit });
  });

  it("always sells, or never sells, when the rule says so", () => {
    expect(chooseBacktestAction(policy({ sharesInProfit: "always_sell" }), offers({ closeOffers: [sharesInProfit], eligibleOpens: [callOnThem] })).choice).toMatchObject({ kind: "close", offer: sharesInProfit });
    expect(chooseBacktestAction(policy({ sharesInProfit: "always_keep" }), offers({ closeOffers: [sharesInProfit], eligibleOpens: [callOnThem] })).choice).toMatchObject({ kind: "open", open: callOnThem });
    const kept = chooseBacktestAction(policy({ sharesInProfit: "always_keep" }), offers({ closeOffers: [sharesInProfit], eligibleOpens: [betterPut] }));
    // Nothing sold: the pass goes on to its open.
    expect(kept.choice).toMatchObject({ kind: "open", open: betterPut });
    expect(kept.declined).toEqual([{ id: sharesInProfit.id, reason: expect.stringContaining("keep them") }]);
  });
});

describe("a close before a macro event", () => {
  const held = (overrides: Partial<HeldPositionEntry>): HeldPositionEntry => ({ legId: "leg-1", positionId: "position-1", strategy: "cash_secured_put", strike: 50, expiry: "2026-03-20", dte: 5, delta: -0.2, quantity: 1, entryCredit: 1, bid: 0.3, ask: 0.35, capturedPct: 65, maxRemainingGainDollars: 32, closeCostDollars: 3, strikeDistanceDays: 3, event: null, eventStressLossDollars: 40, ...overrides });
  const eventBuyback = closeOffer({ kind: "close_leg", symbol: "AAA", id: "AAA:close_leg:leg-1", reviewKey: "c60s2" });

  it("closes when the event's stress loss is at least what is left to earn less the close cost", () => {
    // Stress loss 40 against 32 left less 3 of cost: close. Stress loss 20: hold.
    expect(eventCloseRuleApplies("stress_vs_remaining", held({}))).toBe(true);
    expect(eventCloseRuleApplies("stress_vs_remaining", held({ eventStressLossDollars: 20 }))).toBe(false);
    expect(eventCloseRuleApplies("stress_vs_remaining", held({ eventStressLossDollars: null }))).toBe(false);
    expect(eventCloseRuleApplies("stress_vs_remaining", undefined)).toBe(false);
    expect(chooseBacktestAction(policy(), offers({ closeOffers: [eventBuyback], heldPositions: [held({})] })).choice).toMatchObject({ kind: "close", offer: eventBuyback });
    const holding = chooseBacktestAction(policy(), offers({ closeOffers: [eventBuyback], heldPositions: [held({ eventStressLossDollars: 20 })] }));
    expect(holding.choice).toBeNull();
    expect(holding.declined[0]!.reason).toContain("still exceeds the event's stress loss");
  });

  it("skips an open whose position the rule would close at once, saying why with the figures", () => {
    // A covered call just sold, CPI two sessions away: stress loss 1140 against 450 left to earn less 12 of cost (amounts as Pluto's close messages write them).
    const opened = held({ strategy: "covered_call", strike: 102, shares: 100, maxRemainingGainDollars: 450, closeCostDollars: 12, eventStressLossDollars: 1140, event: { title: "CPI", dateIso: "2026-03-04", sessionIso: "2026-03-04", weight: "heavy", sessionsUntil: 2, sessionsAfter: 3, stressNormalDays: 2 } });
    expect(openClosedAtOnceByEventRule("stress_vs_remaining", opened, true)).toBe("the event-close rule would close it at once before the 4 Mar CPI (heavy, 2 sessions away): stress loss $1140 ≥ what is left to earn $450 − the close cost $12");
    expect(openClosedAtOnceByEventRule("always", opened, true)).toBe("the event-close rule would close it at once before the 4 Mar CPI (heavy, 2 sessions away): the rule is to close");
    // Kept: the rule would not take the close, Pluto would not offer it (the cycle not in profit after the close cost), or the rule is never.
    expect(openClosedAtOnceByEventRule("stress_vs_remaining", { ...opened, eventStressLossDollars: 400 }, true)).toBeNull();
    expect(openClosedAtOnceByEventRule("stress_vs_remaining", opened, false)).toBeNull();
    expect(openClosedAtOnceByEventRule("never", opened, true)).toBeNull();
  });

  it("always or never closes when the rule says so", () => {
    expect(chooseBacktestAction(policy({ eventClose: "always" }), offers({ closeOffers: [eventBuyback], heldPositions: [held({ eventStressLossDollars: 0 })] })).choice).toMatchObject({ kind: "close" });
    expect(chooseBacktestAction(policy({ eventClose: "never" }), offers({ closeOffers: [eventBuyback], heldPositions: [held({})] })).choice).toBeNull();
  });

  it("still takes an event buyback the event rule declines when holding no longer pays either", () => {
    const merged = closeOffer({ kind: "close_leg", symbol: "AAA", id: "AAA:close_leg:leg-1", reviewKey: "c60s2", detail: { also_hold_value_negative: true } });
    const entry = held({ eventStressLossDollars: 20 });
    expect(chooseBacktestAction(policy(), offers({ closeOffers: [merged], heldPositions: [entry] })).choice).toMatchObject({ kind: "close", chosenBecause: "holding the put no longer pays its closing cost" });
    expect(chooseBacktestAction(policy({ buyback: "never" }), offers({ closeOffers: [merged], heldPositions: [entry] })).choice).toBeNull();
  });
});

describe("offers the gates refused earlier in the look", () => {
  it("are left out, so the rules fall to the next one of each kind", () => {
    const bestRoll = rollOffer("AAA", "leg-1", 90, ["near_expiry"]);
    const nextRoll = rollOffer("AAA", "leg-2", 40, ["decayed"]);
    const topOpen = openOffer("AAA", "cash_secured_put", 46, 0.5);
    const nextOpen = openOffer("AAA", "cash_secured_put", 44, 0.2);
    const everything = offers({ closeOffers: [buyback], eligibleRolls: [bestRoll, nextRoll], eligibleOpens: [nextOpen, topOpen] });
    const choiceWithout = (...refusedIds: string[]) => chooseBacktestAction(policy(), everything, new Set(refusedIds)).choice;
    expect(choiceWithout()).toMatchObject({ kind: "close", offer: buyback });
    expect(choiceWithout(buyback.id)).toMatchObject({ kind: "roll", roll: bestRoll });
    expect(choiceWithout(buyback.id, bestRoll.id)).toMatchObject({ kind: "roll", roll: nextRoll });
    expect(choiceWithout(buyback.id, bestRoll.id, nextRoll.id)).toMatchObject({ kind: "open", open: topOpen });
    expect(choiceWithout(buyback.id, bestRoll.id, nextRoll.id, topOpen.id)).toMatchObject({ kind: "open", open: nextOpen });
    expect(choiceWithout(buyback.id, bestRoll.id, nextRoll.id, topOpen.id, nextOpen.id)).toBeNull();
  });

  it("move shares in profit from the best call on them to the next, then to selling them", () => {
    const bestCall = openOffer("AAA", "covered_call", 52, 0.6, true);
    const nextCall = openOffer("AAA", "covered_call", 53, 0.3, true);
    const withShares = offers({ closeOffers: [sharesInProfit], eligibleOpens: [nextCall, bestCall] });
    expect(chooseBacktestAction(policy(), withShares).choice).toMatchObject({ kind: "open", open: bestCall });
    expect(chooseBacktestAction(policy(), withShares, new Set([bestCall.id])).choice).toMatchObject({ kind: "open", open: nextCall });
    expect(chooseBacktestAction(policy(), withShares, new Set([bestCall.id, nextCall.id])).choice).toMatchObject({ kind: "close", offer: sharesInProfit });
    expect(chooseBacktestAction(policy(), withShares, new Set([bestCall.id, nextCall.id, sharesInProfit.id])).choice).toBeNull();
  });
});
