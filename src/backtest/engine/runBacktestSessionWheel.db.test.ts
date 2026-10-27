import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { maximumSpreadFractionOfMid } from "../../lib/impliedVolatilitySurface.js";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import { backtestTickerBaselineKeys, defaultBacktestBaselineSettings, type BacktestAction, type BacktestBaselineSettings, type BacktestFill, type BacktestSessionDetail, type BacktestSettingsOverrides, type BacktestSymbolSettings } from "../backtestTypes.js";
import { loadAnalysisLadder } from "../analysis/analysisBacktest.js";
import { computeParityStockPrice } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";
import { dollarsAfter } from "./testSupport/gateTextDollars.js";

// Whole sessions through the wheel, in a private copy of the test tables: each on its own synthetic symbol (a file of
// 10:00 quotes priced at a chosen implied volatility per day, IBKR bars with chosen closes, DTB3 at 4%, the current model
// tables), run by runBacktestSession and read back by the session detail the screens use.
vi.mock("../../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../../lib/testSupport/isolatedTestSchema.js");
const { runBacktestSession } = await import("./runBacktestSession.js");
const { loadBacktestCycleDetail, loadBacktestSessionActions, loadBacktestSessionDetail, loadBacktestSessionFills } = await import("../jobs/backtestSessionStore.js");
const testDb: Knex = db;

const ratePercent = 4;
const startingValue = 1_000_000;
const hooks = { reportProgress: async () => {}, isCancelRequested: async () => false };
let dataDirectory: string;
let previousDataDirectory: string | undefined;

/** One symbol of a session: its file, its bars and its ticker. */
interface WheelSymbolSpec {
  symbol: string;
  /** Every day of the symbol's file. */
  fileDates: string[];
  /** The stock at 10:00 and at the close of each file day. */
  tenOClockPrices: number[];
  closes: number[];
  /** The expiries quoted on a day (those not yet past). */
  expiriesOn(dateIso: string): string[];
  /** The implied volatility the day's quotes are priced at; 0.6 unless given (rich against the 25% realized history). */
  impliedVolatilityOn?: Record<string, number>;
  /** The same for every day not listed in impliedVolatilityOn. */
  impliedVolatility?: number;
  sector?: string;
  earnings?: { dateIso: string; eventTime: string | null }[];
  /** File days the downloader could not retrieve at all: not stored, listed in unavailable_days. */
  unavailableDates?: string[];
  /** File days stored complete without their end-of-day part, with the day_issues row saying so. */
  datesWithoutEndOfDay?: string[];
  /** Days with no IBKR daily bar. */
  datesWithoutBar?: string[];
}

/** A session: its first symbol's spec, the symbols sharing its book, and its settings. It runs from the first file day to `lastSessionDate`. */
interface WheelSessionSpec extends WheelSymbolSpec {
  lastSessionDate: string;
  moreSymbols?: WheelSymbolSpec[];
  plutoOverrides?: Partial<PlutoSettings>;
  overrides?: BacktestSettingsOverrides;
  /** A session of per-ticker pots: each symbol's pot, weight and values. */
  pots?: Record<string, BacktestSymbolSettings>;
}

interface WheelSession {
  spec: WheelSessionSpec;
  sessionId: string;
  detail: BacktestSessionDetail;
  /** Every action and fill of the session, read through their pages. */
  actions: BacktestAction[];
  fills: BacktestFill[];
  /** A symbol's quotes of a day (the session's first symbol unless named); none on a day its file does not hold. */
  quotesOn(dateIso: string, symbol?: string): SymbolFileQuote[];
  /** A symbol's IBKR close before a day. */
  previousCloseOf(symbol: string, dateIso: string): number;
}

const everything = { from: null, to: null, symbol: null, outcome: null };

/** All the rows behind a paged read, fetched seven at a time so that more than one page is read. */
async function readEveryPage<Row>(readPage: (offset: number) => Promise<{ rows: Row[]; total: number }>): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const page = await readPage(rows.length);
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) return rows;
  }
}

