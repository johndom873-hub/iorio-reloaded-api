import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { formatExpiryAsIsoDate } from "./optionChainSnapshotStore.js";
import { isOptionPastExpiry } from "./optionExpiryClock.js";

// IBKR's portfolio mark exists only for an option that still has value at expiry; one that expires worthless comes
// back with no positive mark. For the nightly snapshot that is a real price of 0, but only when the expiry-day close
// proves it: out of the money (the same test as expirySettlementAudit.ts, where close at the strike counts as worthless).
// In the money, or no bar yet, stays "no price" so the position is skipped and alerted, never silently zeroed.

export interface ExpiredOptionCandidateLeg {
  legId: string;
  symbol: string;
  optionType: "call" | "put";
  strike: number;
  expiryYyyymmdd: string;
}

export function worthlessPriceForExpiredOption(input: {
  optionType: "call" | "put";
  strike: number;
  expiryClose: number | null;
  expiryIsoDate: string;
  now: Date;
}): 0 | null {
  if (!isOptionPastExpiry(input.expiryIsoDate, input.now)) return null;
  if (input.expiryClose === null) return null;
  const distanceInTheMoney = input.optionType === "call" ? input.expiryClose - input.strike : input.strike - input.expiryClose;
  return distanceInTheMoney <= 0 ? 0 : null;
}

function expiryCloseKey(symbol: string, expiryIsoDate: string): string {
  return `${symbol}|${expiryIsoDate}`;
}

async function loadExpiryDayCloses(legs: ExpiredOptionCandidateLeg[], database: Knex): Promise<Map<string, number>> {
  const symbols = [...new Set(legs.map((leg) => leg.symbol))];
  const expiryIsoDates = [...new Set(legs.map((leg) => formatExpiryAsIsoDate(leg.expiryYyyymmdd)))];
  const result = await database.raw(
    `SELECT t.symbol, b.trading_date::text AS "tradingDate", b.close_price::float AS close
     FROM daily_price_bars b JOIN tickers t ON t.id = b.ticker_id
     WHERE t.symbol = ANY(?) AND b.trading_date = ANY(?::date[])`,
    [symbols, expiryIsoDates],
  );
  return new Map(result.rows.map((row: { symbol: string; tradingDate: string; close: number }) => [expiryCloseKey(row.symbol, row.tradingDate), row.close]));
}

/**
 * Returns the prices with a 0 filled in for every candidate leg that has no price, is past its expiry, and finished out
 * of the money. A price IBKR did return is never touched. `filledLegIds` lists the legs that got the 0.
 */
export async function fillWorthlessExpiredOptionPrices(
  candidateLegs: ExpiredOptionCandidateLeg[],
  pricesByLegId: Record<string, number | null>,
  now: Date = new Date(),
  database: Knex = db,
): Promise<{ pricesByLegId: Record<string, number | null>; filledLegIds: string[] }> {
  const unpricedExpiredLegs = candidateLegs.filter(
    (leg) => (pricesByLegId[leg.legId] ?? null) === null && isOptionPastExpiry(formatExpiryAsIsoDate(leg.expiryYyyymmdd), now),
  );
  if (unpricedExpiredLegs.length === 0) return { pricesByLegId, filledLegIds: [] };

  const expiryDayCloses = await loadExpiryDayCloses(unpricedExpiredLegs, database);
  const filledPrices = { ...pricesByLegId };
  const filledLegIds: string[] = [];
  for (const leg of unpricedExpiredLegs) {
    const expiryIsoDate = formatExpiryAsIsoDate(leg.expiryYyyymmdd);
    const worthlessPrice = worthlessPriceForExpiredOption({
      optionType: leg.optionType,
      strike: leg.strike,
      expiryClose: expiryDayCloses.get(expiryCloseKey(leg.symbol, expiryIsoDate)) ?? null,
      expiryIsoDate,
      now,
    });
    if (worthlessPrice === null) continue;
    filledPrices[leg.legId] = worthlessPrice;
    filledLegIds.push(leg.legId);
  }
  return { pricesByLegId: filledPrices, filledLegIds };
}
