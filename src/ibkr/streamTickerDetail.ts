import { MarketDataType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { streamPricingUpdates, type TickerPricing, type PriceBar } from "./fetchTickerOverview.js";
import { getCachedChartBars } from "./priceBarCache.js";
import { prepareOptionChainStrikes, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";
import { db } from "../db/connection.js";

export type TickerDetailSection = "overview" | "chart" | "optionChain";

export interface TickerOverview {
  companyName: string | null;
  sector: string | null;
  pricing: TickerPricing;
}

export type TickerDetailStreamEvent =
  | { type: "overview"; data: TickerOverview }
  | { type: "chart"; data: PriceBar[] }
  | { type: "optionChain"; data: OptionQuote[] }
  | { type: "error"; section: TickerDetailSection; message: string };

const overviewReqId = 1;
const pricingReqId = 2;
const chartReqId = 3;

// The default range shown when the modal first opens — matches
// TickerPriceChart's own initial range. Switching ranges afterward goes
// through the plain /tickers/:symbol/chart request, unchanged.
const defaultChartRange = "3M" as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Chain window approved 2026-08-26: browse only the DTE range the platform's
// strategies actually trade (union across covered_call/cash_secured_put),
// not a generic 60-day window — narrower than the previous fixed 0-60, so
// fewer IBKR lines per open. Falls back to the old fixed window if
// strategy_settings has no rows for some reason (e.g. a fresh, unseeded DB).
async function fetchStrategyDteRange(): Promise<{ min: number; max: number }> {
  const result = await db("strategy_settings")
    .whereIn("strategy_key", ["covered_call", "cash_secured_put"])
    .min({ min: "dte_target_min" })
    .max({ max: "dte_target_max" })
    .first();
  const min = result?.min != null ? Number(result.min) : 0;
  const max = result?.max != null ? Number(result.max) : 60;
  return { min, max };
}

// Approved 2026-08-26: every pending new_trade alert's strike must appear in
// the chain, not just whatever the near-the-money window happens to catch —
// see the mustIncludeStrikes note on lookupValidStrikesForExpiry
// (fetchOptionChain.ts). Roll alerts are excluded — the frontend doesn't
// flag them on this screen (see TickerDetailModal.tsx's newTradeAlerts()).
async function fetchPendingAlertStrikesByExpiry(symbol: string): Promise<Map<string, number[]>> {
  const rows = await db("trade_alerts as ta")
    .join("tickers as t", "t.id", "ta.ticker_id")
    .where({ "t.symbol": symbol, "ta.status": "pending", "ta.alert_type": "new_trade" })
    .select(db.raw("ta.suggested_structure->>'expiry' as expiry"), db.raw("(ta.suggested_structure->>'strike')::numeric as strike"));

  const byExpiry = new Map<string, number[]>();
  for (const row of rows as { expiry: string; strike: string }[]) {
    const expiryYyyymmdd = row.expiry.replaceAll("-", "");
    const strikes = byExpiry.get(expiryYyyymmdd) ?? [];
    strikes.push(Number(row.strike));
    byExpiry.set(expiryYyyymmdd, strikes);
  }
  return byExpiry;
}

/**
 * Streams the three pieces the Ticker Detail modal needs — company/pricing
 * overview, default-range chart bars, and the option chain — as each
 * becomes ready, over one shared IBKR connection, instead of blocking on
 * all three before returning anything (the old fetchTickerDetail did this,
 * taking ~20-25s end to end; see PROGRESS.md for the measured breakdown).
 *
 * All three run concurrently, but optionChain has real dependencies: it
 * needs the underlying's conId (shared with overview's contractDetails
 * lookup — see below) and, since fetchOptionChain.ts started validating
 * candidate strikes one at a time instead of via a wildcard scan, it now
 * also needs the spot price up front to know which strikes are worth
 * checking. So optionChain waits on overviewTask before starting its own
 * IBKR calls — a smaller overlap than before, traded for eliminating the
 * 10-20s+ throttled wildcard contractDetails call that used to be the
 * dominant cost (see fetchOptionChain.ts for why that call was throttled).
 *
 * conId comes from the *same* contractDetails lookup overview already
 * needs for companyName/sector — the two share one promise/one
 * reqContractDetails call, not two. An earlier version had optionChain do
 * its own separate reqContractDetails call for conId; firing two identical
 * contractDetails lookups for the same underlying concurrently at
 * connection start reproduced real IBKR request-pacing contention (a
 * "Pricing snapshot timeout").
 *
 * Each task catches its own errors and reports them as a section-specific
 * `error` event rather than failing the whole stream — IBKR's per-account
 * pacing limits mean one section can time out without the others being
 * affected.
 *
 * Prices are live, not a one-time snapshot (approved 2026-08-26): pricing
 * and the option chain's quotes keep updating for as long as the client
 * stays connected, via `signal` — the route (tickerDetail.ts) aborts it the
 * moment the SSE connection closes (the modal closed, or the browser
 * navigated away). Only the chart stays one-shot per open — bars don't
 * live-tick the way a price does, and range switching already goes through
 * its own separate request.
 */
export async function streamTickerDetail(
  symbol: string,
  onEvent: (event: TickerDetailStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const connection = await connectToIbkrGateway();
  try {
    // Connection-wide setting, called exactly once here — not inside any of
    // streamPricingUpdates/getCachedChartBars/prepareOptionChainStrikes,
    // which all run concurrently on this connection below. A second call
    // while a market-data subscription is still outstanding was found to
    // silently prevent it from ever producing a first tick (see the note on
    // streamPricingUpdates).
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    const contractDetailsPromise = getCachedContractDetails(connection, symbol, overviewReqId);

    const overviewReadyTask: Promise<TickerPricing | null> = (async () => {
      try {
        const contractDetails = await contractDetailsPromise;
        const pricing = await streamPricingUpdates(
          connection,
          symbol,
          (updatedPricing) => {
            onEvent({
              type: "overview",
              data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing: updatedPricing },
            });
          },
          signal,
          pricingReqId,
        );
        onEvent({
          type: "overview",
          data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing },
        });
        return pricing;
      } catch (error) {
        onEvent({ type: "error", section: "overview", message: errorMessage(error) });
        return null;
      }
    })();

    const chartTask: Promise<void> = (async () => {
      try {
        const bars = await getCachedChartBars(connection, symbol, defaultChartRange, chartReqId);
        onEvent({ type: "chart", data: bars });
      } catch (error) {
        onEvent({ type: "error", section: "chart", message: errorMessage(error) });
      }
    })();

    const optionChainTask: Promise<void> = (async () => {
      try {
        const contractDetails = await contractDetailsPromise;
        if (!contractDetails.conId) throw new Error("No contract found to look up the option chain.");

        // Waits for the *first* pricing reading only (streamPricingUpdates'
        // own promise resolves there) — the option chain doesn't need to
        // wait for every subsequent live pricing tick, just an initial spot
        // price to pick near-the-money strikes.
        const pricing = await overviewReadyTask;
        const spotPrice = pricing?.last ?? pricing?.previousClose;
        if (!spotPrice) throw new Error("No spot price available to select option strikes.");

        const [dteRange, alertStrikesByExpiry] = await Promise.all([fetchStrategyDteRange(), fetchPendingAlertStrikesByExpiry(symbol)]);
        const expiryStrikes = await prepareOptionChainStrikes(
          connection,
          symbol,
          contractDetails.conId,
          spotPrice,
          dteRange,
          alertStrikesByExpiry,
        );
        const optionChain = await quoteOptionChain(connection, symbol, expiryStrikes, {
          onUpdate: (updatedQuotes) => onEvent({ type: "optionChain", data: updatedQuotes }),
          signal,
        });
        onEvent({ type: "optionChain", data: optionChain });
      } catch (error) {
        onEvent({ type: "error", section: "optionChain", message: errorMessage(error) });
      }
    })();

    // Each task above resolves as soon as its section's *initial* paint is
    // ready — that's what makes the modal open fast. But the whole point of
    // streaming is that the connection (and the background push intervals
    // streamPricingUpdates/quoteOptionChain kicked off) must stay alive
    // past that point. So this function itself doesn't return — and the
    // `finally` below doesn't disconnect from IBKR — until `signal` aborts,
    // which the route does the moment the SSE client actually disconnects.
    await Promise.all([overviewReadyTask, chartTask, optionChainTask]);
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    connection.disconnect();
  }
}