/** Writes one symbol's file, ticker, bars and earnings; returns its quotes by day. */
async function createWheelSymbol(spec: WheelSymbolSpec): Promise<Map<string, SymbolFileQuote[]>> {
  const unavailableDates = new Set(spec.unavailableDates ?? []);
  const datesWithoutEndOfDay = new Set(spec.datesWithoutEndOfDay ?? []);
  const datesWithoutBar = new Set(spec.datesWithoutBar ?? []);
  const storedDates = spec.fileDates.filter((tradingDate) => !unavailableDates.has(tradingDate));
  const quotesByDate = new Map(storedDates.map((dateIso) => [dateIso, syntheticOptionQuotes(dateIso, spec.tenOClockPrices[spec.fileDates.indexOf(dateIso)]!, spec.expiriesOn(dateIso).filter((expiry) => expiry >= dateIso), spec.impliedVolatilityOn?.[dateIso] ?? spec.impliedVolatility ?? 0.6, ratePercent / 100, 1, 15)]));
  writeSyntheticSymbolFile(
    path.join(dataDirectory, `${spec.symbol}.sqlite`),
    spec.symbol,
    storedDates.map((tradingDate) => ({ tradingDate, quotes: quotesByDate.get(tradingDate)!, endOfDayVolume: 1_000, openInterest: 2_000, withoutEndOfDay: datesWithoutEndOfDay.has(tradingDate) })),
    [],
    unavailableDates.size + datesWithoutEndOfDay.size === 0
      ? null
      : { unavailableDays: [...unavailableDates].map((tradingDate) => ({ tradingDate, reason: "no 10:00 quotes could be retrieved" })), dayIssues: [...datesWithoutEndOfDay].map((tradingDate) => ({ tradingDate, part: "eod" as const, expiry: null, message: "HTTP 500" })) },
  );

  const [ticker] = await testDb("tickers").insert({ symbol: spec.symbol, company_name: `${spec.symbol} Co`, sector: spec.sector ?? "Technology", tradingview_ticker: `NASDAQ:${spec.symbol}` }).returning("id");
  const history = syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-04-03"), 100, 0.25, 11, 0.5);
  const sessionBars = spec.fileDates.map((tradingDate, index) => {
    const open = index === 0 ? 100 : spec.closes[index - 1]!;
    const close = spec.closes[index]!;
    return { tradingDate, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume: 1_000_000, impliedVolatility: 0.5 };
  });
  const dailyBars = [...history, ...sessionBars.filter((bar) => !datesWithoutBar.has(bar.tradingDate))];
  await testDb("daily_price_bars").insert(dailyBars.map((bar) => ({ ticker_id: ticker.id, trading_date: bar.tradingDate, open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: bar.volume, implied_volatility: bar.impliedVolatility })));
  writeSyntheticIbkrBarsFromQuotes(path.join(dataDirectory, `${spec.symbol}.sqlite`), dailyBars, ratePercent);
  if (spec.earnings) await testDb("ticker_calendar_events").insert(spec.earnings.map((event) => ({ ticker_id: ticker.id, event_type: "earnings", event_date: event.dateIso, event_time: event.eventTime, raw: JSON.stringify({}) })));
  return quotesByDate;
}

async function runWheelSession(spec: WheelSessionSpec): Promise<WheelSession> {
  const symbolSpecs: WheelSymbolSpec[] = [spec, ...(spec.moreSymbols ?? [])];
  const quotesBySymbol = new Map<string, Map<string, SymbolFileQuote[]>>();
  for (const symbolSpec of symbolSpecs) quotesBySymbol.set(symbolSpec.symbol, await createWheelSymbol(symbolSpec));
  const symbols = symbolSpecs.map((symbolSpec) => symbolSpec.symbol);

  const [session] = await testDb("backtest_sessions")
    .insert({ name: `wheel ${symbols.join(" ")}`, symbol: symbols.join(", "), symbols: JSON.stringify(symbols), start_date: spec.fileDates[0], end_date: spec.lastSessionDate, starting_value: startingValue, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings(spec.plutoOverrides)), overrides: JSON.stringify(spec.overrides ?? {}), ...(spec.pots ? { book_mode: "pots", symbol_settings: JSON.stringify(spec.pots) } : {}) })
    .returning("id");
  await runBacktestSession(session.id, hooks);
  const detail = await loadBacktestSessionDetail(session.id);
  const actions = await readEveryPage(async (offset) => {
    const page = await loadBacktestSessionActions(session.id, { ...everything, limit: 7, offset });
    return { rows: page.actions, total: page.total };
  });
  const fills = await readEveryPage(async (offset) => {
    const page = await loadBacktestSessionFills(session.id, { ...everything, limit: 7, offset });
    return { rows: page.fills, total: page.total };
  });
  return {
    spec,
    sessionId: session.id,
    detail,
    actions,
    fills,
    quotesOn: (dateIso, symbol = spec.symbol) => quotesBySymbol.get(symbol)?.get(dateIso) ?? [],
    previousCloseOf: (symbol, dateIso) => {
      const symbolSpec = symbolSpecs.find((entry) => entry.symbol === symbol)!;
      const datesWithoutBar = symbolSpec.datesWithoutBar ?? [];
      const index = symbolSpec.fileDates.findLastIndex((fileDate) => fileDate < dateIso && !datesWithoutBar.includes(fileDate));
      return symbolSpec.closes[index]!;
    },
  };
}

