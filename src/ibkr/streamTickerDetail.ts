import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { nextReqIdFor, sharedLiveConnection } from "./sharedReadConnection.js";
import { getCachedContractDetails } from "./fetchNewTickerData.js";
import type { TickerPricing, PriceBar } from "./fetchTickerOverview.js";
import { subscribeToPooledQuote, type PooledQuote } from "./marketDataPool.js";
import { streamPooledPrices } from "./pricePool.js";
import { getCachedChartBars } from "./priceBarCache.js";
import { db } from "../db/connection.js";
import { computeMacd, computeMovingAverages, computeRsi, computeSupportResistance, type MacdSignal, type MovingAverages, type SupportResistanceResult } from "../lib/technicalIndicators.js";

export type TickerDetailSection = "overview" | "chart" | "technicals";

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
  // The stock price shown in the header: same frozen-then-live, last-trade-only source as the Positions table (streamLivePrices).
  | { type: "spot"; data: { last: number } }
  | { type: "chart"; data: PriceBar[] }
  | { type: "technicals"; data: TickerTechnicals }
  | { type: "error"; section: TickerDetailSection; message: string };

// One-shot-connection numbering only. On the shared live connection every
// id comes from that connection's own counter instead (nextReqIdFor below):
// these fixed values would collide across concurrent modals sharing it.
// How long technicals wait for the frozen last price before falling back to the pricing stream.
const firstSpotWaitMs = 5_000;
const overviewReadyWaitMs = 5_000;
const overviewReqId = 1;

function toTickerPricing(quote: PooledQuote | null): TickerPricing {
  return {
    last: quote?.last ?? null,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    open: quote?.open ?? null,
    high: quote?.high ?? null,
    low: quote?.low ?? null,
    previousClose: quote?.previousClose ?? null,
    volume: quote?.volume ?? null,
  };
}
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

/**
 * Streams what the Signals modal's ticker panel needs — company/pricing
 * overview, the header spot price, default-range chart bars and technicals —
 * each as soon as it is ready, over one shared IBKR connection.
 *
 * Each task catches its own errors and reports them as a section-specific
 * `error` event rather than failing the whole stream — IBKR's per-account
 * pacing limits mean one section can time out without the others being
 * affected.
 *
 * Prices are live, not a one-time snapshot (approved 2026-08-26): they keep
 * updating for as long as the client stays connected, via `signal` — the
 * route (tickerDetail.ts) aborts it the moment the SSE connection closes.
 * Only the chart stays one-shot per open — bars don't live-tick the way a
 * price does, and range switching already goes through its own separate
 * request.
 */
// Which parts a client wants; absent = everything. Technicals need the
// chart's bars, so asking for technicals fetches them even when "chart"
// itself is not requested.
export type TickerDetailStreamSection = "overview" | "spot" | "chart" | "technicals";
export const allTickerDetailStreamSections: readonly TickerDetailStreamSection[] = ["overview", "spot", "chart", "technicals"];

