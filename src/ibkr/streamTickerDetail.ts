import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { nextReqIdFor, sharedLiveConnection } from "./sharedReadConnection.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import { streamPricingUpdates, type TickerPricing, type PriceBar } from "./fetchTickerOverview.js";
import { getCachedChartBars } from "./priceBarCache.js";
import { prepareOptionChainStrikes, quoteOptionChain, type OptionQuote } from "./fetchOptionChain.js";
import { db } from "../db/connection.js";
import { computeMacd, computeMovingAverages, computeRsi, computeSupportResistance, type MacdSignal, type MovingAverages, type SupportResistanceResult } from "../lib/technicalIndicators.js";

export type TickerDetailSection = "overview" | "chart" | "optionChain" | "technicals";

export interface TickerOverview {
  companyName: string | null;
  sector: string | null;
  pricing: TickerPricing;
  isShortlisted: boolean;
}

export interface TickerTechnicals {
  movingAverages: MovingAverages;
  rsi: number;
  macdSignal: MacdSignal;
  supportResistance: SupportResistanceResult;
}

export type TickerDetailStreamEvent =
  | { type: "overview"; data: TickerOverview }
  | { type: "chart"; data: PriceBar[] }
  | { type: "optionChain"; data: OptionQuote[] }
  | { type: "technicals"; data: TickerTechnicals }
  | { type: "error"; section: TickerDetailSection; message: string };

// One-shot-connection numbering only. On the shared live connection every
// id comes from that connection's own counter instead (nextReqIdFor below):
// these fixed values would collide across concurrent modals sharing it.
const overviewReqId = 1;
const pricingReqId = 2;
const chartReqId = 3;
const technicalsDailyReqId = 4;
// A hovering-open hourly bar is one whose start time is within the current
// hour — mirrors IBKR's own bar semantics (bar_time = bar start), used to
// decide whether the latest 1h candle must be excluded from pivot discovery
// (see computeSupportResistance's currentCandleIsOpen parameter).
const oneHourInSeconds = 3600;

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

