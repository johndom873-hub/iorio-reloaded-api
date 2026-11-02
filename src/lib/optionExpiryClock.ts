import { easternIsoDate } from "./easternIsoDate.js";

// An option expires at the 16:00 America/New_York close of its expiry date (approved 2026-10-02). Before that
// it is still tradable, so a contract missing from IBKR's report with no closing trade is not yet an expiry.
export const optionExpiryCloseHourEastern = 16;

const easternHourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** Whether the expiry date's close (16:00 Eastern) has passed at `now`. */
export function isOptionPastExpiry(expiryIsoDate: string, now: Date = new Date()): boolean {
  const today = easternIsoDate(now);
  if (expiryIsoDate !== today) return expiryIsoDate < today;
  return Number(easternHourFormatter.format(now)) >= optionExpiryCloseHourEastern;
}

/**
 * The same rule as a SQL boolean over a date column, at the database's now() or at `instantSql` (a timestamptz
 * expression such as "?::timestamptz", for a caller that passes its own clock).
 */
export function optionPastExpirySql(expiryDateColumn: string, instantSql = "now()"): string {
  return `(${expiryDateColumn} + interval '${optionExpiryCloseHourEastern} hours') <= (${instantSql} AT TIME ZONE 'America/New_York')`;
}
