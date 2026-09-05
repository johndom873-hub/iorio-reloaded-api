import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { lookupPricingSnapshot } from "./fetchTickerOverview.js";
import { daysBetween, parseExpiry, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";
import { decayThresholdFraction, dteThreshold, ivRankThresholdForDecayRoll } from "./generateRollCandidates.js";
import type { AlertCandidate, AlertStrategyKey } from "./generateTradeAlertCandidates.js";
import { computeProbabilityOfProfit } from "../lib/blackScholesPop.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";
import { estimateRollCommissionComponent, halfSpread } from "../lib/rollEconomics.js";
import { fetchCalendarConflictContext, findCalendarConflict, type CalendarConflictContext } from "./calendarConflict.js";

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
  calendarContext: CalendarConflictContext,
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
  const bidAskSpreadPct = quote.bid !== null && quote.ask !== null ? ((quote.ask - quote.bid) / premium) * 100 : null;
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
    bid: quote.bid,
    ask: quote.ask,
    dte,
    annualizedYield: (premium / capitalAtRisk) * (365 / dte),
    spotPrice,
    probabilityOfProfit,
    // Carried forward unchanged — ticker-level 252-day stats, not something
    // that needs recomputing to re-quote one already-chosen contract.
    ivRank: candidate.ivRank,
    ivPercentile: candidate.ivPercentile,
    calendarUnverified: !calendarContext.resolved,
    // Carried forward unchanged, same reasoning as ivRank/ivPercentile above
    // — a same-day re-quote of one already-chosen contract doesn't warrant
    // re-running the support/resistance scan.
    technicalNote: candidate.technicalNote,
    bidAskSpreadPct,
    // Carried forward unchanged, same reasoning as technicalNote above.
    trendLabel: candidate.trendLabel,
  };
}

// Unlike generation (rankCandidates), refresh never drops a candidate for a
// calendar conflict — it's re-quoting a single already-chosen contract, and
// per this file's header comment the whole point of refresh is to surface
// drift, not hide it. A confirmed conflict here just becomes a visible
// warning in the rationale text instead.
function calendarNote(strategyKey: AlertStrategyKey, calendarContext: CalendarConflictContext, expiryIso: string, unverified: boolean): string {
  const conflict = findCalendarConflict(calendarContext, strategyKey, expiryIso);
  if (conflict) {
    const label = conflict.eventType === "earnings" ? "an earnings release" : "an ex-dividend date";
    return ` ⚠ Calendar conflict: ${label} on ${conflict.eventDate} falls before this expiry — position would remain open across the event.`;
  }
  if (unverified) return " (earnings/ex-div calendar unverified for this ticker — not yet resolved on TradingView)";
  return "";
}

function rationaleForRefreshedNewTrade(strategyKey: AlertStrategyKey, symbol: string, candidate: AlertCandidate, calendarContext: CalendarConflictContext): string {
  const action = strategyKey === "covered_call" ? "Sell 1x call" : "Sell 1x put";
  const pct = (candidate.annualizedYield * 100).toFixed(1);
  const note = calendarNote(strategyKey, calendarContext, candidate.expiry, candidate.calendarUnverified);
  const technicalNote = candidate.technicalNote ? ` ${candidate.technicalNote}` : "";
  return `${action} on ${symbol}: $${candidate.strike.toFixed(2)} strike exp ${candidate.expiry} (${candidate.dte} DTE, Δ${candidate.delta.toFixed(2)}) for $${candidate.premium.toFixed(2)} premium — ${pct}% annualized yield.${note}${technicalNote}`;
}

