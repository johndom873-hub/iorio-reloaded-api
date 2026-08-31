import { OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { daysBetween, parseExpiry, quoteOptionChain } from "./fetchOptionChain.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";
import { estimateRollCommissionComponent, halfSpread } from "../lib/rollEconomics.js";
import {
  generateTradeAlertCandidates,
  type AlertCandidate,
  type AlertStrategyKey,
  type AlertStrategySettings,
} from "./generateTradeAlertCandidates.js";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

export interface OpenShortLeg {
  legId: string;
  symbol: string;
  tickerId: string;
  strike: number;
  expiry: string; // YYYYMMDD
  right: "call" | "put";
  entryPrice: number; // credit collected per share when this leg was opened
  quantity: number;
  multiplier: number;
}

export interface RollSuggestion {
  trigger: "decay" | "dte";
  currentPrice: number;
  dte: number;
  replacement: AlertCandidate;
  // Credit actually collected by this specific roll (replacement.premium -
  // currentPrice) versus the real, measured cost of executing it
  // (commission + both legs' bid/ask spread — see lib/rollEconomics.ts).
  // netCredit > requiredMinimumCredit is guaranteed by construction: this is
  // the first replacement candidate that clears the floor, not a post-hoc
  // check.
  netCredit: number;
  requiredMinimumCredit: number;
  // False only when force-evaluated (see options.force below) for a leg that
  // hasn't actually hit either threshold — the batch job never sees false
  // here since it only calls this for legs it's already screened as
  // triggered. Lets the UI distinguish "you're rolling early" from a real
  // trigger, same badge pattern refreshTradeAlert.ts's stillTriggered uses.
  stillTriggered: boolean;
}

// Thresholds approved 2026-08-21 (see PROGRESS.md's roll-alert design note):
// close/roll a short option once it's decayed to <=50% of the credit
// collected (tastytrade's "50% rule" — moderate-confidence practitioner
// research, not independently reproducible) OR once DTE drops to <=21
// (gamma-risk inflection heuristic, real mechanism but no landmark study
// pins down "21" specifically), whichever comes first. A delta-based
// "avoid assignment" trigger was deliberately not added — no rigorous
// backing found for a specific number, and it cuts against covered calls
// generally *wanting* assignment per Juan's domain notes.
// Exported so refreshTradeAlert.ts's single-alert refresh recomputes a
// roll's trigger against the exact same approved thresholds, rather than a
// second hardcoded copy that could silently drift if these ever change.
export const decayThresholdFraction = 0.5;
export const dteThreshold = 21;

// Approved 2026-08-31: the DTE trigger is a gamma/pin-risk control and fires
// unconditionally. The decay trigger is a discretionary profit-take —
// rolling early only makes sense when the ticker's IV is rich enough that
// re-selling premium is actually attractive, so it's gated on ivRank >= 30
// (top ~70% of the ticker's own 252-day IV range). A ticker with too little
// IV history for a rank (null) isn't gated — same "absence of data isn't
// evidence against" convention as calendarUnverified. Exported for
// refreshTradeAlert.ts to recheck against the same threshold.
export const ivRankThresholdForDecayRoll = 30;

/**
 * Evaluates one open short option leg for a roll trigger and, if triggered,
 * finds a replacement candidate. Reuses generateTradeAlertCandidates (same
 * delta/DTE window from strategy_settings, same ranking) rather than a
 * separate roll-specific selection process — Juan's notes describe rolling
 * as "sell a new option for fresh premium," the same selection job #3
 * already does for new trades.
 */
export async function evaluateRollCandidate(
  connection: IbkrConnection,
  leg: OpenShortLeg,
  strategyKey: AlertStrategyKey,
  settings: AlertStrategySettings,
  // force: compute a replacement candidate even when neither threshold has
  // actually been hit — added 2026-08-31 for a user-initiated "Roll" click
  // on an arbitrary position (see evaluateRollForPosition.ts), which should
  // work regardless of whether the batch job would have flagged this leg.
  // The batch job never passes this, so its behavior is unchanged.
  options?: { force?: boolean },
): Promise<RollSuggestion | null> {
  const today = new Date();
  const dte = daysBetween(today, parseExpiry(leg.expiry));
  if (dte <= 0) return null; // already expired/expiring today, not a roll candidate

  const optionType = leg.right === "call" ? OptionType.Call : OptionType.Put;
  const quotes = await quoteOptionChain(connection, leg.symbol, [{ expiry: leg.expiry, strikes: [leg.strike] }]);
  const quote = quotes.find((q) => q.strike === leg.strike && q.right === optionType);
  const currentPrice = quote?.bid !== null && quote?.ask !== null && quote ? (quote.bid! + quote.ask!) / 2 : quote?.last ?? null;
  if (currentPrice === null || currentPrice === undefined) return null; // no live quote — skip rather than false-trigger

  const decayed = currentPrice <= leg.entryPrice * decayThresholdFraction;
  const nearExpiry = dte <= dteThreshold;
  const trigger: "decay" | "dte" = nearExpiry ? "dte" : "decay";

  let triggered = nearExpiry;
  if (!nearExpiry && decayed) {
    const ivMetrics = await computeIvMetrics(leg.tickerId);
    if (ivMetrics.ivRank === null || ivMetrics.ivRank >= ivRankThresholdForDecayRoll) triggered = true;
  }
  if (!triggered && !options?.force) return null;

  const candidates = await generateTradeAlertCandidates(connection, leg.symbol, leg.tickerId, strategyKey, settings);
  const closeSpread = halfSpread(quote?.bid ?? null, quote?.ask ?? null);
  const commissionComponent = await estimateRollCommissionComponent();

  let replacement: AlertCandidate | undefined;
  let netCredit = 0;
  let requiredMinimumCredit = 0;
  for (const candidate of candidates) {
    if (candidate.strike === leg.strike && candidate.expiry === toIsoDate(leg.expiry)) continue;
    const candidateNetCredit = candidate.premium - currentPrice;
    const minimumCredit = commissionComponent + closeSpread + halfSpread(candidate.bid, candidate.ask);
    if (candidateNetCredit > minimumCredit) {
      replacement = candidate;
      netCredit = candidateNetCredit;
      requiredMinimumCredit = minimumCredit;
      break;
    }
  }
  // No candidate in the strategy's delta/DTE band clears the real cost of
  // executing the roll — per Juan's 2026-08-31 call, this is an acceptable
  // outcome, not an error: the leg simply isn't suggested for a roll, and
  // Juan can choose to hold it to expiry/assignment or act manually.
  if (!replacement) return null;

  return { trigger, currentPrice, dte, replacement, netCredit, requiredMinimumCredit, stillTriggered: triggered };
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}