/**
 * The account of every session day recomputed from what the session stored and the day's quotes, independently of the
 * engine's ledger: cash = the start + interest + every fill before the day's 10:00 mark (and the strike paid for shares
 * called away), marks = each symbol's shares held at the mark × its 10:00 stock price (its previous close on a day its
 * file does not hold or cannot price) − the short options held × their 10:00 mids (their last one on such a day).
 * Shares are counted from the fills and the call-aways: a share position's leg grows as shares are handed to it.
 */
function recomputeAccountDays(session: WheelSession): { tradingDate: string; cash: number; marks: number }[] {
  const { detail } = session;
  const legs = detail.positions.flatMap((position) => position.legs.map((leg) => ({ leg, position })));
  const symbols = [...new Set(detail.positions.map((position) => position.symbol))];
  const lastMidByLegId = new Map<string, number>();
  let interestSoFar = 0;
  return detail.days.map((day) => {
    const markMs = easternInstant(day.tradingDate, 10, 0).getTime();
    interestSoFar += day.interestDollars;
    let cash = startingValue + interestSoFar;
    const sharesBySymbol = new Map<string, number>(symbols.map((symbol) => [symbol, 0]));
    for (const fill of session.fills) {
      if (Date.parse(fill.executedAt) >= markMs) continue;
      const dollars = fill.price * fill.quantity * fill.multiplier;
      cash += (fill.side === "sell" ? dollars : -dollars) - fill.commissionDollars;
      if (fill.instrument === "stock") sharesBySymbol.set(fill.symbol, sharesBySymbol.get(fill.symbol)! + (fill.side === "buy" ? fill.quantity : -fill.quantity));
    }
    // Shares called away leave at the strike with no stock trade.
    for (const { leg, position } of legs) {
      if (!(leg.legType === "stock" && position.strategyKey === "covered_call" && position.closeReason === "assigned" && leg.exitAt !== null && Date.parse(leg.exitAt) < markMs)) continue;
      cash += leg.exitPrice! * leg.quantity;
      sharesBySymbol.set(position.symbol, sharesBySymbol.get(position.symbol)! - leg.quantity);
    }

    let marks = 0;
    for (const symbol of symbols) {
      const quotes = session.quotesOn(day.tradingDate, symbol);
      const stockPrice = computeParityStockPrice(quotes, day.tradingDate, ratePercent / 100, maximumSpreadFractionOfMid)?.price ?? session.previousCloseOf(symbol, day.tradingDate);
      marks += sharesBySymbol.get(symbol)! * stockPrice;
      for (const { leg, position } of legs) {
        if (position.symbol !== symbol || leg.legType !== "option" || !(Date.parse(leg.entryAt) < markMs) || (leg.exitAt !== null && Date.parse(leg.exitAt) < markMs)) continue;
        const quoteAmong = (dayQuotes: SymbolFileQuote[]) => dayQuotes.find((entry) => entry.expiry === leg.expiry && entry.strike === leg.strike && entry.right === (leg.optionType === "call" ? "C" : "P"));
        // Without a quote today the option keeps its last mark: an earlier day's, or the mid it was sold at 10:00 against.
        const quote = quoteAmong(quotes) ?? (lastMidByLegId.has(leg.legId) ? undefined : quoteAmong(session.quotesOn(leg.entryAt.slice(0, 10), symbol)));
        // A quote with no bid gives no mark (backtestOptionMarks.ts).
        if (quote && quote.bid !== null && quote.bid > 0 && quote.ask !== null && quote.ask >= quote.bid) lastMidByLegId.set(leg.legId, (quote.bid + quote.ask) / 2);
        marks -= leg.quantity * leg.multiplier * lastMidByLegId.get(leg.legId)!;
      }
    }
    return { tradingDate: day.tradingDate, cash, marks };
  });
}

