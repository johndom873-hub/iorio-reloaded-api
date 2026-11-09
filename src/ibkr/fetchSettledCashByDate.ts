import { EventName, type IBApi } from "@stoqey/ib";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// The live account's settled cash (Marcelo 2026-11-09). IBKR's account summary sends no SettledCash tag on the live cash
// account (probed 2026-11-09); its account updates send SettledCashByDate, the settled cash IBKR projects for each
// settlement date, e.g. "20261108:1927.12;20261109:216.5;20261110:1050216.5". A stock or option trade placed today
// settles the next business day (T+1), so today's purchases are paid from the cash settled on that day: the entry for
// the next business day, else the latest one before it. Example: on Mon 9 Nov the entries above give $1,050,216.50
// (10 Nov), the deposit that settles on the 10th included; on Mon 9 Nov with only "20261109:216.5" sent, $216.50.

export interface SettledCashOnDate {
  dateIso: string;
  amount: number;
}

/** Pure: IBKR's SettledCashByDate value as dated amounts; unreadable parts are skipped. */
export function parseSettledCashByDate(value: string): SettledCashOnDate[] {
  const entries: SettledCashOnDate[] = [];
  for (const part of value.split(";")) {
    const match = /^\s*(\d{4})(\d{2})(\d{2})\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!match) continue;
    entries.push({ dateIso: `${match[1]}-${match[2]}-${match[3]}`, amount: Number(match[4]) });
  }
  return entries.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

/** Pure: the weekday after `dateIso` (Friday → Monday). Holidays are not skipped: IBKR's own dates decide (see below). */
export function nextWeekdayIso(dateIso: string): string {
  const day = new Date(`${dateIso}T12:00:00Z`);
  do day.setUTCDate(day.getUTCDate() + 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** Pure: the settled cash for trades placed on `todayIso`: the latest entry dated on or before the next weekday; null if none. */
export function settledCashForTradesPlacedOn(entries: SettledCashOnDate[], todayIso: string): number | null {
  const settlementIso = nextWeekdayIso(todayIso);
  let chosen: SettledCashOnDate | null = null;
  for (const entry of entries) if (entry.dateIso <= settlementIso && (chosen === null || entry.dateIso >= chosen.dateIso)) chosen = entry;
  return chosen === null ? null : chosen.amount;
}

// One account-updates subscription per connection at a time (IBKR's reqAccountUpdates has no request id), so calls on a
// shared connection wait for each other.
const queueByConnection = new WeakMap<IBApi, Promise<unknown>>();

/** IBKR's USD SettledCashByDate, read once from the account updates; null when IBKR sends none. */
export function requestSettledCashByDate(ib: IBApi): Promise<SettledCashOnDate[] | null> {
  const previous = queueByConnection.get(ib) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => readSettledCashByDateOnce(ib));
  queueByConnection.set(ib, next);
  return next;
}

function readSettledCashByDateOnce(ib: IBApi): Promise<SettledCashOnDate[] | null> {
  return new Promise<SettledCashOnDate[] | null>((resolve, reject) => {
    let accountName: string | null = null;
    let entries: SettledCashOnDate[] | null = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Settled cash by date timeout."));
    }, 15_000);

    function onUpdateAccountValue(key: string, value: string, currency: string, account: string) {
      accountName = account;
      if (key === "SettledCashByDate" && currency === "USD") entries = parseSettledCashByDate(value);
    }

    function onAccountDownloadEnd() {
      cleanup();
      resolve(entries);
    }

    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.updateAccountValue, onUpdateAccountValue);
      ib.off(EventName.accountDownloadEnd, onAccountDownloadEnd);
      if (accountName) ib.reqAccountUpdates(false, accountName);
    }

    ib.on(EventName.updateAccountValue, onUpdateAccountValue);
    ib.on(EventName.accountDownloadEnd, onAccountDownloadEnd);
    ib.reqAccountUpdates(true, "");
  });
}

/** How long one read of the account updates is reused: the Dashboard, Pulse and Pluto read the summary often. */
export const settledCashByDateReuseMilliseconds = 10_000;
const latestReadByConnection = new WeakMap<IBApi, { at: number; entries: SettledCashOnDate[] | null }>();

/** The settled cash for today's trades on `ib`'s account (New York date), null when IBKR sends no dated settled cash. */
export async function fetchSettledCashForTodaysTrades(ib: IBApi, now: Date = new Date()): Promise<number | null> {
  const latest = latestReadByConnection.get(ib);
  let entries: SettledCashOnDate[] | null;
  if (latest && now.getTime() - latest.at < settledCashByDateReuseMilliseconds) entries = latest.entries;
  else {
    entries = await requestSettledCashByDate(ib);
    latestReadByConnection.set(ib, { at: Date.now(), entries });
  }
  return entries === null ? null : settledCashForTradesPlacedOn(entries, easternIsoDate(now));
}
