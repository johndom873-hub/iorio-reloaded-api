import { formatSignedDollars } from "../../lib/formatSignedDollars.js";
import { formatDayMonth } from "../../lib/optionContractLabel.js";
import { compareRollsByModel } from "../../lib/rollSignalCandidates.js";
import { deterministicTopPick, type PlutoOpenCandidate, type PlutoRollCandidate } from "../../pluto/candidateFilters.js";
import type { CloseOffer } from "../../pluto/closeActions.js";
import type { HeldPositionEntry } from "../../pluto/heldPositionMetrics.js";
import type { BacktestPolicySettings } from "../backtestTypes.js";

// The stand-in for the AI model in one pass (docs/backtesting/FULL-FIDELITY-DESIGN.md §5). Live, the model is shown the
// offers Pluto's code built (closes, eligible rolls, eligible opens) and answers with one of them or with nothing. Here
// the session's decision rules answer, in this order, taking the first that applies:
//   1. closes, in the order offered
//        shares in profit above the floor (P1, round lots). A call on them that clears Pluto's rules is not a choice: code
//        sells it before the pass, as live (backtestLook.ts, Marcelo 2026-10-12), so shares still offered here had none:
//          call_else_sell  sell them, unless the ticker is cooling down after a fill, market stress bars its opens or the
//                          account has no room for one (no call could be sent then, so the choice waits for a later look)
//          always_sell     sell them
//          always_keep     never a sale
//        a buyback because holding no longer pays (P2): when_offered takes it, never does not
//        a close before a macro event (F3): stress_vs_remaining takes it when the event's stress loss is at least what
//          is left to earn less the close cost; always; never. A put's event buyback that P2 also applies to follows
//          the buyback rule when the event rule declines it.
//   2. rolls: the best by net roll $ (compareRollsByModel) among the eligible rolls of tickers not cooling down after a
//        fill (the post-model gate would refuse those); flagged_legs keeps only legs flagged near expiry, assignment risk
//        or decayed; any_eligible keeps all; never rolls nothing
//   3. opens: Pluto's own top pick among the eligible opens (deterministicTopPick: Edge Yield, then Edge $). The look then
//        skips an open that the session's own event-close rule would close at once (openClosedAtOnceByEventRule,
//        approved 2026-10-12): the next candidate is chosen, or nothing
// The choice is always "trade", confidence 1, no data concerns. Offers the gates already refused in this look
// (afterBlockedChoice: try_next) are left out of all three steps, so the rules fall to the next one; the look leaves
// out the opens of a ticker, or of the whole book, once a refusal showed there is no room for one.

export interface BacktestPassOffers {
  /** The close offers left to a choice (automatic ones are executed before the pass), in the order they were built. */
  closeOffers: readonly CloseOffer[];
  /** Every held short put and covered call as Pluto shows it: the event closes' figures. */
  heldPositions: readonly HeldPositionEntry[];
  eligibleRolls: readonly PlutoRollCandidate[];
  eligibleOpens: readonly PlutoOpenCandidate[];
  /** Tickers inside the cooldown after a filled action. */
  coolingDownSymbols: ReadonlySet<string>;
  /** Tickers on which no open can be sent at this look for another reason, and why (market stress; the account has no room): rolls and closes stay. None when absent. */
  opensBarredBySymbol?: ReadonlyMap<string, string>;
}

export type BacktestPolicyChoice =
  | { kind: "close"; offer: CloseOffer; chosenBecause: string }
  | { kind: "roll"; roll: PlutoRollCandidate; chosenBecause: string }
  | { kind: "open"; open: PlutoOpenCandidate; chosenBecause: string };

export interface BacktestPolicyDecision {
  choice: BacktestPolicyChoice | null;
  /** Offers the rules declined, with why: for the day's summary. */
  declined: { id: string; reason: string }[];
}

/** Whether the event rule takes an event close, from the figures Pluto shows the model for the held position. */
export function eventCloseRuleApplies(rule: BacktestPolicySettings["eventClose"], entry: HeldPositionEntry | undefined): boolean {
  if (rule === "always") return true;
  if (rule === "never" || !entry) return false;
  if (entry.eventStressLossDollars === null || entry.maxRemainingGainDollars === null || entry.closeCostDollars === null) return false;
  return entry.eventStressLossDollars >= entry.maxRemainingGainDollars - entry.closeCostDollars;
}

/**
 * Rules mode only (Marcelo 2026-10-12): the rules do not open a contract that their own event-close rule would close at
 * once. `entry` is the position the open makes as Pluto would show it right after the fill (heldPositionMetrics.ts), and
 * `eventCloseOffered` whether Pluto would offer it the event close (F3) then. Why the open is skipped, or null to keep it.
 * A put sold under its mid is never offered an event buyback at once (the ask would not lock a profit), so in practice
 * this skips covered calls whose wheel cycle is already in profit after the close cost.
 */