function expectAccountToReconcile(session: WheelSession): void {
  const recomputed = recomputeAccountDays(session);
  for (const [index, day] of session.detail.days.entries()) {
    expect(day.cash, `cash on ${day.tradingDate}`).toBeCloseTo(recomputed[index]!.cash, 1);
    expect(day.accountValue, `account value on ${day.tradingDate}`).toBeCloseTo(recomputed[index]!.cash + recomputed[index]!.marks, 1);
  }
}

const commissionPerContract = 0.68;

/** The day's quote of a contract in the session's file. */
function quoteOf(session: WheelSession, dateIso: string, expiry: string, strike: number, right: "C" | "P", symbol?: string) {
  const quote = session.quotesOn(dateIso, symbol).find((entry) => entry.expiry === expiry && entry.strike === strike && entry.right === right)!;
  const mid = (quote.bid! + quote.ask!) / 2;
  const spreadShare = (0.5 * (quote.ask! - quote.bid!)) / 2;
  return { bid: quote.bid!, ask: quote.ask!, mid, saleFill: mid - spreadShare, purchaseFill: mid + spreadShare };
}

/** The 10:00 stock price the day's quotes imply. */
function stockPriceOn(session: WheelSession, dateIso: string): number {
  return computeParityStockPrice(session.quotesOn(dateIso), dateIso, ratePercent / 100, maximumSpreadFractionOfMid)!.price;
}

const filledActionsOf = (session: WheelSession) => session.actions.filter((action) => action.outcome === "filled");
const dayOf = (session: WheelSession, dateIso: string) => session.detail.days.find((day) => day.tradingDate === dateIso)!;
const totalInterest = (session: WheelSession) => session.detail.days.reduce((sum, day) => sum + day.interestDollars, 0);

