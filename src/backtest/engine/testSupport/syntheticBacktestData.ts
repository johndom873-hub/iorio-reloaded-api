import { DatabaseSync, type StatementSync } from "node:sqlite";
import { easternInstant } from "../../../lib/easternIsoDate.js";
import { blackScholesPriceOnForward, maximumSpreadFractionOfMid, yearsBetweenIsoDates } from "../../../lib/impliedVolatilitySurface.js";
import type { PlutoSettings } from "../../../pluto/settingsStore.js";
import { plutoLadderSettingsFixture, plutoVolFarmerV2SettingsFixture } from "../../../pluto/plutoSettingsFixture.js";
import type { BacktestSettings } from "../../backtestTypes.js";
import { fileIntradayBarMinutes, writeFileStockBars, type FileIntradayBar } from "../../backtestFileStockBars.js";
import type { StoredDailyBar } from "../backtestBarHistory.js";
import { computeParityStockPrice } from "../backtestBook.js";
import { BacktestSymbolFile, type SymbolFileQuote } from "../backtestSymbolFile.js";
import { dailySliceLookMinute, dayNumberOf, endOfDayColumns, intradayQuoteColumns, lookMinuteOf, openInterestColumns, packSlice, schemaFourSliceTablesSql, sliceColumn, sliceKey, sliceRowFlags, tenOClockLookMinute, tenOClockQuoteColumns, type SliceColumnKind, type SliceRow } from "../symbolFileSlices.js";

// Synthetic market data for the engine's tests: a seeded random-walk bar history, Black-Scholes option quotes at a flat
// implied volatility, settings shaped like the dev database's, a schema 4 symbol file and its IBKR bars.

