import { db } from "../db/connection.js";
import { accountContextFromTotalCash } from "./accountContext.js";
import { addCalendarDays } from "./calendarDays.js";
import { formatWholeDollars } from "./formatWholeDollars.js";
import { loadOpenDaysBetween } from "./marketSessionStatus.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { daysToExpiry, describeOptionContract, formatDayMonth } from "./optionContractLabel.js";

// LEAPS expiry warnings on Telegram (approved by Marcelo 2026-10-27), checked by the nightly P&L snapshot job after the
// close: once when a LEAPS is 30 calendar days or less from expiry, then on each of its last 5 trading days while it is
// in the money, because IBKR exercises an in-the-money Call at expiry and the account (cash, no margin) must then pay
// strike × shares. State is position_legs.leaps_expiry_warned_on.

export const leapsExpiryNoticeCalendarDays = 30;
export const leapsFinalWarningTradingDays = 5;

export interface HeldLeapsLeg {
  legId: string;
  tickerId: string;
  symbol: string;
  expiry: string; // ISO date
  strike: number;
  contracts: number;
  multiplier: number;
  /** Session date of the last warning sent, null before the first. */
  warnedOn: string | null;
}

export type LeapsExpiryWarning = { kind: "expiryNotice"; calendarDaysToExpiry: number } | { kind: "finalDays"; tradingDaysToExpiry: number };

export interface LeapsExpiryWarningInput {
  expiry: string;
  strike: number;
  warnedOn: string | null;
  /** The session the job runs after (YYYY-MM-DD). */
  sessionDateIso: string;
  /** Open sessions after `sessionDateIso` up to and including the expiry; null when the expiry is too far to count them. */
  tradingDaysToExpiry: number | null;
  /** The stock's latest close, null when none is stored. */
  stockClose: number | null;
}

/** Pure: the warning one LEAPS gets tonight, if any. The final-days warning wins when both apply. */
export function decideLeapsExpiryWarning(input: LeapsExpiryWarningInput): LeapsExpiryWarning | null {
  const calendarDaysToExpiry = daysToExpiry(input.expiry, input.sessionDateIso);
  if (calendarDaysToExpiry <= 0) return null;
  const tradingDaysToExpiry = input.tradingDaysToExpiry;
  const inTheMoney = input.stockClose !== null && input.stockClose > input.strike;
  if (tradingDaysToExpiry !== null && tradingDaysToExpiry >= 1 && tradingDaysToExpiry <= leapsFinalWarningTradingDays && inTheMoney && input.warnedOn !== input.sessionDateIso) {
    return { kind: "finalDays", tradingDaysToExpiry };
  }
  if (calendarDaysToExpiry <= leapsExpiryNoticeCalendarDays && input.warnedOn === null) return { kind: "expiryNotice", calendarDaysToExpiry };
  return null;
}

export interface LeapsExpiryMessageInput {
  leg: HeldLeapsLeg;
  warning: LeapsExpiryWarning;
  sessionDateIso: string;
  stockClose: number | null;
  /** Free cash now (final-days warning only); null leaves it out. */
  freeCash: number | null;
}

export function formatLeapsExpiryMessage({ leg, warning, sessionDateIso, stockClose, freeCash }: LeapsExpiryMessageInput): string {
  const contract = describeOptionContract({ symbol: leg.symbol, strike: leg.strike, right: "C", expiry: leg.expiry, dte: daysToExpiry(leg.expiry, sessionDateIso) });
  const contracts = `${leg.contracts} contract${leg.contracts === 1 ? "" : "s"}`;
  const shares = leg.contracts * leg.multiplier;
  const exercise = `${shares.toLocaleString("en-US")} shares at $${leg.strike.toFixed(2)}, ${formatWholeDollars(shares * leg.strike)} of cash`;
  const expiryDay = formatDayMonth(leg.expiry);
  const stockAt = stockClose === null ? null : `${leg.symbol} is at $${stockClose.toFixed(2)}.`;
  if (warning.kind === "finalDays") {
    const days = `${warning.tradingDaysToExpiry} trading day${warning.tradingDaysToExpiry === 1 ? "" : "s"}`;
    return [
      `LEAPS in the money, ${days} to expiry: ${contract}, ${contracts}.`,
      `${stockAt} At expiry IBKR exercises it: ${exercise}.${freeCash === null ? "" : ` Free cash now: ${formatWholeDollars(freeCash)}.`}`,
      `Sell it before the close on ${expiryDay}, or raise the cash.`,
    ].join("\n");
  }
  const moneyness = stockClose === null ? null : `${stockClose > leg.strike ? "In" : "Out of"} the money: ${stockAt}`;
  return [
    `LEAPS expiring in ${warning.calendarDaysToExpiry} days: ${contract}, ${contracts}.`,
    ...(moneyness ? [moneyness] : []),
    `If it is ${stockClose !== null && stockClose > leg.strike ? "still " : ""}in the money at the close on ${expiryDay}, IBKR exercises it: ${exercise}.`,
    "Sell it before then, or keep that cash free.",
  ].join("\n");
}