beforeAll(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-wheel-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  writeFileSync(path.join(dataDirectory, "fred-DTB3.json"), JSON.stringify({ seriesId: "DTB3", fetchedAtIso: "2026-10-12T00:00:00.000Z", observations: weekdaysBetween("2025-12-01", "2026-06-30").map((dateIso) => ({ dateIso, ratePercent })) }));
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("a session through the wheel", () => {
  it("skips the days the downloader could not retrieve and says when volume was unknown", async () => {
    // 8 April could not be downloaded at all; the 9th is stored without its end-of-day part, so on the 10th the previous
    // session's volume is unknown and the volume limit allows no contract.
    const fileDates = weekdaysBetween("2026-04-06", "2026-04-14");
    const session = await runWheelSession({
      symbol: "WHLD",
      fileDates,
      lastSessionDate: "2026-04-14",
      tenOClockPrices: [100, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7],
      closes: [100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7],
      expiriesOn: () => ["2026-04-24"],
      unavailableDates: ["2026-04-08"],
      datesWithoutEndOfDay: ["2026-04-09"],
      overrides: { decisionMaker: "baseline" },
    });
    const { detail } = session;
    expect(detail.session.status).toBe("succeeded");
    expect(detail.days.map((day) => day.tradingDate)).toEqual(["2026-04-06", "2026-04-07", "2026-04-09", "2026-04-10", "2026-04-13", "2026-04-14"]);
    expectAccountToReconcile(session);

    expect(dayOf(session, "2026-04-07").decisionSummary).not.toContain("could not be downloaded");
    // The day after the gap names it.
    expect(dayOf(session, "2026-04-09").decisionSummary).toMatch(/ · 1 day\(s\) before this one could not be downloaded and were skipped: 2026-04-08$/);
    // Interest over the two calendar days since the 7th.
    const dayAfterTheGap = dayOf(session, "2026-04-09");
    expect(dayAfterTheGap.interestDollars).toBeCloseTo(((dayAfterTheGap.cash - dayAfterTheGap.interestDollars) * 0.04 * 2) / 365, 2);
    // No volume for the 9th: nothing is sold on the 10th, and the summary says why.
    expect(dayOf(session, "2026-04-10").decisionSummary).toMatch(/ · volume unknown for every contract \(refused by the volume rule\): the file has no end-of-day data for 2026-04-09$/);
    expect(filledActionsOf(session).filter((action) => action.tradingDate === "2026-04-10")).toEqual([]);
    // Back to normal on the 13th.
    expect(dayOf(session, "2026-04-13").decisionSummary).not.toContain("volume unknown");
  }, 60_000);

  it("settles on IBKR's last 30-minute bar when there is no daily bar for the expiry, and fails when there is neither", async () => {
    const fileDates = weekdaysBetween("2026-04-06", "2026-04-21");
    //                        6     7      8      9     10    13    14    15    16    17    20    21
    const tenOClockPrices = [100, 100.2, 100.6, 100.4, 99.6, 98.8, 98.2, 97.8, 97.4, 97.2, 97.6, 99.0];
    const closes = /*     */ [100.1, 100.4, 100.5, 100, 99.2, 98.5, 98.0, 97.6, 97.3, 97.0, 98.4, 99.1];
    const spec = { fileDates, lastSessionDate: "2026-04-21", tenOClockPrices, closes, expiriesOn: (dateIso: string) => (dateIso < "2026-04-17" ? ["2026-04-17"] : ["2026-04-17", "2026-04-24"]), overrides: { decisionMaker: "baseline" as const } };

    // No daily bar for Friday 17 April, but 30-minute bars: the stock settles at the last one's close (≈ 97.2), under the $100 and $98 strikes.
    const settled = await runWheelSession({ ...spec, symbol: "WHLE", datesWithoutBar: ["2026-04-17"] });
    const monday = dayOf(settled, "2026-04-20").decisionSummary!;
    expect(monday).toContain("WHLE $100 Put · 17 Apr assigned at the 97.20 close: 10300 shares bought at the strike");
    expect(monday).toContain("WHLE $98 Put · 17 Apr assigned at the 97.20 close: 100 shares bought at the strike");
    expect(monday).toContain("settled 2026-04-17 at the close of IBKR's last 30-minute bar (no daily bar)");
    expectAccountToReconcile(settled);

    // Neither a daily nor a 30-minute bar: the session stops rather than guess a price or leave the put open.
    await expect(runWheelSession({ ...spec, symbol: "WHLF", datesWithoutBar: ["2026-04-17"], unavailableDates: ["2026-04-17"] })).rejects.toThrow(
      /^Cannot settle WHLF \$\d+ Put · 17 Apr: the WHLF data file has no IBKR daily or 30-minute bar for 2026-04-17\. Press Update on its row in Data files and run the session again\.$/,
    );
  }, 60_000);
});

describe("a session of several symbols on one book", () => {
  const dates = weekdaysBetween("2026-04-06", "2026-04-15");
  //                        6     7      8      9      10     13     14     15
  const pricesA = /*    */ [100, 100.2, 100.3, 100.1, 100.4, 100.6, 100.5, 100.7];
  const pricesB = /*    */ [100, 99.8, 99.9, 100.2, 100.1, 100.3, 100.5, 100.4];
  const symbolSpec = (symbol: string, prices: number[], change: Partial<WheelSymbolSpec> = {}): WheelSymbolSpec => ({ symbol, fileDates: dates, tenOClockPrices: prices, closes: prices.map((price) => price + 0.1), expiriesOn: () => ["2026-04-24"], ...change });

  it("gives each ticker of a pots session its pot: turns in alphabetical order, its share level and weight, buy and hold per pot", async () => {
    const ladder = { ...defaultBacktestBaselineSettings, entry: "covered_call", putsWhenNoCall: "reserve_ladder", entryWhenSharesUncovered: "buy", callStrike: "above_break_even", minAbsDelta: 0.01, maxAbsDelta: 1, maxSpreadPctOfMid: 50 } as BacktestBaselineSettings;
    const tickerValues = (ladderSharesPct: number) => ({ ...Object.fromEntries(backtestTickerBaselineKeys.map((key) => [key, ladder[key]])), ladderSharesPct }) as BacktestSymbolSettings["baseline"];
    const source = Object.fromEntries([...backtestTickerBaselineKeys, "potDollars"].map((key) => [key, "request"])) as BacktestSymbolSettings["source"];
    // Given WTB first: the pots session still lets WTA take its turn first at every look.
    const pots: Record<string, BacktestSymbolSettings> = {
      WTB: { potDollars: 750_000, weight: 0.75, baseline: tickerValues(40), source },
      WTA: { potDollars: 250_000, weight: 0.25, baseline: tickerValues(60), source },
    };
    const session = await runWheelSession({ ...symbolSpec("WTB", pricesB), lastSessionDate: "2026-04-10", moreSymbols: [symbolSpec("WTA", pricesA)], overrides: { decisionMaker: "baseline", baseline: ladder }, pots });
    const { detail } = session;
    expect(detail.session).toMatchObject({ status: "succeeded", symbols: ["WTB", "WTA"], bookMode: "pots", symbolSettings: pots });
    // The cash-bound report lists every ticker in its turn order; the orders' shortfalls are stored with the session.
    expect(detail.session.cashBoundBySymbol!.map((entry) => entry.symbol)).toEqual(["WTA", "WTB"]);
    const storedShortfalls: { symbol: string; look_count: number }[] = await testDb("backtest_look_shortfalls").where({ session_id: session.sessionId }).select("symbol", "look_count");
    expect(storedShortfalls.length).toBeGreaterThan(0);
    expect(storedShortfalls.every((row) => row.look_count >= 1)).toBe(true);

    // Each look's actions: every WTA one before any WTB one.
    const filled = filledActionsOf(session);
    expect(filled.length).toBeGreaterThan(0);
    // The ladder's levels: one row per ticker and day its cycle held shares, which the analysis reads with the rungs sold.
    const storedLevels: { symbol: string; trading_date: string }[] = await testDb("backtest_ladder_levels").where({ session_id: session.sessionId }).select("symbol", testDb.raw("trading_date::text as trading_date"));
    expect(storedLevels.length).toBeGreaterThan(0);
    expect(new Set(storedLevels.map((row) => `${row.symbol}|${row.trading_date}`)).size).toBe(storedLevels.length);
    const ladderOfB = await loadAnalysisLadder(session.sessionId, "WTB", testDb);
    expect(ladderOfB.ladderLevels.map(([date]) => date)).toEqual(storedLevels.filter((row) => row.symbol === "WTB").map((row) => row.trading_date).sort());
    const ladderPutsOfB = filled.filter((action) => action.symbol === "WTB" && action.kind === "open_cash_secured_put" && "ladderCap" in (action.candidateScores ?? {}));
    expect(ladderOfB.ladderRungsSold.flatMap(([, , fills]) => fills).length).toBe(ladderPutsOfB.length);
    // The shares held each day at the account value's marks: none before the first purchase, then part of the account.
    const storedDays: { shares_value_dollars: string | null; account_value: string }[] = await testDb("backtest_session_days").where({ session_id: session.sessionId }).orderBy("trading_date").select("shares_value_dollars", "account_value");
    expect(storedDays.every((day) => day.shares_value_dollars !== null && Number(day.shares_value_dollars) >= 0 && Number(day.shares_value_dollars) <= Number(day.account_value))).toBe(true);
    expect(Number(storedDays[0]!.shares_value_dollars)).toBe(0);
    expect(storedDays.some((day) => Number(day.shares_value_dollars) > 0)).toBe(true);
    for (const at of new Set(filled.map((action) => action.at))) {
      const symbolsAtLook = filled.filter((action) => action.at === at).map((action) => action.symbol);
      expect(symbolsAtLook).toEqual([...symbolsAtLook].sort());
    }

    // Shares bought on the first day with sales: within each ticker's budget, its weight × the $1,000,000 account × its
    // share level (WTA 0.25 × 60% = $150,000; WTB 0.75 × 40% = $300,000), and short of it by less than one lot.
    const firstSaleDay = filled[0]!.tradingDate;
    for (const [symbol, budget] of [["WTA", 150_000], ["WTB", 300_000]] as const) {
      const shareFills = session.fills.filter((fill) => fill.symbol === symbol && fill.instrument === "stock" && fill.side === "buy" && fill.tradingDate === firstSaleDay);
      const cost = shareFills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
      expect(cost).toBeLessThanOrEqual(budget);
      expect(cost).toBeGreaterThan(budget - 100 * shareFills[0]!.price);
    }

    // Buy and hold: each symbol's pot in whole shares at the first 10:00 price, the rest in cash.
    const priceOn = (symbol: string, dateIso: string) => computeParityStockPrice(session.quotesOn(dateIso, symbol), dateIso, ratePercent / 100, maximumSpreadFractionOfMid)?.price ?? session.previousCloseOf(symbol, dateIso);
    const sharesOf = (symbol: string) => Math.floor(pots[symbol]!.potDollars / priceOn(symbol, "2026-04-06"));
    const baselineCash = startingValue - sharesOf("WTA") * priceOn("WTA", "2026-04-06") - sharesOf("WTB") * priceOn("WTB", "2026-04-06");
    expect(dayOf(session, "2026-04-10").baselineValue).toBeCloseTo(baselineCash + sharesOf("WTA") * priceOn("WTA", "2026-04-10") + sharesOf("WTB") * priceOn("WTB", "2026-04-10"), 0);
  }, 60_000);

});
