import { BarSizeSetting, EventName, MarketDataType, Stock, WhatToShow } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface TickerPricing {
  last: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
}

export interface PriceBar {
  time: number; // Unix epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ChartRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "All";

// Matches menaris-admin-app's per-range bar granularity (services/chart-service.js
// RANGE_CONFIG), verified against real IBKR data (tmp/test-intraday-bars.ts,
// tmp/test-remaining-bars.ts) rather than assumed — every combo below returned
// hundreds of real bars.
const rangeConfig: Record<ChartRange, { barSize: BarSizeSetting; duration: string }> = {
  "1D": { barSize: BarSizeSetting.MINUTES_ONE, duration: "2 D" },
  "5D": { barSize: BarSizeSetting.MINUTES_FIVE, duration: "7 D" },
  "1M": { barSize: BarSizeSetting.MINUTES_THIRTY, duration: "1 M" },
  "3M": { barSize: BarSizeSetting.HOURS_ONE, duration: "3 M" },
  "6M": { barSize: BarSizeSetting.HOURS_TWO, duration: "6 M" },
  "1Y": { barSize: BarSizeSetting.DAYS_ONE, duration: "1 Y" },
  "5Y": { barSize: BarSizeSetting.WEEKS_ONE, duration: "5 Y" },
  All: { barSize: BarSizeSetting.WEEKS_ONE, duration: "20 Y" },
};

// IBKR's historicalData date field is only a Unix-epoch-seconds string (with
// formatDate=2) for bars smaller than 1 day — daily/weekly bars always come
// back as a plain YYYYMMDD string regardless of formatDate. Verified
// empirically (tmp/test-bar-date-format.ts), not assumed from docs.
function parseIbkrBarTime(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d{8}$/.test(trimmed)) {
    const iso = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T00:00:00Z`;
    return Math.floor(new Date(iso).getTime() / 1000);
  }
  return Number(trimmed);
}

type IbkrConnection = Awaited<ReturnType<typeof connectToIbkrGateway>>;

/** Shares an already-open connection — see fetchTickerDetail.ts. */
export async function lookupPricingSnapshot(
  connection: IbkrConnection,
  symbol: string,
  reqId = 1,
): Promise<TickerPricing> {
  const { ib } = connection;
  ib.reqMarketDataType(MarketDataType.DELAYED);

  return new Promise((resolve, reject) => {
    const pricing: TickerPricing = {
      last: null,
      bid: null,
      ask: null,
      open: null,
      high: null,
      low: null,
      previousClose: null,
      volume: null,
    };
    const timer = setTimeout(() => reject(new Error(`Pricing snapshot timeout for ${symbol}`)), 10_000);

    function onTickPrice(id: number, tickType: number, price: number) {
      if (id !== reqId || price < 0) return;
      // Delayed tick types: bid=66, ask=67, last=68, high=72, low=73, close=75, open=76.
      if (tickType === 66) pricing.bid = price;
      if (tickType === 67) pricing.ask = price;
      if (tickType === 68) pricing.last = price;
      if (tickType === 72) pricing.high = price;
      if (tickType === 73) pricing.low = price;
      if (tickType === 75) pricing.previousClose = price;
      if (tickType === 76) pricing.open = price;
    }
    function onTickSize(id: number, tickType?: number, size?: number) {
      if (id !== reqId || size === undefined) return;
      // Delayed volume = 74.
      if (tickType === 74) pricing.volume = size;
    }
    function onSnapshotEnd(id: number) {
      if (id !== reqId) return;
      clearTimeout(timer);
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.removeListener(EventName.tickSize, onTickSize);
      ib.removeListener(EventName.tickSnapshotEnd, onSnapshotEnd);
      resolve(pricing);
    }

    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.tickSize, onTickSize);
    ib.once(EventName.tickSnapshotEnd, onSnapshotEnd);
    ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "", true, false);
  });
}

/** Shares an already-open connection — see fetchTickerDetail.ts. */
export async function lookupHistoricalBars(
  connection: IbkrConnection,
  symbol: string,
  range: ChartRange,
  reqId = 1,
): Promise<PriceBar[]> {
  const { ib } = connection;
  ib.reqMarketDataType(MarketDataType.DELAYED);

  return new Promise((resolve, reject) => {
    const bars: PriceBar[] = [];
    const timer = setTimeout(() => reject(new Error(`Historical data timeout for ${symbol}`)), 20_000);

    function onHistoricalData(
      id: number,
      date: string,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ) {
      if (id !== reqId) return;
      if (date.startsWith("finished")) {
        clearTimeout(timer);
        ib.removeListener(EventName.historicalData, onHistoricalData);
        resolve(bars);
        return;
      }
      bars.push({ time: parseIbkrBarTime(date), open, high, low, close, volume });
    }

    const { barSize, duration } = rangeConfig[range];
    ib.on(EventName.historicalData, onHistoricalData);
    ib.reqHistoricalData(reqId, new Stock(symbol, "SMART", "USD"), "", duration, barSize, WhatToShow.TRADES, 1, 2, false);
  });
}

export async function fetchTickerPricing(symbol: string): Promise<TickerPricing> {
  const connection = await connectToIbkrGateway();
  try {
    return await lookupPricingSnapshot(connection, symbol);
  } finally {
    connection.disconnect();
  }
}

export async function fetchPriceBars(symbol: string, range: ChartRange): Promise<PriceBar[]> {
  const connection = await connectToIbkrGateway();
  try {
    return await lookupHistoricalBars(connection, symbol, range);
  } finally {
    connection.disconnect();
  }
}