export async function streamTickerDetail(
  symbol: string,
  onEvent: (event: TickerDetailStreamEvent) => void,
  signal: AbortSignal,
  requestedSections: readonly TickerDetailStreamSection[] = allTickerDetailStreamSections,
): Promise<void> {
  const sections = new Set(requestedSections);
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
    // getCachedChartBars, which run concurrently on this connection below. A second call
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
    // Both are started for every stream but only awaited by the overview section: on a stream without it, a failure here would be an
    // unhandled rejection. The overview still awaits the originals and sees any error.
    contractDetailsPromise.catch(() => {});
    isShortlistedPromise.catch(() => {});

    // Approved 2026-09-19: the header price must equal the Positions table's. This connection's own pricing stream is
    // REALTIME-only, so on a closed market it never gets a last trade and only reports the PREVIOUS session's close
    // (AAOI showed 98.06 while the last trade was 104.90). streamLivePrices (frozen last first, then live ticks, last
    // trade only, on the read connection) is the one price source everything else uses, so it feeds the header and the
    // current price technicals score against.
    let firstSpotResolved = false;
    let resolveFirstSpot: (price: number | null) => void = () => {};
    const firstSpotPromise = new Promise<number | null>((resolve) => {
      resolveFirstSpot = resolve;
    });
    const firstSpotTimer = setTimeout(() => resolveFirstSpot(null), sections.has("spot") ? firstSpotWaitMs : 0);
    const spotTask: Promise<void> = sections.has("spot")
      ? streamPooledPrices(
          [{ key: symbol, legType: "stock", symbol }],
          (pricesByKey) => {
            const last = pricesByKey[symbol];
            if (last === null || last === undefined) return;
            onEvent({ type: "spot", data: { last } });
            if (!firstSpotResolved) {
              firstSpotResolved = true;
              clearTimeout(firstSpotTimer);
              resolveFirstSpot(last);
            }
          },
          signal,
        ).catch((error) => {
          console.error(`streamTickerDetail: spot price stream failed for ${symbol}`, error);
        })
      : Promise.resolve();

    // Overview pricing comes from the POOLED stock line (2026-09-24) — the
    // same line the header's spot price and every other screen share — not
    // a second, unbudgeted subscription of its own as before. Ready on the
    // first last/previous-close reading, or after overviewReadyWaitMs with
    // whatever has arrived.
    const overviewReadyTask: Promise<TickerPricing | null> = (async () => {
      if (!sections.has("overview")) return null;
      try {
        const [contractDetails, isShortlisted] = await Promise.all([contractDetailsPromise, isShortlistedPromise]);
        let latestPricing = toTickerPricing(null);
        let resolveReady: (pricing: TickerPricing) => void = () => {};
        const ready = new Promise<TickerPricing>((resolve) => {
          resolveReady = resolve;
        });
        const readyTimer = setTimeout(() => resolveReady(latestPricing), overviewReadyWaitMs);
        const unsubscribe = await subscribeToPooledQuote({ key: symbol, legType: "stock", symbol }, (quote) => {
          latestPricing = toTickerPricing(quote);
          onEvent({ type: "overview", data: { companyName: contractDetails.companyName, sector: contractDetails.sector, pricing: latestPricing, isShortlisted } });
          if (latestPricing.last !== null || latestPricing.previousClose !== null) {
            clearTimeout(readyTimer);
            resolveReady(latestPricing);
          }
        });
        if (signal.aborted) unsubscribe();
        else signal.addEventListener("abort", unsubscribe, { once: true });
        return await ready;
      } catch (error) {
        onEvent({ type: "error", section: "overview", message: errorMessage(error) });
        return null;
      }
    })();

    const chartTask: Promise<PriceBar[]> = (async () => {
      if (!sections.has("chart") && !sections.has("technicals")) return [];
      try {
        const bars = await getCachedChartBars(connection, symbol, defaultChartRange, nextReqIdFor(connection.ib, () => chartReqId));
        if (sections.has("chart")) onEvent({ type: "chart", data: bars });
        return bars;
      } catch (error) {
        if (sections.has("chart")) onEvent({ type: "error", section: "chart", message: errorMessage(error) });
        return [];
      }
    })();

    // MA7/25/99, RSI, and MACD read daily closes (1Y, plenty of margin over
    // MA99's 99-close requirement); support/resistance reuses chartTask's
    // hourly bars rather than fetching them a second time. Waits on
    // overviewReadyTask for a current price — support/resistance's
    // distance-from-price scoring and the open-candle check both need it.
    const technicalsTask: Promise<void> = (async () => {
      if (!sections.has("technicals")) return;
      try {
        const [hourlyBars, dailyBars, pricing] = await Promise.all([
          chartTask,
          getCachedChartBars(connection, symbol, "1Y", nextReqIdFor(connection.ib, () => technicalsDailyReqId)),
          overviewReadyTask,
        ]);
        const currentPrice = (await firstSpotPromise) ?? pricing?.last ?? pricing?.previousClose ?? dailyBars[dailyBars.length - 1]?.close ?? null;
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

    // Each task above resolves as soon as its section's *initial* paint is
    // ready — that's what makes the modal open fast. But the whole point of
    // streaming is that the connection (and the background push intervals
    // the pooled overview/spot subscriptions) must stay alive
    // past that point. So this function itself doesn't return — and the
    // `finally` below doesn't disconnect from IBKR — until `signal` aborts,
    // which the route does the moment the SSE client actually disconnects.
    await Promise.all([overviewReadyTask, chartTask, technicalsTask]);
    void spotTask; // settles when `signal` aborts, alongside the wait below
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    connection.disconnect();
  }
}
