import { EventName, Stock, type TickType } from "@stoqey/ib";
import { randomUUID } from "node:crypto";
import type { IbkrConnection } from "./connectIbkr.js";
import { describeMarketDataLineShortage, releaseMarketDataLines, reserveMarketDataLines } from "./marketDataLineBudget.js";

// IBKR's dividend outlook for one stock or ETF (generic tick 456, "IB Dividends"), for the LEAPS P&L-over-time valuation
// (approved by Marcelo 2026-10-27): the dividends IBKR expects over the next 12 months. It arrives as one text tick,
// "past 12 months total,next 12 months total,next date YYYYMMDD,next amount". Generic ticks only stream (a snapshot request
// is refused with error 321), so the stream is opened and cancelled once the tick arrives or the timeout fires.

/** Tick type 59, IB_DIVIDENDS: TickType is a type-only export, so the protocol value is mirrored here. */
const ibDividendsTick = 59;

export interface DividendOutlook {
  pastTwelveMonths: number | null;
  nextTwelveMonths: number | null;
  /** YYYY-MM-DD, or null when IBKR has none. */
  nextDate: string | null;
  nextAmount: number | null;
}

/** Pure: IBKR's "past,next,date,amount" text; a field that is empty or not a number is null. */
export function parseIbDividendsTick(value: string): DividendOutlook {
  const [past, next, date, amount] = value.split(",").map((part) => part.trim());
  const amountOf = (text: string | undefined) => (text === undefined || text === "" || !Number.isFinite(Number(text)) ? null : Number(text));
  const nextDate = date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null;
  return { pastTwelveMonths: amountOf(past), nextTwelveMonths: amountOf(next), nextDate, nextAmount: amountOf(amount) };
}

/** One market-data line for at most the timeout; null when IBKR sends no dividend tick in time. */
export async function fetchDividendOutlook(connection: IbkrConnection, reqId: number, symbol: string, timeoutMs: number): Promise<DividendOutlook | null> {
  const holder = `snapshot:dividends:${symbol}:${randomUUID()}`;
  const reservation = await reserveMarketDataLines(holder, 1, Math.ceil(timeoutMs / 1000) + 5);
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, `${symbol} dividends`, 1));
  try {
    return await fetchDividendOutlookUnbudgeted(connection, reqId, symbol, timeoutMs);
  } finally {
    releaseMarketDataLines(holder).catch((error) => console.warn(`Failed to release IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }
}

export function fetchDividendOutlookUnbudgeted(connection: IbkrConnection, reqId: number, symbol: string, timeoutMs: number): Promise<DividendOutlook | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outlook: DividendOutlook | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.tickString, onTick);
      connection.ib.cancelMktData(reqId);
      resolve(outlook);
    };
    const onTick = (tickReqId: number, field: TickType | undefined, value: string | undefined) => {
      if (tickReqId !== reqId || (field as unknown as number) !== ibDividendsTick || value === undefined) return;
      finish(parseIbDividendsTick(value));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    connection.ib.on(EventName.tickString, onTick);
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "456", false, false);
  });
}