// Approved 2026-08-26: every pending alert's referenced strikes must appear
// in the chain, not just whatever the near-the-money window happens to catch
// — see the mustIncludeStrikes note on lookupValidStrikesForExpiry
// (fetchOptionChain.ts). Originally hand-parsed new_trade's suggested_structure
// shape only; a roll alert's close/replacement strikes were silently dropped
// for weeks after roll alerts started needing chain visibility (found live
// 2026-09-15 — AMAT's roll sat between the chain's $432.50/$440 rows and both
// legs vanished), since nothing forced a return trip to this function when
// that changed. Now reads the type-agnostic referenced_strikes column
// instead (populated by every alert insert/update site via
// referencedStrikesForNewTrade/referencedStrikesForRoll,
// lib/tradeAlertReferencedStrikes.ts) so a future alert shape can't repeat
// this — the write side can never forget, because it's the only source this
// query reads from.
async function fetchMustIncludeStrikesByExpiry(symbol: string): Promise<Map<string, number[]>> {
  const byExpiry = new Map<string, number[]>();
  function add(expiryYyyymmdd: string, strike: number) {
    const strikes = byExpiry.get(expiryYyyymmdd) ?? [];
    strikes.push(strike);
    byExpiry.set(expiryYyyymmdd, strikes);
  }

  const alertRows = await db("trade_alerts as ta")
    .join("tickers as t", "t.id", "ta.ticker_id")
    .where({ "t.symbol": symbol, "ta.status": "pending" })
    .select(db.raw("ta.referenced_strikes as referenced_strikes"));
  for (const row of alertRows as { referenced_strikes: { expiry: string; strike: number }[] }[]) {
    for (const { expiry, strike } of row.referenced_strikes ?? []) {
      add(expiry.replaceAll("-", ""), strike);
    }
  }

  // A currently-held option leg's own strike must always be visible in its
  // ticker's chain — independent of whether any alert happens to reference
  // it (an alert-only source is how the roll-alert gap above went
  // unnoticed for weeks: the position's real strike only ever showed up by
  // coincidence, via a roll alert pointing at it). Unioned in directly from
  // position_legs so this holds even with zero pending alerts.
  const legRows = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where({ "t.symbol": symbol, "p.status": "open", "pl.leg_type": "option" })
    .whereNull("pl.exit_at")
    .select(db.raw("pl.expiry_date::text as expiry"), db.raw("pl.strike_price::numeric as strike"));
  for (const row of legRows as { expiry: string; strike: string }[]) {
    add(row.expiry.replaceAll("-", ""), Number(row.strike));
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
  // Shared live connection first (no per-open tunnel + handshake, and its
  // market data type is fixed at REALTIME for the connection's whole life),
  // one-shot connection only when it isn't available.
  let borrowed: Awaited<ReturnType<typeof sharedLiveConnection.borrow>> | null = null;
  try {
    borrowed = await sharedLiveConnection.borrow();
  } catch (error) {
    console.log(
      `streamTickerDetail: shared live connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }
  const connection = borrowed ? { ib: borrowed.ib, disconnect: borrowed.release } : await connectToIbkrGateway();
  try {
    // Connection-wide setting, called exactly once here — not inside any of
    // streamPricingUpdates/getCachedChartBars/prepareOptionChainStrikes,
    // which all run concurrently on this connection below. A second call
    // while a market-data subscription is still outstanding was found to
    // silently prevent it from ever producing a first tick (see the note on
    // streamPricingUpdates). A no-op on the shared live connection, which
    // set REALTIME itself when it connected and must never be re-sent it by
    // a concurrent stream.
    requestRealtimeMarketData(connection.ib);

    const contractDetailsPromise = getCachedContractDetails(connection, symbol, nextReqIdFor(connection.ib, () => overviewReqId));
    // One check at stream start, not re-queried per pricing tick — shortlist
    // membership doesn't change mid-modal-open, and this only needs to be
    // fresh enough to gate the modal's own "Add to Shortlist" button.
    const isShortlistedPromise: Promise<boolean> = db("tickers as t")
      .join("shortlist_entries as se", "se.ticker_id", "t.id")
      .where({ "t.symbol": symbol })
      .whereNull("se.removed_at")
      .first()
      .then((row) => row !== undefined);

    const overviewReadyTask: Promise<TickerPricing | null> = (async () => {
      try {
        const [contractDetails, isShortlisted] = await Promise.all([contractDetailsPromise, isShortlistedPromise]);
        const pricing = await streamPricingUpdates(
          connection,
          symbol,
          (updatedPricing) => {
            onEvent({
              type: "overview",
              data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing: updatedPricing, isShortlisted },
            });
          },
          signal,
          nextReqIdFor(connection.ib, () => pricingReqId),
        );
        onEvent({
          type: "overview",
          data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing, isShortlisted },
        });
        return pricing;
      } catch (error) {
        onEvent({ type: "error", section: "overview", message: errorMessage(error) });
        return null;
      }
    })();

    const chartTask: Promise<PriceBar[]> = (async () => {
      try {
        const bars = await getCachedChartBars(connection, symbol, defaultChartRange, nextReqIdFor(connection.ib, () => chartReqId));
        onEvent({ type: "chart", data: bars });
        return bars;
      } catch (error) {
        onEvent({ type: "error", section: "chart", message: errorMessage(error) });
        return [];
      }
    })();

    // MA7/25/99, RSI, and MACD read daily closes (1Y, plenty of margin over
    // MA99's 99-close requirement); support/resistance reuses chartTask's
    // hourly bars rather than fetching them a second time. Waits on
    // overviewReadyTask for a current price the same way optionChainTask
    // does below — support/resistance's distance-from-price scoring and the
    // open-candle check both need it.
    const technicalsTask: Promise<void> = (async () => {
      try {
        const [hourlyBars, dailyBars, pricing] = await Promise.all([
          chartTask,
          getCachedChartBars(connection, symbol, "1Y", nextReqIdFor(connection.ib, () => technicalsDailyReqId)),
          overviewReadyTask,
        ]);
        const currentPrice = pricing?.last ?? pricing?.previousClose ?? dailyBars[dailyBars.length - 1]?.close ?? null;
        if (!currentPrice || hourlyBars.length === 0) {
          throw new Error("No market data available to compute technicals.");
        }

        const closes = dailyBars.map((bar) => bar.close);
        const lastHourlyBar = hourlyBars[hourlyBars.length - 1]!;
        const currentCandleIsOpen = Date.now() / 1000 - lastHourlyBar.time < oneHourInSeconds;

        onEvent({
          type: "technicals",
          data: {
            movingAverages: computeMovingAverages(closes),
            rsi: computeRsi(closes),
            macdSignal: computeMacd(closes),
            supportResistance: computeSupportResistance(hourlyBars, currentPrice, currentCandleIsOpen),
          },
        });
      } catch (error) {
        onEvent({ type: "error", section: "technicals", message: errorMessage(error) });
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

        const [dteRange, mustIncludeStrikesByExpiry] = await Promise.all([fetchStrategyDteRange(), fetchMustIncludeStrikesByExpiry(symbol)]);
        const expiryStrikes = await prepareOptionChainStrikes(
          connection,
          symbol,
          contractDetails.conId,
          spotPrice,
          dteRange,
          mustIncludeStrikesByExpiry,
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
    await Promise.all([overviewReadyTask, chartTask, optionChainTask, technicalsTask]);
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    connection.disconnect();
  }
}
