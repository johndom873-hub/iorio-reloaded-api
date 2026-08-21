import { OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { daysBetween, parseExpiry, quoteOptionChain } from "./fetchOptionChain.js";
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
const decayThresholdFraction = 0.5;
const dteThreshold = 21;

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
  if (!decayed && !nearExpiry) return null;
  const trigger: "decay" | "dte" = decayed ? "decay" : "dte";

  const candidates = await generateTradeAlertCandidates(connection, leg.symbol, strategyKey, settings);
  const replacement = candidates.find((c) => !(c.strike === leg.strike && c.expiry === toIsoDate(leg.expiry)));
  if (!replacement) return null;

  return { trigger, currentPrice, dte, replacement };
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}