export async function loadHeldLeapsLegs(): Promise<HeldLeapsLeg[]> {
  const rows: { legId: string; tickerId: string; symbol: string; expiry: string; strike: string; contracts: string; multiplier: string; warnedOn: string | null }[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where({ "p.status": "open", "p.strategy_key": "leaps", "pl.leg_type": "option", "pl.side": "long", "pl.option_type": "call" })
    .whereNull("pl.exit_at")
    .select("pl.id as legId", "t.id as tickerId", "t.symbol", db.raw("pl.expiry_date::text as expiry"), "pl.strike_price as strike", "pl.quantity as contracts", "pl.multiplier", db.raw('pl.leaps_expiry_warned_on::text as "warnedOn"'))
    .orderBy(["t.symbol", "pl.expiry_date", "pl.strike_price"]);
  return rows.map((row) => ({ ...row, strike: Number(row.strike), contracts: Number(row.contracts), multiplier: Number(row.multiplier) }));
}

/** Each ticker's latest stored close on or before the session. */
async function loadLatestCloses(tickerIds: string[], sessionDateIso: string): Promise<Map<string, number>> {
  const rows: { tickerId: string; close: string }[] = await db("daily_price_bars")
    .distinctOn("ticker_id")
    .whereIn("ticker_id", tickerIds)
    .where("trading_date", "<=", sessionDateIso)
    .whereNotNull("close_price")
    .orderBy([{ column: "ticker_id" }, { column: "trading_date", order: "desc" }])
    .select("ticker_id as tickerId", "close_price as close");
  return new Map(rows.map((row) => [row.tickerId, Number(row.close)]));
}

export interface LeapsExpiryWarningsResult {
  sent: number;
  failed: string[];
}

/** Sends tonight's warnings. `totalCashValue` is the account summary the job already fetched (null: free cash left out). */
export async function sendLeapsExpiryWarnings(sessionDateIso: string, totalCashValue: number | null): Promise<LeapsExpiryWarningsResult> {
  const legs = (await loadHeldLeapsLegs()).filter((leg) => daysToExpiry(leg.expiry, sessionDateIso) <= leapsExpiryNoticeCalendarDays);
  if (legs.length === 0) return { sent: 0, failed: [] };
  const closes = await loadLatestCloses([...new Set(legs.map((leg) => leg.tickerId))], sessionDateIso);
  const firstDayAfterSession = addCalendarDays(sessionDateIso, 1);
  const decided = await Promise.all(
    legs.map(async (leg) => {
      const tradingDaysToExpiry = leg.expiry < firstDayAfterSession ? 0 : (await loadOpenDaysBetween(firstDayAfterSession, leg.expiry)).length;
      const stockClose = closes.get(leg.tickerId) ?? null;
      return { leg, stockClose, warning: decideLeapsExpiryWarning({ expiry: leg.expiry, strike: leg.strike, warnedOn: leg.warnedOn, sessionDateIso, tradingDaysToExpiry, stockClose }) };
    }),
  );
  const due = decided.filter((entry): entry is typeof entry & { warning: LeapsExpiryWarning } => entry.warning !== null);
  let freeCash: number | null = null;
  if (totalCashValue !== null && due.some((entry) => entry.warning.kind === "finalDays")) {
    try {
      freeCash = (await accountContextFromTotalCash(totalCashValue)).freeCash;
    } catch (error) {
      console.warn(`LEAPS expiry warnings: free cash left out, the cash held for Puts could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }
  const result: LeapsExpiryWarningsResult = { sent: 0, failed: [] };
  for (const { leg, stockClose, warning } of due) {
    const delivered = await notifyTelegram(formatLeapsExpiryMessage({ leg, warning, sessionDateIso, stockClose, freeCash }));
    if (!delivered) {
      result.failed.push(`${leg.symbol} ${leg.strike} Call ${leg.expiry}`);
      continue;
    }
    await db("position_legs").where({ id: leg.legId }).update({ leaps_expiry_warned_on: sessionDateIso });
    result.sent++;
  }
  return result;
}
