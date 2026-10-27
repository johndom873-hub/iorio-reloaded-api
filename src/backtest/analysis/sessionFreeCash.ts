import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { easternInstant, easternIsoDate } from "../../lib/easternIsoDate.js";
import { addCalendarDays } from "../../lib/calendarDays.js";

// A session's free cash at any moment, rebuilt from what it recorded (Marcelo 2026-10-21, the Wheel cycles' Cash):
//
//   free cash  = max(0, cash − cash locked in the open Cash-Secured Puts)       (the engine's ledgerFreeCash)
//   cash       = the day's cash at its 10:00 marks (before its orders) + the day's fills up to the moment (sales in,
//                purchases and buybacks out, commissions out) + the strike of calls assigned up to it (they have no fill)
//   locked     = Σ strike × 100 × contracts of the CSP puts open at the moment
//   Cash %     = free cash ÷ the account value at the day's 10:00 marks (the whole account: a session's symbols share it)
//
// Interest lands at the next day's marks. Rebuilt this way, every day's cash plus its fills and assignments plus the next
// day's interest gave the next day's recorded cash to the cent on three sessions (3,418 days, 2026-10-21).
// Example: $90,000 cash at the 10:00 marks of a $150,000 account; a $40 Put sold at 10:00 for 1.00 (0.65 commission)
// and a $45 Put already open: cash 90,099.35, locked 4,000 + 4,500, free 81,599.35, Cash % 54.4%.

interface DayMark {
  cash: number;
  accountValue: number;
}

export interface SessionFreeCash {
  /** Cash % once everything up to `atIso` on the day was done (null `atIso`: the day's end); null for a day not recorded. */
  shareAfter(tradingDate: string, atIso: string | null): number | null;
  /** Cash % at the day's 10:00 marks, before its orders; null for a day not recorded. */
  shareAtMark(tradingDate: string): number | null;
  /** The dollars behind it at the day's 10:00 marks; null for a day not recorded. */
  atMark(tradingDate: string): { freeCash: number; locked: number; accountValue: number } | null;
  /**
   * The same just before the day's close: after every order of the day, before its expiries settle (stamped 16:00 Eastern),
   * so a Put expiring that day still locks its cash; over the account value at the day's marks. Null for a day not recorded.
   */
  beforeClose(tradingDate: string): { freeCash: number; locked: number; accountValue: number } | null;
  /**
   * The lowest Cash % from `fromDate` to `toDate`: at each recorded day's marks and after each of `moments` (Marcelo
   * 2026-10-21, a closed cycle's Cash); null when none was recorded. Ties keep the first.
   */
  lowestShareBetween(fromDate: string, toDate: string, moments: readonly { tradingDate: string; at: string }[]): { share: number; on: string } | null;
}

/**
 * Each recorded day of a session just before its close: [date, free cash, cash locked in open puts, account value at the
 * day's marks] (the price chart's Cash available, Marcelo 2026-10-27: whether the cash was used through the session, not
 * the moment before the first look spends what an expiry freed).
 */
export type CashAvailableByDay = [string, number, number, number][];