/** Deterministic standard normal draws (LCG + Box-Muller), so a test's data is the same on every run. */
export function seededNormalGenerator(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** Weekdays from `fromIso` to `toIso` inclusive. */
export function weekdaysBetween(fromIso: string, toIso: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${fromIso}T12:00:00Z`); at <= Date.parse(`${toIso}T12:00:00Z`); at += 86_400_000) {
    const day = new Date(at);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

/** Daily bars on `dates` ending near `endPrice`, with the given annualized volatility (open = previous close, small high/low range). */
export function syntheticDailyBars(dates: string[], endPrice: number, annualizedVolatility: number, seed: number, impliedVolatility: number | null = null): StoredDailyBar[] {
  const normal = seededNormalGenerator(seed);
  const dailyVolatility = annualizedVolatility / Math.sqrt(252);
  const logReturns = dates.map(() => dailyVolatility * normal());
  const totalLogReturn = logReturns.reduce((sum, value) => sum + value, 0);
  let close = endPrice * Math.exp(-totalLogReturn);
  return dates.map((tradingDate, index) => {
    const open = close;
    close = open * Math.exp(logReturns[index]!);
    const high = Math.max(open, close) * (1 + dailyVolatility * 0.3);
    const low = Math.min(open, close) * (1 - dailyVolatility * 0.3);
    return { tradingDate, open, high, low, close, volume: 1_000_000, impliedVolatility };
  });
}

/** Two-sided quotes priced at a flat implied volatility on the forward S·e^(rT), bid/ask = price ∓ max($0.01, 2% of the price). */
export function syntheticOptionQuotes(todayIso: string, stockPrice: number, expiries: string[], impliedVolatility: number, riskFreeRate: number, strikeStep: number, strikesEachSide: number): SymbolFileQuote[] {
  const quotes: SymbolFileQuote[] = [];
  const atTheMoney = Math.round(stockPrice / strikeStep) * strikeStep;
  for (const expiry of expiries) {
    const years = yearsBetweenIsoDates(todayIso, expiry);
    for (let offset = -strikesEachSide; offset <= strikesEachSide; offset++) {
      const strike = Math.round((atTheMoney + offset * strikeStep) * 100) / 100;
      for (const right of ["C", "P"] as const) {
        const price = years > 0 ? blackScholesPriceOnForward(stockPrice * Math.exp(riskFreeRate * years), strike, years, riskFreeRate, impliedVolatility, right === "C") : Math.max(0, right === "C" ? stockPrice - strike : strike - stockPrice);
        const halfSpread = Math.max(0.01, price * 0.02);
        const bid = Math.round((price - halfSpread) * 100) / 100;
        const ask = Math.round((price + halfSpread) * 100) / 100;
        quotes.push({ expiry, strike, right, bid: bid > 0 ? bid : 0, ask: Math.max(ask, 0.01), bidSize: 10, askSize: 10 });
      }
    }
  }
  return quotes;
}

/** Pluto's settings as on the dev database (2026-10-12), the ladder-only fields kept since Signals was retired. */
export function fixturePlutoSettings(overrides: Partial<PlutoSettings> = {}): PlutoSettings {
  return {
    ...plutoLadderSettingsFixture,
  ...plutoVolFarmerV2SettingsFixture,
    capitalBudgetPct: 50,
    excessAllowancePct: 0,
    windowStartEt: "10:00",
    windowEndEt: "15:30",
    dailyLossBreakerPct: 5,
    maxQuoteAgeMinutes: 10,
    maxFillSlippagePct: 5,
    bandQuotePollSeconds: 1,
    burstLines: 10,
    burstSettleSeconds: 4,
    maxEnabledTickers: 15,
    crashLoopRestartsPerHour: 3,
    telegramVerbosity: "off",
    updatedAt: "2026-10-12T00:00:00.000Z",
    updatedByUserId: null,
    ...overrides,
  };
}

/** A session's settings: the dev values. */
export function fixtureBacktestSettings(plutoOverrides: Partial<PlutoSettings> = {}): BacktestSettings {
  return {
    pluto: fixturePlutoSettings(plutoOverrides),
    trading: {
      maxOrderPctOfPortfolio: 10,
      maxConcentrationPerTickerPct: 20,
      minCashReservePct: 5,
      deltaTargetMin: 0.1,
      deltaTargetMax: 0.5,
      recoveryDteMin: 1,
      recoveryDteMax: 14,
      commissionWarnSharePctOfPremium: 5,
      priceCheckMaxDeviationPct: 2,
      priceCheckMinToleranceDollars: 0.05,
      spreadCostChargedPct: 50,
      orderUnfilledCancelMinutes: 15,
    },
    kellyFraction: 0.25,
  };
}

export interface SyntheticSymbolFileDay {
  tradingDate: string;
  quotes: SymbolFileQuote[];
  /** End-of-day rows: volume per contract (closing NBBO = the 10:00 quote). */
  endOfDayVolume: number;
  openInterest: number;
  /** The day is stored complete with no end-of-day rows (the downloader could not retrieve that part). */
  withoutEndOfDay?: boolean;
  /** The quotes at the looks after 10:00, by look time ("HH:MM"): the day then has intraday quotes, its 10:00 look being `quotes` unless given. */
  intradayQuotes?: Record<string, SymbolFileQuote[]>;
  /** The closing quotes, when they differ from the 10:00 ones. */
  closingQuotes?: SymbolFileQuote[];
}

/** What the downloader records of the data it could not retrieve. */
export interface SyntheticSymbolFileQuality {
  dayIssues?: { tradingDate: string; part: "quotes" | "eod" | "open_interest" | "intraday_quotes"; expiry: string | null; message: string }[];
  unavailableDays?: { tradingDate: string; reason: string }[];
  /** "4" unless given: any other makes a file the engine refuses. */
  schemaVersion?: string;
}

/** A day's contracts at one look as slices, one per expiry in date order, each in strike order (the Call before the Put): key, Calls, Puts, the flag, the bytes. */
export function contractSlicesOf(tradingDate: string, lookMinute: number, contracts: readonly { expiry: string; row: SliceRow }[], kinds: readonly SliceColumnKind[], flag: { column: number; kind: "askAboveZero" | "volume" }): [number, number, number, number, Uint8Array][] {
  const dayNumber = dayNumberOf(tradingDate);
  const rowsByExpiry = new Map<string, SliceRow[]>();
  for (const { expiry, row } of contracts) {
    const rows = rowsByExpiry.get(expiry);
    if (rows) rows.push(row);
    else rowsByExpiry.set(expiry, [row]);
  }
  return [...rowsByExpiry.entries()]
    .sort(([first], [second]) => (first < second ? -1 : 1))
    .map(([expiry, rows]) => {
      const daysToExpiry = dayNumberOf(expiry) - dayNumber;
      if (daysToExpiry < 0 || daysToExpiry > 65_535) throw new Error(`${tradingDate}: expiry ${expiry} cannot be stored`);
      rows.sort((first, second) => (first[sliceColumn.strike] as number) - (second[sliceColumn.strike] as number) || (first[sliceColumn.right] === second[sliceColumn.right] ? 0 : first[sliceColumn.right] === "C" ? -1 : 1));
      rows.forEach((row, index) => {
        if (index > 0 && row[sliceColumn.strike] === rows[index - 1]![sliceColumn.strike] && row[sliceColumn.right] === rows[index - 1]![sliceColumn.right]) throw new Error(`${tradingDate}: the ${expiry} ${String(row[sliceColumn.strike])} ${String(row[sliceColumn.right])} is given twice`);
      });
      const flags = sliceRowFlags(rows, flag.column, flag.kind);
      return [sliceKey(dayNumber, lookMinute, daysToExpiry), flags.callCount, flags.putCount, flags.flagged ? 1 : 0, packSlice(rows, kinds)];
    });
}

/**
 * Writes a symbol file (docs/backtesting/DATA-FILES.md) as the downloader leaves it, schema version 4: every table it
 * creates, each day's 10:00 quotes (taken 2 seconds before 10:00), end of day and open interest as slices, the
 * intraday quotes of the days that have them, and what `quality` records.
 */
export function writeSyntheticSymbolFile(filePath: string, symbol: string, days: SyntheticSymbolFileDay[], noDataDates: string[] = [], quality: SyntheticSymbolFileQuality | null = null): void {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE days (trading_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')), quote_rows INTEGER NOT NULL, eod_rows INTEGER NOT NULL, open_interest_rows INTEGER NOT NULL, fetched_at TEXT NOT NULL, all_expiries INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE intraday_days (trading_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('complete', 'no_data')), look_count INTEGER NOT NULL, quote_rows INTEGER NOT NULL, strike_window_pct REAL, fetched_at TEXT NOT NULL, all_expiries INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE day_issues (trading_date TEXT NOT NULL, part TEXT NOT NULL CHECK (part IN ('quotes', 'eod', 'open_interest', 'intraday_quotes')), expiry TEXT, message TEXT NOT NULL, recorded_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE unavailable_days (trading_date TEXT PRIMARY KEY, reason TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt_at TEXT NOT NULL);
      ${schemaFourSliceTablesSql}
    `);
    const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    const meta: [string, string][] = [["symbol", symbol], ["schema_version", quality?.schemaVersion ?? "4"], ["quote_time_et", "10:00:00"], ["max_dte", "45"], ["created_at", "2026-10-12T00:00:00Z"]];
    for (const [key, value] of meta) insertMeta.run(key, value);
    const insertDay = database.prepare("INSERT INTO days VALUES (?, ?, ?, ?, ?, '2026-10-12T00:00:00Z', 1)");
    const insertIntradayDay = database.prepare("INSERT INTO intraday_days VALUES (?, 'complete', ?, ?, NULL, '2026-10-12T00:00:00Z', 1)");
    const insertTenOClockSlice = database.prepare("INSERT INTO ten_oclock_quote_slices (key, call_count, put_count, has_ask_above_zero, data) VALUES (?, ?, ?, ?, ?)");
    const insertIntradaySlice = database.prepare("INSERT INTO intraday_quote_slices (key, call_count, put_count, data) VALUES (?, ?, ?, ?)");
    const insertEndOfDaySlice = database.prepare("INSERT INTO end_of_day_slices (key, call_count, put_count, has_volume, data) VALUES (?, ?, ?, ?, ?)");
    const insertOpenInterestSlice = database.prepare("INSERT INTO open_interest_slices (key, call_count, put_count, data) VALUES (?, ?, ?, ?)");
    const insertAll = (insert: StatementSync, withFlag: boolean, slices: [number, number, number, number, Uint8Array][]) => {
      for (const [key, calls, puts, flagged, data] of slices) {
        if (withFlag) insert.run(key, calls, puts, flagged, data);
        else insert.run(key, calls, puts, data);
      }
    };
    const askAboveZero = { column: sliceColumn.ask, kind: "askAboveZero" } as const;
    for (const day of days) {
      const closingQuotes = day.closingQuotes ?? day.quotes;
      insertDay.run(day.tradingDate, "complete", day.quotes.length, day.withoutEndOfDay ? 0 : closingQuotes.length, day.quotes.length);
      insertAll(insertTenOClockSlice, true, contractSlicesOf(day.tradingDate, tenOClockLookMinute, day.quotes.map((quote) => ({ expiry: quote.expiry, row: [quote.strike, quote.right, quote.bid, quote.ask, quote.bidSize, quote.askSize, 2_000] })), tenOClockQuoteColumns, askAboveZero));
      if (!day.withoutEndOfDay) insertAll(insertEndOfDaySlice, true, contractSlicesOf(day.tradingDate, dailySliceLookMinute, closingQuotes.map((quote) => ({ expiry: quote.expiry, row: [quote.strike, quote.right, quote.bid === null || quote.ask === null ? null : (quote.bid + quote.ask) / 2, day.endOfDayVolume, quote.bid, quote.ask] })), endOfDayColumns, { column: sliceColumn.volume, kind: "volume" }));
      insertAll(insertOpenInterestSlice, false, contractSlicesOf(day.tradingDate, dailySliceLookMinute, day.quotes.map((quote) => ({ expiry: quote.expiry, row: [quote.strike, quote.right, day.openInterest] })), openInterestColumns, { column: sliceColumn.openInterest, kind: "volume" }));
      if (day.intradayQuotes === undefined) continue;
      const quotesByLookTime = { "10:00": day.quotes, ...day.intradayQuotes };
      let quoteRows = 0;
      for (const [lookTime, quotes] of Object.entries(quotesByLookTime)) {
        insertAll(insertIntradaySlice, false, contractSlicesOf(day.tradingDate, lookMinuteOf(lookTime), quotes.map((quote) => ({ expiry: quote.expiry, row: [quote.strike, quote.right, quote.bid, quote.ask, quote.bidSize, quote.askSize] })), intradayQuoteColumns, askAboveZero));
        quoteRows += quotes.length;
      }
      insertIntradayDay.run(day.tradingDate, Object.keys(quotesByLookTime).length, quoteRows);
    }
    for (const dateIso of noDataDates) insertDay.run(dateIso, "no_data", 0, 0, 0);
    const insertIssue = database.prepare("INSERT INTO day_issues (trading_date, part, expiry, message, recorded_at) VALUES (?, ?, ?, ?, '2026-10-12T00:00:00Z')");
    for (const issue of quality?.dayIssues ?? []) insertIssue.run(issue.tradingDate, issue.part, issue.expiry, issue.message);
    const insertUnavailable = database.prepare("INSERT INTO unavailable_days VALUES (?, ?, 1, '2026-10-12T00:00:00Z')");
    for (const day of quality?.unavailableDays ?? []) insertUnavailable.run(day.tradingDate, day.reason);
  } finally {
    database.close();
  }
}

