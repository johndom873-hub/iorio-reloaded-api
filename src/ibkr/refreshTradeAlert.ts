import { MarketDataType, OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { daysBetween, parseExpiry, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";
import { decayThresholdFraction, dteThreshold } from "./generateRollCandidates.js";
import type { AlertCandidate, AlertStrategyKey } from "./generateTradeAlertCandidates.js";
import { computeProbabilityOfProfit } from "../lib/blackScholesPop.js";

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

export type TradeAlertRefreshResult = { ok: true } | { ok: false; error: string };

function toYyyymmdd(iso: string): string {
  return iso.replaceAll("-", "");
}
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
function midOrLast(quote: OptionQuote | null): number | null {
  if (!quote) return null;
  return quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : quote.last;
}

async function quoteContract(
  connection: IbkrConnection,
  symbol: string,
  expiryIso: string,
  strike: number,
  right: "call" | "put",
): Promise<OptionQuote | null> {
  const quotes = await quoteOptionChain(connection, symbol, [{ expiry: toYyyymmdd(expiryIso), strikes: [strike] }]);
  const optionType = right === "call" ? OptionType.Call : OptionType.Put;
  return quotes.find((q) => q.strike === strike && q.right === optionType) ?? null;
}

async function refreshNewTradeCandidate(
  connection: IbkrConnection,
  symbol: string,
  strategyKey: AlertStrategyKey,
  candidate: AlertCandidate,
): Promise<AlertCandidate | string> {
  const [pricing, quote] = await Promise.all([
    lookupPricingSnapshot(connection, symbol, 2),
    quoteContract(connection, symbol, candidate.expiry, candidate.strike, candidate.right),
  ]);
  const spotPrice = pricing.last ?? pricing.previousClose ?? candidate.spotPrice;
  const premium = midOrLast(quote);
  if (!quote || premium === null || premium <= 0 || quote.delta === null) {
    return "No live quote available for this contract right now — try again during market hours.";
  }

  const dte = daysBetween(new Date(), parseExpiry(toYyyymmdd(candidate.expiry)));
  if (dte <= 0) return "This contract has already expired.";
  const capitalAtRisk = strategyKey === "covered_call" ? spotPrice : candidate.strike;
  const probabilityOfProfit =
    quote.impliedVolatility !== null
      ? computeProbabilityOfProfit({
          spotPrice,
          strike: candidate.strike,
          premium,
          impliedVolatility: quote.impliedVolatility,
          daysToExpiry: dte,
          right: candidate.right,
        })
      : null;

  return {
    expiry: candidate.expiry,
    strike: candidate.strike,
    right: candidate.right,
    delta: quote.delta,
    premium,
    dte,
    annualizedYield: (premium / capitalAtRisk) * (365 / dte),
    spotPrice,
    probabilityOfProfit,
  };
}

function rationaleForRefreshedNewTrade(strategyKey: AlertStrategyKey, symbol: string, candidate: AlertCandidate): string {
  const action = strategyKey === "covered_call" ? "Sell 1x call" : "Sell 1x put";
  const pct = (candidate.annualizedYield * 100).toFixed(1);
  return `${action} on ${symbol}: $${candidate.strike.toFixed(2)} strike exp ${candidate.expiry} (${candidate.dte} DTE, Δ${candidate.delta.toFixed(2)}) for $${candidate.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

function rationaleForRefreshedRoll(
  symbol: string,
  closeLeg: { strike: number; expiry: string; right: "call" | "put"; entryPrice: number; currentPrice: number },
  trigger: "decay" | "dte",
  stillTriggered: boolean,
  dte: number,
  replacement: AlertCandidate,
): string {
  const rightLabel = closeLeg.right === "call" ? "call" : "put";
  const triggerLabel =
    trigger === "decay"
      ? `decayed to $${closeLeg.currentPrice.toFixed(2)} from $${closeLeg.entryPrice.toFixed(2)} collected (≤50%)`
      : `${dte} DTE remaining (≤21)`;
  const pct = (replacement.annualizedYield * 100).toFixed(1);
  const staleness = stillTriggered ? "" : " (no longer meets a roll trigger as of this refresh — re-check before acting)";
  return `Roll ${symbol} $${closeLeg.strike.toFixed(2)}${closeLeg.right === "call" ? "C" : "P"} exp ${closeLeg.expiry} — ${triggerLabel}${staleness}. Suggested replacement: sell 1x ${rightLabel} $${replacement.strike.toFixed(2)} strike exp ${replacement.expiry} (${replacement.dte} DTE, Δ${replacement.delta.toFixed(2)}) for $${replacement.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

/**
 * Re-quotes exactly the contract(s) an already-generated pending alert
 * suggests — not a re-run of the ranked candidate scan — so refreshing one
 * alert is a couple of small IBKR calls, not the multi-strike, multi-expiry
 * scan the nightly job does per ticker. Built 2026-08-24: alerts generate at
 * 10pm UTC but Juan (EU timezone) reviews them the next morning and wants to
 * validate them right as the US market opens, without re-running the whole
 * shortlist scan.
 *
 * Deliberately doesn't re-filter by the strategy's delta/DTE target window:
 * that window is for *picking* a candidate, not for validating one already
 * chosen — a contract that's drifted outside the band overnight (or a roll
 * that no longer meets its trigger) is exactly the case Juan wants
 * surfaced, not silently dropped or hidden.
 */
export async function refreshTradeAlert(alertId: string): Promise<TradeAlertRefreshResult> {
  const alert = await db("trade_alerts as ta")
    .join("tickers as t", "t.id", "ta.ticker_id")
    .where("ta.id", alertId)
    .select("ta.*", "t.symbol")
    .first();
  if (!alert) return { ok: false, error: "Trade alert not found." };
  if (alert.status !== "pending") {
    return { ok: false, error: `Only a pending alert can be refreshed (this one is ${alert.status}).` };
  }

  const strategyKey = alert.strategy_key as AlertStrategyKey;
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    if (alert.alert_type === "new_trade") {
      const candidate = alert.suggested_structure as AlertCandidate;
      const refreshed = await refreshNewTradeCandidate(connection, alert.symbol, strategyKey, candidate);
      if (typeof refreshed === "string") return { ok: false, error: refreshed };

      await db("trade_alerts").where({ id: alertId }).update({
        suggested_structure: JSON.stringify(refreshed),
        rationale: rationaleForRefreshedNewTrade(strategyKey, alert.symbol, refreshed),
        last_refreshed_at: db.fn.now(),
      });
      return { ok: true };
    }

    // alert_type === "roll"
    const structure = alert.suggested_structure as {
      closeLeg: { legId: string; strike: number; expiry: string; right: "call" | "put"; entryPrice: number; currentPrice: number; quantity: number; multiplier: number };
      trigger: "decay" | "dte";
      dte: number;
      replacement: AlertCandidate;
    };

    const closeQuote = await quoteContract(connection, alert.symbol, structure.closeLeg.expiry, structure.closeLeg.strike, structure.closeLeg.right);
    const currentPrice = midOrLast(closeQuote);
    if (currentPrice === null) {
      return { ok: false, error: "No live quote available for the closing leg right now — try again during market hours." };
    }

    const closeDte = daysBetween(new Date(), parseExpiry(toYyyymmdd(structure.closeLeg.expiry)));
    const decayed = currentPrice <= structure.closeLeg.entryPrice * decayThresholdFraction;
    const nearExpiry = closeDte <= dteThreshold;
    const stillTriggered = decayed || nearExpiry;
    const trigger: "decay" | "dte" = decayed ? "decay" : "dte";

    const refreshedReplacement = await refreshNewTradeCandidate(connection, alert.symbol, strategyKey, structure.replacement);
    if (typeof refreshedReplacement === "string") return { ok: false, error: refreshedReplacement };

    const refreshedCloseLeg = { ...structure.closeLeg, currentPrice };
    await db("trade_alerts")
      .where({ id: alertId })
      .update({
        suggested_structure: JSON.stringify({
          closeLeg: refreshedCloseLeg,
          trigger,
          dte: closeDte,
          replacement: refreshedReplacement,
          stillTriggered,
        }),
        rationale: rationaleForRefreshedRoll(alert.symbol, refreshedCloseLeg, trigger, stillTriggered, closeDte, refreshedReplacement),
        last_refreshed_at: db.fn.now(),
      });
    return { ok: true };
  } finally {
    connection.disconnect();
  }
}