export async function loadCashAvailableByDay(sessionId: string, connection: Knex = db): Promise<CashAvailableByDay> {
  const span: { first: string | null; last: string | null } | undefined = await connection("backtest_session_days").where({ session_id: sessionId }).first(connection.raw("min(trading_date)::text as first"), connection.raw("max(trading_date)::text as last"));
  if (!span?.first || !span.last) return [];
  const freeCash = await loadSessionFreeCash(sessionId, span.first, span.last, connection);
  const days: { date: string }[] = await connection("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(connection.raw("trading_date::text as date"));
  const cents = (value: number) => Math.round(value * 100) / 100;
  return days.flatMap(({ date }) => {
    const close = freeCash.beforeClose(date);
    return close ? [[date, cents(close.freeCash), cents(close.locked), cents(close.accountValue)] as CashAvailableByDay[number]] : [];
  });
}

export async function loadSessionFreeCash(sessionId: string, fromDate: string, toDate: string, connection: Knex = db): Promise<SessionFreeCash> {
  const rangeStart = easternInstant(fromDate, 0, 0);
  const rangeEnd = easternInstant(addCalendarDays(toDate, 1), 0, 0);
  const [days, fills, callAssignments, lockedPuts]: [
    { date: string; cash: string; account_value: string }[],
    { date: string; executed_at: Date; flow: string }[],
    { exit_at: Date; proceeds: string }[],
    { entry_at: Date; exit_at: Date | null; locked: string }[],
  ] = await Promise.all([
    connection("backtest_session_days").where({ session_id: sessionId }).whereBetween("trading_date", [fromDate, toDate]).select(connection.raw("trading_date::text as date"), "cash", "account_value"),
    connection("backtest_fills")
      .where({ session_id: sessionId })
      .whereBetween("trading_date", [fromDate, toDate])
      .select(connection.raw("trading_date::text as date"), "executed_at", connection.raw("(case when side = 'sell' then 1 else -1 end) * price * quantity * multiplier - commission_dollars as flow")),
    connection("backtest_position_legs")
      .where({ session_id: sessionId, leg_type: "option", option_type: "call", side: "short", settled_as: "assigned" })
      .where("exit_at", ">=", rangeStart)
      .where("exit_at", "<", rangeEnd)
      .select("exit_at", connection.raw("strike_price * quantity * multiplier as proceeds")),
    connection("backtest_position_legs as l")
      .join("backtest_positions as p", (join) => join.on("p.session_id", "l.session_id").andOn("p.position_id", "l.position_id"))
      .where({ "l.session_id": sessionId, "l.leg_type": "option", "l.option_type": "put", "l.side": "short", "p.strategy_key": "cash_secured_put" })
      .where("l.entry_at", "<", rangeEnd)
      .where((query) => query.whereNull("l.exit_at").orWhere("l.exit_at", ">", rangeStart))
      .select("l.entry_at", "l.exit_at", connection.raw("l.strike_price * l.quantity * l.multiplier as locked")),
  ]);
  const markByDate = new Map<string, DayMark>(days.map((day) => [day.date, { cash: Number(day.cash), accountValue: Number(day.account_value) }]));
  const flowsByDate = new Map<string, { atMs: number; dollars: number }[]>();
  const addFlow = (date: string, at: Date, dollars: number) => {
    const flows = flowsByDate.get(date);
    const flow = { atMs: new Date(at).getTime(), dollars };
    if (flows) flows.push(flow);
    else flowsByDate.set(date, [flow]);
  };
  for (const fill of fills) addFlow(fill.date, fill.executed_at, Number(fill.flow));
  for (const assignment of callAssignments) addFlow(easternIsoDate(new Date(assignment.exit_at)), assignment.exit_at, Number(assignment.proceeds));
  const puts = lockedPuts.map((put) => ({ entryMs: new Date(put.entry_at).getTime(), exitMs: put.exit_at === null ? Number.POSITIVE_INFINITY : new Date(put.exit_at).getTime(), locked: Number(put.locked) }));
  // The marks come before the day's orders: a put sold at the first look is not open yet, one bought back then still is.
  const lockedAtMark = (tradingDate: string) => {
    const markMs = easternInstant(tradingDate, 10, 0).getTime();
    return puts.reduce((sum, put) => sum + (put.entryMs < markMs && put.exitMs >= markMs ? put.locked : 0), 0);
  };
  const share = (mark: DayMark, cash: number, locked: number) => (mark.accountValue > 0 ? Math.max(0, cash - locked) / mark.accountValue : null);
  const shareAfter: SessionFreeCash["shareAfter"] = (tradingDate, atIso) => {
    const mark = markByDate.get(tradingDate);
    if (!mark) return null;
    const atMs = atIso === null ? easternInstant(addCalendarDays(tradingDate, 1), 0, 0).getTime() - 1 : new Date(atIso).getTime();
    const cash = mark.cash + (flowsByDate.get(tradingDate) ?? []).reduce((sum, flow) => sum + (flow.atMs <= atMs ? flow.dollars : 0), 0);
    const locked = puts.reduce((sum, put) => sum + (put.entryMs <= atMs && put.exitMs > atMs ? put.locked : 0), 0);
    return share(mark, cash, locked);
  };
  const shareAtMark: SessionFreeCash["shareAtMark"] = (tradingDate) => {
    const mark = markByDate.get(tradingDate);
    return mark ? share(mark, mark.cash, lockedAtMark(tradingDate)) : null;
  };
  return {
    shareAfter,
    shareAtMark,
    lowestShareBetween(fromDate, toDate, moments) {
      let lowest: { share: number; on: string } | null = null;
      const consider = (value: number | null, on: string) => {
        if (value !== null && (lowest === null || value < lowest.share || (value === lowest.share && on < lowest.on))) lowest = { share: value, on };
      };
      for (const date of markByDate.keys()) if (date >= fromDate && date <= toDate) consider(shareAtMark(date), date);
      for (const moment of moments) if (moment.tradingDate >= fromDate && moment.tradingDate <= toDate) consider(shareAfter(moment.tradingDate, moment.at), moment.tradingDate);
      return lowest;
    },
    beforeClose(tradingDate) {
      const mark = markByDate.get(tradingDate);
      if (!mark) return null;
      const atMs = easternInstant(tradingDate, 16, 0).getTime() - 1;
      const cash = mark.cash + (flowsByDate.get(tradingDate) ?? []).reduce((sum, flow) => sum + (flow.atMs <= atMs ? flow.dollars : 0), 0);
      const locked = puts.reduce((sum, put) => sum + (put.entryMs <= atMs && put.exitMs > atMs ? put.locked : 0), 0);
      return { freeCash: Math.max(0, cash - locked), locked, accountValue: mark.accountValue };
    },
    atMark(tradingDate) {
      const mark = markByDate.get(tradingDate);
      if (!mark) return null;
      const locked = lockedAtMark(tradingDate);
      return { freeCash: Math.max(0, mark.cash - locked), locked, accountValue: mark.accountValue };
    },
  };
}