/**
 * Writes IBKR's bars into a synthetic symbol file (backtestFileStockBars.ts): `dailyBars`, and 30-minute bars at the
 * prices the engine read from the file's own quotes before it took every stock price from IBKR (put-call parity,
 * backtestBook.ts), so a test keeps the numbers it was written with. The 09:30 bar closes at the 10:00 quotes' price, a
 * bar ends at each later look at that look's, and the 15:30 bar at the closing quotes' (the old settlement and closing
 * fallback). A day whose quotes give no price gets no bar. `splitFactorOn` puts the quotes' as-traded prices on the
 * bars' split-adjusted scale.
 */
export function writeSyntheticIbkrBarsFromQuotes(filePath: string, dailyBars: readonly StoredDailyBar[], riskFreeRatePercent: number, splitFactorOn: (dateIso: string) => number = () => 1): void {
  const reader = new BacktestSymbolFile(new DatabaseSync(filePath, { readOnly: true }));
  const intraday: FileIntradayBar[] = [];
  const rate = riskFreeRatePercent / 100;
  try {
    const intradayDays = reader.loadIntradayDays();
    for (const { tradingDate } of reader.loadDays().filter((day) => day.status === "complete")) {
      const barEndingAt = (lookTimeEt: string, price: number | undefined) => {
        if (price === undefined) return;
        const end = easternInstant(tradingDate, Number(lookTimeEt.slice(0, 2)), Number(lookTimeEt.slice(3, 5)));
        const close = price / splitFactorOn(tradingDate);
        intraday.push({ barStart: new Date(end.getTime() - fileIntradayBarMinutes * 60_000), open: close, high: close, low: close, close, volume: 1_000 });
      };
      barEndingAt("10:00", computeParityStockPrice(reader.loadQuotes(tradingDate), tradingDate, rate, maximumSpreadFractionOfMid)?.price);
      if (intradayDays.has(tradingDate)) {
        for (const [lookTimeEt, quotes] of reader.loadIntradayQuotes(tradingDate, "10:00", "15:30", 0, Number.MAX_SAFE_INTEGER)) barEndingAt(lookTimeEt, computeParityStockPrice(quotes, tradingDate, rate, maximumSpreadFractionOfMid)?.price);
      }
      barEndingAt("16:00", computeParityStockPrice(reader.loadEndOfDay(tradingDate), tradingDate, rate, null)?.price);
    }
  } finally {
    reader.close();
  }
  const writer = new DatabaseSync(filePath);
  try {
    writeFileStockBars(writer, { daily: dailyBars, intraday, fetchedAt: new Date("2026-10-14T00:00:00Z") });
  } finally {
    writer.close();
  }
}
