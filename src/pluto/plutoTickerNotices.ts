import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { recordPlutoEvent } from "./ledger.js";
import type { PlutoSettings } from "./settingsStore.js";

// Pluto's per-ticker Telegram notices (the CC + Put Ladder's, Marcelo 2026-10-21; Vol Farmer v4's since 2026-11-02): at
// most one a day per ticker and reason, so a round every few minutes does not repeat them. Each one sent is a "warning"
// in Pluto's event log with its key (payload.plutoNotice); a notice whose key is already in today's log (Eastern date) is
// not sent again, so a restart does not resend it. The texts carry no figures; the round's notes and the event log hold
// the details.

export type PlutoTickerNoticeReason = "split_guard";

const tickerNoticeTexts: Record<PlutoTickerNoticeReason, (symbol: string) => string> = {
  split_guard: (symbol) => `${symbol} is stopped: its price is about a split's factor away from the previous close with no split recorded. A person needs to look.`,
};

export interface PlutoNoticeDependencies {
  /** Whether a notice with this key is in today's event log (Eastern date). */
  sentToday(key: string, todayIso: string): Promise<boolean>;
  record(key: string, symbol: string, message: string): Promise<void>;
  send(text: string): Promise<void>;
}

export const defaultPlutoNoticeDependencies: PlutoNoticeDependencies = {
  async sentToday(key, todayIso) {
    const row = await db("pluto_events").where({ type: "warning" }).whereRaw("payload->>'plutoNotice' = ?", [key]).whereRaw("(occurred_at at time zone 'America/New_York')::date = ?::date", [todayIso]).first("id");
    return Boolean(row);
  },
  async record(key, symbol, message) {
    await recordPlutoEvent("warning", { plutoNotice: key, symbol, message });
  },
  async send(text) {
    await notifyPlutoTelegram(text);
  },
};

/** The ticker's notice for `reason`, unless one went out today. True when it was recorded now. */
export async function noticePlutoTicker(symbol: string, reason: PlutoTickerNoticeReason, settings: Pick<PlutoSettings, "telegramVerbosity">, now: Date, dependencies: PlutoNoticeDependencies = defaultPlutoNoticeDependencies): Promise<boolean> {
  const key = `${reason}:${symbol}`;
  if (await dependencies.sentToday(key, easternIsoDate(now))) return false;
  const message = tickerNoticeTexts[reason](symbol);
  await dependencies.record(key, symbol, message);
  if (settings.telegramVerbosity !== "off") await dependencies.send(`⚠️ Pluto: ${message}`);
  return true;
}