function rationaleForRefreshedRoll(
  symbol: string,
  strategyKey: AlertStrategyKey,
  closeLeg: { strike: number; expiry: string; right: "call" | "put"; entryPrice: number; currentPrice: number },
  trigger: "decay" | "dte",
  stillTriggered: boolean,
  dte: number,
  replacement: AlertCandidate,
  netCredit: number,
  stillNetCredit: boolean,
  calendarContext: CalendarConflictContext,
): string {
  const rightLabel = closeLeg.right === "call" ? "call" : "put";
  const triggerLabel =
    trigger === "decay"
      ? `decayed to $${closeLeg.currentPrice.toFixed(2)} from $${closeLeg.entryPrice.toFixed(2)} collected (≤50%)`
      : `${dte} DTE remaining (≤21)`;
  const pct = (replacement.annualizedYield * 100).toFixed(1);
  const staleness = stillTriggered ? "" : " (no longer meets a roll trigger as of this refresh — re-check before acting)";
  const creditStaleness = stillNetCredit
    ? ""
    : " (no longer a net credit after commission/spread as of this refresh — re-check before acting)";
  const note = calendarNote(strategyKey, calendarContext, replacement.expiry, replacement.calendarUnverified);
  return `Roll ${symbol} $${closeLeg.strike.toFixed(2)}${closeLeg.right === "call" ? "C" : "P"} exp ${closeLeg.expiry} — ${triggerLabel}${staleness}. Suggested replacement: sell 1x ${rightLabel} $${replacement.strike.toFixed(2)} strike exp ${replacement.expiry} (${replacement.dte} DTE, Δ${replacement.delta.toFixed(2)}) for $${replacement.premium.toFixed(2)} premium — ${pct}% annualized yield, $${netCredit.toFixed(2)} net credit after commission/spread${creditStaleness}.${note}`;
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
  const calendarContext = await fetchCalendarConflictContext(alert.ticker_id as string);
  const connection = await connectToIbkrGateway();
  try {
    requestRealtimeMarketData(connection.ib);

    if (alert.alert_type === "new_trade") {
      const candidate = alert.suggested_structure as AlertCandidate;
      const refreshed = await refreshNewTradeCandidate(connection, alert.symbol, strategyKey, candidate, calendarContext);
      if (typeof refreshed === "string") return { ok: false, error: refreshed };

      await db("trade_alerts").where({ id: alertId }).update({
        suggested_structure: JSON.stringify(refreshed),
        rationale: rationaleForRefreshedNewTrade(strategyKey, alert.symbol, refreshed, calendarContext),
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
    const trigger: "decay" | "dte" = nearExpiry ? "dte" : "decay";

    let stillTriggered = nearExpiry;
    if (!nearExpiry && decayed) {
      const ivMetrics = await computeIvMetrics(alert.ticker_id as string);
      if (ivMetrics.ivRank === null || ivMetrics.ivRank >= ivRankThresholdForDecayRoll) stillTriggered = true;
    }

    const refreshedReplacement = await refreshNewTradeCandidate(connection, alert.symbol, strategyKey, structure.replacement, calendarContext);
    if (typeof refreshedReplacement === "string") return { ok: false, error: refreshedReplacement };

    const commissionComponent = await estimateRollCommissionComponent();
    const closeSpread = halfSpread(closeQuote?.bid ?? null, closeQuote?.ask ?? null);
    const requiredMinimumCredit = commissionComponent + closeSpread + halfSpread(refreshedReplacement.bid, refreshedReplacement.ask);
    const netCredit = refreshedReplacement.premium - currentPrice;
    const stillNetCredit = netCredit > requiredMinimumCredit;

    const refreshedCloseLeg = { ...structure.closeLeg, currentPrice };
    await db("trade_alerts")
      .where({ id: alertId })
      .update({
        suggested_structure: JSON.stringify({
          closeLeg: refreshedCloseLeg,
          trigger,
          dte: closeDte,
          replacement: refreshedReplacement,
          netCredit,
          requiredMinimumCredit,
          stillTriggered,
          stillNetCredit,
        }),
        rationale: rationaleForRefreshedRoll(
          alert.symbol,
          strategyKey,
          refreshedCloseLeg,
          trigger,
          stillTriggered,
          closeDte,
          refreshedReplacement,
          netCredit,
          stillNetCredit,
          calendarContext,
        ),
        last_refreshed_at: db.fn.now(),
      });
    return { ok: true };
  } finally {
    connection.disconnect();
  }
}