export function openClosedAtOnceByEventRule(rule: BacktestPolicySettings["eventClose"], entry: HeldPositionEntry, eventCloseOffered: boolean): string | null {
  if (!eventCloseOffered || !eventCloseRuleApplies(rule, entry) || !entry.event) return null;
  const event = `the ${formatDayMonth(entry.event.dateIso)} ${entry.event.title} (${entry.event.weight}, ${entry.event.sessionsUntil} session${entry.event.sessionsUntil === 1 ? "" : "s"} away)`;
  if (rule === "always") return `the event-close rule would close it at once before ${event}: the rule is to close`;
  const dollars = (value: number | null) => (value === null ? "?" : formatSignedDollars(value, 0));
  return `the event-close rule would close it at once before ${event}: stress loss ${dollars(entry.eventStressLossDollars)} ≥ what is left to earn ${dollars(entry.maxRemainingGainDollars)} − the close cost ${dollars(entry.closeCostDollars)}`;
}

export function chooseBacktestAction(policy: BacktestPolicySettings, allOffers: BacktestPassOffers, refusedCandidateIds: ReadonlySet<string> = new Set()): BacktestPolicyDecision {
  const declined: { id: string; reason: string }[] = [];
  const stillOffered = <Offer extends { id: string }>(entries: readonly Offer[]) => entries.filter((entry) => !refusedCandidateIds.has(entry.id));
  const offers: BacktestPassOffers = { ...allOffers, closeOffers: stillOffered(allOffers.closeOffers), eligibleRolls: stillOffered(allOffers.eligibleRolls), eligibleOpens: stillOffered(allOffers.eligibleOpens) };

  for (const offer of offers.closeOffers) {
    if (offer.kind === "close_shares") {
      if (policy.sharesInProfit === "always_sell") return { choice: { kind: "close", offer, chosenBecause: "shares in profit above the floor: the rule is to sell them" }, declined };
      if (policy.sharesInProfit === "always_keep") declined.push({ id: offer.id, reason: "shares in profit: the rule is to keep them, and no call on them clears Pluto's rules" });
      else if (offers.coolingDownSymbols.has(offer.symbol)) declined.push({ id: offer.id, reason: "shares in profit: the ticker is cooling down after a fill, so no call can be offered yet; decided at a later look" });
      else if (offers.opensBarredBySymbol?.has(offer.symbol)) declined.push({ id: offer.id, reason: `shares in profit: ${offers.opensBarredBySymbol.get(offer.symbol)}, so no call can be offered now; decided at a later look` });
      else return { choice: { kind: "close", offer, chosenBecause: "shares in profit above the floor: no call on them clears Pluto's rules" }, declined };
      continue;
    }
    const isEventClose = offer.reviewKey !== undefined;
    if (isEventClose) {
      const entry = offers.heldPositions.find((held) => offer.legIds.includes(held.legId));
      if (eventCloseRuleApplies(policy.eventClose, entry)) return { choice: { kind: "close", offer, chosenBecause: policy.eventClose === "always" ? "before a macro event: the rule is to close" : "before a macro event: the event's stress loss is at least what is left to earn less the close cost" }, declined };
      const holdingNoLongerPays = offer.kind === "close_leg" && offer.detail.also_hold_value_negative === true;
      if (holdingNoLongerPays && policy.buyback === "when_offered") return { choice: { kind: "close", offer, chosenBecause: "holding the put no longer pays its closing cost" }, declined };
      declined.push({ id: offer.id, reason: policy.eventClose === "never" ? "before a macro event: the rule is never to close for events" : "before a macro event: what is left to earn still exceeds the event's stress loss" });
      continue;
    }
    if (policy.buyback === "when_offered") return { choice: { kind: "close", offer, chosenBecause: "holding the put no longer pays its closing cost" }, declined };
    declined.push({ id: offer.id, reason: "the rule is never to buy back" });
  }

  if (policy.roll !== "never") {
    const rolls = offers.eligibleRolls.filter((entry) => !offers.coolingDownSymbols.has(entry.symbol) && (policy.roll === "any_eligible" || entry.roll.flags.length > 0));
    const best = [...rolls].sort((a, b) => compareRollsByModel(a.roll, b.roll))[0];
    if (best) return { choice: { kind: "roll", roll: best, chosenBecause: policy.roll === "any_eligible" ? "the best eligible roll by net roll $" : `the best eligible roll on a leg flagged ${best.roll.flags.join(", ").replaceAll("_", " ")}` }, declined };
  }

  const topPick = deterministicTopPick([...offers.eligibleOpens]);
  if (topPick) return { choice: { kind: "open", open: topPick, chosenBecause: "Pluto's top pick by Edge Yield" }, declined };
  return { choice: null, declined };
}
