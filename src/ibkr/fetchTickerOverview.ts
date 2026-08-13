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
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ChartRange = "1M" | "3M" | "6M" | "1Y" | "All";

// EOD/daily-check-in platform, not an intraday trading tool — every range
// uses daily bars, no minute/hourly granularity.
const rangeToDuration: Record<ChartRange, string> = {
  "1M": "1 M",
  "3M": "3 M",
  "6M": "6 M",
  "1Y": "1 Y",
  All: "10 Y",
};

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
    const timer = setTimeout(() => reject(new Error(`Historical data timeout for ${symbol}`)), 15_000);

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
      bars.push({
        date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    ib.on(EventName.historicalData, onHistoricalData);
    ib.reqHistoricalData(
      reqId,
      new Stock(symbol, "SMART", "USD"),
      "",
      rangeToDuration[range],
      BarSizeSetting.DAYS_ONE,
      WhatToShow.TRADES,
      1,
      1,
      false,
    );
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
