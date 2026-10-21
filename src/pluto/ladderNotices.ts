import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { recordPlutoEvent } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";

// The CC + Put Ladder's Telegram notices (Marcelo 2026-10-21): at most one a day per ticker and reason, and one a day per
// book-wide limit, so a look every few minutes does not repeat them. Each one sent is a "warning" in Pluto's event log
// with its key (payload.ladderNotice); a notice whose key is already in today's log (Eastern date) is not sent again, so a
// restart does not resend it. The texts carry no figures; the look's notes and the event log hold the details.

export type LadderTickerNoticeReason = "no_previous_session_volume" | "no_shock" | "stale_band_quotes" | "split_guard" | "held_by_ticker_cap" | "blocked_on_live_check";
export type LadderBookNoticeReason = "book_committed_capital" | "book_open_positions" | "book_orders_per_day";

const tickerNoticeTexts: Record<LadderTickerNoticeReason, (symbol: string) => string> = {
  no_previous_session_volume: (symbol) => `${symbol} can't trade today: no previous-session option volume was captured, so no sale passes the volume rule.`,
  no_shock: (symbol) => `${symbol} can't trade: it has no shock (no override, and no daily closes for a recommended one).`,
  stale_band_quotes: (symbol) => `${symbol} can't trade for now: the ladder band's latest quotes are older than Pluto's quote-age limit.`,
  split_guard: (symbol) => `${symbol} is stopped: its price is about a split's factor away from the previous close with no split recorded. A person needs to look.`,
  held_by_ticker_cap: (symbol) => `${symbol}: sales wait for a later look, held by the ticker's caps (working orders, orders a day or open positions).`,
  blocked_on_live_check: (symbol) => `${symbol}: a sale was blocked on its live re-check (quote, spread, expiry, yield or delta); it is planned again at a later look.`,
};

const bookNoticeTexts: Record<LadderBookNoticeReason, string> = {
  book_committed_capital: "Sales wait: the ladder's tickers together have reached Pluto's capital budget.",
  book_open_positions: "Sales wait: the ladder's open positions and working orders have reached the book's cap.",
  book_orders_per_day: "Sales wait: the ladder has sent the book's orders for the day.",
};

export interface LadderNoticeDependencies {
  /** Whether a notice with this key is in today's event log (Eastern date). */
  sentToday(key: string, todayIso: string): Promise<boolean>;
  record(key: string, symbol: string | null, message: string): Promise<void>;
  send(text: string): Promise<void>;
}

export const defaultLadderNoticeDependencies: LadderNoticeDependencies = {
  async sentToday(key, todayIso) {
    const row = await db("pluto_events").where({ type: "warning" }).whereRaw("payload->>'ladderNotice' = ?", [key]).whereRaw("(occurred_at at time zone 'America/New_York')::date = ?::date", [todayIso]).first("id");
    return Boolean(row);
  },
  async record(key, symbol, message) {
    await recordPlutoEvent("warning", { ladderNotice: key, ...(symbol ? { symbol } : {}), message });
  },
  async send(text) {
    await notifyPlutoTelegram(text);
  },
};

async function noticeOncePerDay(key: string, symbol: string | null, message: string, settings: Pick<PlutoSettings, "telegramVerbosity">, now: Date, dependencies: LadderNoticeDependencies): Promise<boolean> {
  if (await dependencies.sentToday(key, easternIsoDate(now))) return false;
  await dependencies.record(key, symbol, message);
  if (settings.telegramVerbosity !== "off") await dependencies.send(`⚠️ Pluto (CC + Put Ladder): ${message}`);
  return true;
}

/** The ticker's notice for `reason`, unless one went out today. True when it was recorded now. */
export function noticeLadderTicker(symbol: string, reason: LadderTickerNoticeReason, settings: Pick<PlutoSettings, "telegramVerbosity">, now: Date, dependencies: LadderNoticeDependencies = defaultLadderNoticeDependencies): Promise<boolean> {
  return noticeOncePerDay(`${reason}:${symbol}`, symbol, tickerNoticeTexts[reason](symbol), settings, now, dependencies);
}

/** The book-wide limit's notice, unless one went out today. True when it was recorded now. */
export function noticeLadderBook(reason: LadderBookNoticeReason, settings: Pick<PlutoSettings, "telegramVerbosity">, now: Date, dependencies: LadderNoticeDependencies = defaultLadderNoticeDependencies): Promise<boolean> {
  return noticeOncePerDay(reason, null, bookNoticeTexts[reason], settings, now, dependencies);
}
