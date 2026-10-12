import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { maximumSpreadFractionOfMid } from "../../lib/impliedVolatilitySurface.js";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import { kindFromCandidateId } from "../../pluto/decisionSchema.js";
import { buildPlutoSystemPrompt } from "../../pluto/prompt.js";
import type { BacktestAction, BacktestFill, BacktestSessionDetail, BacktestSettingsOverrides } from "../backtestTypes.js";
import type { ClaudeCall } from "../llm/askPlutoThroughSubscription.js";
import type { ClaudeSubscriptionCallInput, ClaudeSubscriptionCallResult } from "../llm/claudeSubscriptionModelClient.js";
import { maskPlutoText, unmaskPlutoText, type PlutoPromptMasking } from "../llm/plutoPromptMasking.js";
import { computeParityStockPrice, computeSaleFillPrice } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticMacroEventHistory, writeSyntheticSymbolFile } from "./testSupport/syntheticBacktestData.js";

// Whole sessions with looks inside Pluto's window, in a private copy of the test tables: each on its own synthetic
// symbols, whose files hold the quotes of every look named for a day (priced at a chosen stock price and implied
// volatility per look), IBKR bars with chosen closes, DTB3 at 4% and the current model tables. Run by runBacktestSession
// and read back through the session detail and its pages, as the screens read them.
vi.mock("../../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../../lib/testSupport/isolatedTestSchema.js");
const { lookTimesInWindow, runBacktestSession } = await import("./runBacktestSession.js");
const { loadBacktestSessionActions, loadBacktestSessionDetail, loadBacktestSessionFills } = await import("../jobs/backtestSessionStore.js");
const { describeDaysWithoutIntradayQuotes } = await import("../jobs/backtestSessionRequest.js");
const testDb: Knex = db;

const ratePercent = 4;
const startingValue = 1_000_000;
const hooks = { reportProgress: async () => {}, isCancelRequested: async () => false };
const everyLookTime = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"];
let dataDirectory: string;
let previousDataDirectory: string | undefined;

/** The quotes of one look: the stock price they are priced at, their implied volatility and how wide they are. */
interface LookSpec {
  price: number;
  /** 0.6 unless given: rich against the 25% realized history. */
  impliedVolatility?: number;
  /** Half the spread as a share of the option's price; 0.02 unless given. */
  halfSpreadShareOfPrice?: number;
}

interface LookDaySpec {
  /** The looks stored for the day, by time; "10:00" is the capture. A day with only "10:00" has no intraday quotes unless `storedWithIntradayQuotes`. */
  looks: Record<string, LookSpec>;
  close: number;
}

interface LookSymbolSpec {
  symbol: string;
  /** Every day of the symbol's file. */
  days: Record<string, LookDaySpec>;
  /** File days stored as exchange holidays. */
  holidays?: string[];
  expiriesOn(dateIso: string): string[];
  /** False: the file has no intraday quotes at all (only the 10:00 look of each day is stored). */
  intradayQuotes?: boolean;
}

interface LookSessionSpec {
  symbols: LookSymbolSpec[];
  plutoOverrides?: Partial<PlutoSettings>;
  overrides?: BacktestSettingsOverrides;
  /** The AI model as decision maker: the Claude call a test stands in for. */
  callModel?: ClaudeCall;
  /** Scoring worker threads; the session's own choice when absent. */
  scoringWorkers?: number;
}

interface LookSession {
  sessionId: string;
  detail: BacktestSessionDetail;
  actions: BacktestAction[];
  fills: BacktestFill[];
  /** A symbol's quotes at a look of a day. */
  quotesAt(symbol: string, dateIso: string, lookTimeEt: string): SymbolFileQuote[];
}

function quotesOfLook(dateIso: string, expiries: string[], look: LookSpec): SymbolFileQuote[] {
  const quotes = syntheticOptionQuotes(dateIso, look.price, expiries.filter((expiry) => expiry >= dateIso), look.impliedVolatility ?? 0.6, ratePercent / 100, 1, 15);
  if (look.halfSpreadShareOfPrice === undefined) return quotes;
  return quotes.map((quote) => {
    const mid = (quote.bid! + quote.ask!) / 2;
    return { ...quote, bid: Math.round(mid * (1 - look.halfSpreadShareOfPrice!) * 100) / 100, ask: Math.round(mid * (1 + look.halfSpreadShareOfPrice!) * 100) / 100 };
  });
}

async function createLookSymbol(spec: LookSymbolSpec): Promise<Map<string, SymbolFileQuote[]>> {
  const fileDates = Object.keys(spec.days).sort();
  const quotesByDateAndLook = new Map<string, SymbolFileQuote[]>();
  for (const dateIso of fileDates) for (const [lookTimeEt, look] of Object.entries(spec.days[dateIso]!.looks)) quotesByDateAndLook.set(`${dateIso} ${lookTimeEt}`, quotesOfLook(dateIso, spec.expiriesOn(dateIso), look));
  writeSyntheticSymbolFile(
    path.join(dataDirectory, `${spec.symbol}.sqlite`),
    spec.symbol,
    fileDates.map((tradingDate) => {
      const day = spec.days[tradingDate]!;
      const laterLooks = Object.keys(day.looks).filter((lookTimeEt) => lookTimeEt !== "10:00");
      return {
        tradingDate,
        quotes: quotesByDateAndLook.get(`${tradingDate} 10:00`)!,
        endOfDayVolume: 1_000,
        openInterest: 2_000,
        intradayQuotes: spec.intradayQuotes === false ? undefined : Object.fromEntries(laterLooks.map((lookTimeEt) => [lookTimeEt, quotesByDateAndLook.get(`${tradingDate} ${lookTimeEt}`)!])),
        closingQuotes: quotesOfLook(tradingDate, spec.expiriesOn(tradingDate), { price: day.close, impliedVolatility: Object.values(day.looks).at(-1)!.impliedVolatility }),
      };
    }),
    spec.holidays ?? [],
  );
  const [ticker] = await testDb("tickers").insert({ symbol: spec.symbol, company_name: `${spec.symbol} Co`, sector: "Technology", tradingview_ticker: `NASDAQ:${spec.symbol}` }).returning("id");
  // A 25% realized history ending at 100 on the day before the file starts, then the file days' own closes.
  const firstFileDate = fileDates[0]!;
  const history = syntheticDailyBars(weekdaysBetween("2025-01-01", firstFileDate).slice(0, -1), 100, 0.25, 11, 0.5);
  const sessionBars = fileDates.map((tradingDate, index) => {
    const open = index === 0 ? 100 : spec.days[fileDates[index - 1]!]!.close;
    const close = spec.days[tradingDate]!.close;
    return { tradingDate, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume: 1_000_000, impliedVolatility: 0.5 };
  });
  await testDb("daily_price_bars").insert([...history, ...sessionBars].map((bar) => ({ ticker_id: ticker.id, trading_date: bar.tradingDate, open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: bar.volume, implied_volatility: bar.impliedVolatility })));
  return quotesByDateAndLook;
}

const everything = { from: null, to: null, symbol: null, outcome: null };

/** The symbols' files and bars, and the session row; not run. */
async function createLookSession(spec: LookSessionSpec): Promise<{ sessionId: string; quotesBySymbol: Map<string, Map<string, SymbolFileQuote[]>> }> {
  const quotesBySymbol = new Map<string, Map<string, SymbolFileQuote[]>>();
  for (const symbolSpec of spec.symbols) quotesBySymbol.set(symbolSpec.symbol, await createLookSymbol(symbolSpec));
  const symbols = spec.symbols.map((symbolSpec) => symbolSpec.symbol);
  const fileDates = [...new Set(spec.symbols.flatMap((symbolSpec) => Object.keys(symbolSpec.days)))].sort();
  const [session] = await testDb("backtest_sessions")
    .insert({ name: `looks ${symbols.join(" ")}`, symbol: symbols.join(", "), symbols: JSON.stringify(symbols), start_date: fileDates[0], end_date: fileDates.at(-1), starting_value: startingValue, tables_mode: "current", settings_snapshot: JSON.stringify(fixtureBacktestSettings(spec.plutoOverrides)), overrides: JSON.stringify(spec.overrides ?? { policy: { roll: "never" } }) })
    .returning("id");
  return { sessionId: session.id, quotesBySymbol };
}

async function runLookSession(spec: LookSessionSpec): Promise<LookSession> {
  const { sessionId, quotesBySymbol } = await createLookSession(spec);
  await runBacktestSession(sessionId, { ...hooks, ...(spec.callModel ? { callModel: spec.callModel } : {}), ...(spec.scoringWorkers !== undefined ? { scoringWorkers: spec.scoringWorkers } : {}) });
  return readLookSession(sessionId, quotesBySymbol);
}

async function readLookSession(sessionId: string, quotesBySymbol: Map<string, Map<string, SymbolFileQuote[]>>): Promise<LookSession> {
  return {
    sessionId,
    detail: await loadBacktestSessionDetail(sessionId),
    actions: (await loadBacktestSessionActions(sessionId, { ...everything, limit: 1000, offset: 0 })).actions,
    fills: (await loadBacktestSessionFills(sessionId, { ...everything, limit: 1000, offset: 0 })).fills,
    quotesAt: (symbol, dateIso, lookTimeEt) => quotesBySymbol.get(symbol)!.get(`${dateIso} ${lookTimeEt}`) ?? [],
  };
}

const lookInstantIso = (dateIso: string, lookTimeEt: string) => easternInstant(dateIso, Number(lookTimeEt.slice(0, 2)), Number(lookTimeEt.slice(3))).toISOString();
const dayOf = (session: LookSession, dateIso: string) => session.detail.days.find((day) => day.tradingDate === dateIso)!;
const filledOn = (session: LookSession, dateIso: string) => session.actions.filter((action) => action.tradingDate === dateIso && action.outcome === "filled");
const looksAt = (price: number, lookTimes: string[], look: Omit<LookSpec, "price"> = {}): Record<string, LookSpec> => Object.fromEntries(lookTimes.map((lookTimeEt) => [lookTimeEt, { price, ...look }]));
const marchExpiries = () => ["2026-03-13", "2026-03-20"];
/** The file's first day: nothing can be sold on it (the volume Pluto's rule reads is the previous day's, and there is none). */
const firstFileDay = (price = 100): LookDaySpec => ({ looks: looksAt(price, ["10:00"]), close: price });
const fridayBefore = "2026-02-27";

/** SPY's 30-minute bars of a day, by the time each starts: what the market-stress check reads. */
async function insertMarketBars(dateIso: string, closeByBarStart: Record<string, number>): Promise<void> {
  const existing = await testDb("tickers").where({ symbol: "SPY" }).first("id");
  const ticker = existing ?? (await testDb("tickers").insert({ symbol: "SPY", company_name: "SPDR S&P 500 ETF", sector: "ETF", tradingview_ticker: "AMEX:SPY" }).returning("id"))[0];
  await testDb("intraday_price_bars").insert(Object.entries(closeByBarStart).map(([barStart, close]) => ({ ticker_id: ticker.id, bar_size: "30 mins", bar_time: new Date(lookInstantIso(dateIso, barStart)), open_price: close, high_price: close, low_price: close, close_price: close, volume: 1_000 })));
}

beforeAll(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-looks-"));
  previousDataDirectory = process.env.BACKTEST_DATA_DIR;
  process.env.BACKTEST_DATA_DIR = dataDirectory;
  writeFileSync(path.join(dataDirectory, "fred-DTB3.json"), JSON.stringify({ seriesId: "DTB3", fetchedAtIso: "2027-01-05T00:00:00.000Z", observations: weekdaysBetween("2025-12-01", "2026-12-31").map((dateIso) => ({ dateIso, ratePercent })) }));
  // One release in the whole history: CPI on 10 June 2026, 08:30 ET.
  writeSyntheticMacroEventHistory(dataDirectory, [{ eventKey: "cpi", title: "CPI", dateIso: "2026-06-10", eventAtIso: easternInstant("2026-06-10", 8, 30).toISOString() }]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("the looks of a day", () => {
  it("are the half hours from the window's start through its end, never later than 30 minutes before the close", () => {
    expect(lookTimesInWindow("10:00", "15:30", 16 * 60)).toEqual(everyLookTime);
    // A 13:00 close pulls the end in to 12:30: the quotes stored for later times repeat the close and are never read.
    expect(lookTimesInWindow("10:00", "15:30", 13 * 60)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
    expect(lookTimesInWindow("10:45", "12:00", 16 * 60)).toEqual(["11:00", "11:30", "12:00"]);
    expect(lookTimesInWindow("09:30", "16:00", 16 * 60)).toEqual(everyLookTime);
    expect(lookTimesInWindow("15:45", "15:50", 16 * 60)).toEqual([]);
  });
});

describe("a session with looks inside the window", () => {
  it("sells at a later look a contract that was not eligible at 10:00, on that look's quotes", async () => {
    // At 10:00 every quote is 40% wide (Pluto takes 15% at most); from 10:30 the quotes are tight and the stock is at 99.
    const dateIso = "2026-03-02";
    const session = await runLookSession({
      symbols: [{ symbol: "LKA", days: { [fridayBefore]: firstFileDay(), [dateIso]: { looks: { "10:00": { price: 100, halfSpreadShareOfPrice: 0.2 }, "10:30": { price: 99 }, "11:00": { price: 99 } }, close: 99 } }, expiriesOn: marchExpiries }],
      plutoOverrides: { maxOpenPositions: 1 },
    });
    expect(session.detail.session.status).toBe("succeeded");
    const filled = filledOn(session, dateIso);
    expect(filled).toHaveLength(1);
    const open = filled[0]!;
    expect(open).toMatchObject({ lookTimeEt: "10:30", at: lookInstantIso(dateIso, "10:30"), passNumber: 1, chosenBecause: "Pluto's top pick by Edge Yield" });
    expect(open.kind).toMatch(/^open_/);
    const quote = session.quotesAt("LKA", dateIso, "10:30").find((entry) => entry.expiry === open.contract!.expiry && entry.strike === open.contract!.strike && entry.right === open.contract!.right)!;
    expect(open.fillPrice).toBeCloseTo(computeSaleFillPrice(quote.bid!, quote.ask!, 0.5), 8);
    const trade = session.detail.trades[0]!;
    expect(trade).toMatchObject({ openedOn: dateIso, bid: quote.bid, ask: quote.ask });
    expect(trade.spotAtOpen).toBeCloseTo(computeParityStockPrice(session.quotesAt("LKA", dateIso, "10:30"), dateIso, ratePercent / 100, maximumSpreadFractionOfMid)!.price, 3);
    expect(trade.spotAtOpen).toBeCloseTo(99, 1);
    expect(session.fills.filter((fill) => fill.actionId === open.actionId && fill.instrument === "option").map((fill) => fill.executedAt)).toEqual([lookInstantIso(dateIso, "10:30")]);

    // The day: three looks, one action, named with its time; the 11:00 look hit the open-positions cap.
    const day = dayOf(session, dateIso);
    expect(day).toMatchObject({ looksRun: 3, actionsTaken: 1 });
    // The day's row is its 10:00 mark, before the looks: still all cash.
    expect(day.accountValue).toBeCloseTo(startingValue + day.interestDollars, 6);
    expect(day.decisionSummary).toMatch(/^10:30 Opened LKA Sell /);
    expect(dayOf(session, fridayBefore)).toMatchObject({ looksRun: 1, actionsTaken: 0 });
    expect(session.detail.session.runStatistics).toMatchObject({ looksRun: 4, daysWithIntradayLooks: 1, dailyLossBreakerTripDates: [], marketStressLooks: 0 });
    expect(session.detail.session.notes[0]).toBe("Looks: 10:00, 10:30, 11:00, 11:30, 12:00, 12:30, 13:00, 13:30, 14:00, 14:30, 15:00, 15:30 ET on a full day (window 10:00–15:30 ET, never later than 30 minutes before the close); 4 run over 2 days.");
  }, 60_000);

  it("keeps a ticker out for 60 minutes after a fill: nothing at the next look, a new order at the one after", async () => {
    const [firstDay, secondDay] = ["2026-03-02", "2026-03-03"];
    const session = await runLookSession({
      symbols: [{ symbol: "LKC", days: { [fridayBefore]: firstFileDay(), [firstDay]: { looks: looksAt(100, ["10:00", "10:30", "11:00", "11:30"]), close: 100 }, [secondDay]: { looks: looksAt(100, ["10:00"]), close: 100 } }, expiriesOn: marchExpiries }],
      plutoOverrides: { maxTickerExposurePct: 20 },
    });
    const filled = filledOn(session, firstDay);
    expect(filled.map((action) => action.lookTimeEt)).toEqual(["10:00", "11:00"]);
    expect(filled.every((action) => action.kind.startsWith("open_"))).toBe(true);
    // Two different contracts: the first one is occupied at 11:00.
    expect(new Set(filled.map((action) => `${action.contract!.expiry} ${action.contract!.strike} ${action.contract!.right}`)).size).toBe(2);
    expect(session.actions.filter((action) => action.tradingDate === firstDay && (action.lookTimeEt === "10:30" || action.lookTimeEt === "11:30"))).toEqual([]);
    expect(dayOf(session, firstDay)).toMatchObject({ looksRun: 4, actionsTaken: 2 });
    expect(dayOf(session, firstDay).decisionSummary).toMatch(/^10:00 Opened LKC .* · 11:00 Opened LKC .* · no action at the other 2 looks/);

    // The next day's row is its 10:00 mark with both of the first day's fills in it: the cash they brought, less the
    // two options at their 10:00 mids (and plus the shares a buy-write bought, at the 10:00 stock price).
    const next = dayOf(session, secondDay);
    const stockPrice = computeParityStockPrice(session.quotesAt("LKC", secondDay, "10:00"), secondDay, ratePercent / 100, maximumSpreadFractionOfMid)!.price;
    let cash = startingValue + session.detail.days.reduce((sum, day) => sum + day.interestDollars, 0);
    let marks = 0;
    for (const fill of session.fills.filter((entry) => entry.tradingDate === firstDay)) {
      const dollars = fill.price * fill.quantity * fill.multiplier;
      cash += (fill.side === "sell" ? dollars : -dollars) - fill.commissionDollars;
      if (fill.instrument === "stock") marks += fill.quantity * stockPrice;
    }
    for (const action of filled) {
      const quote = session.quotesAt("LKC", secondDay, "10:00").find((entry) => entry.expiry === action.contract!.expiry && entry.strike === action.contract!.strike && entry.right === action.contract!.right)!;
      marks -= ((quote.bid! + quote.ask!) / 2) * action.quantity! * 100;
    }
    expect(next.cash).toBeCloseTo(cash, 2);
    expect(next.accountValue).toBeCloseTo(cash + marks, 2);
    expect(next.looksRun).toBe(1);
  }, 60_000);

  it("stops for the day when the account is down by the daily-loss breaker's percentage, and looks again the next day", async () => {
    // A position of about $50,000 opened on the first day; on the second the stock falls from 100 to 88 at 10:30.
    const [firstDay, secondDay, thirdDay] = ["2026-03-02", "2026-03-03", "2026-03-04"];
    const session = await runLookSession({
      symbols: [{ symbol: "LKD", days: { [fridayBefore]: firstFileDay(), [firstDay]: { looks: looksAt(100, ["10:00"]), close: 100 }, [secondDay]: { looks: { "10:00": { price: 100 }, "10:30": { price: 88 }, "11:00": { price: 88 } }, close: 88 }, [thirdDay]: { looks: looksAt(88, ["10:00", "10:30"]), close: 88 } }, expiriesOn: marchExpiries }],
      plutoOverrides: { maxOpenPositions: 1, dailyLossBreakerPct: 0.3 },
    });
    expect(filledOn(session, firstDay)).toHaveLength(1);
    const tripped = dayOf(session, secondDay);
    expect(tripped.looksRun).toBe(1);
    expect(tripped.decisionSummary).toMatch(/daily-loss breaker tripped at 10:30: the account is -\d\.\d\d% from the previous close \(breaker at -0\.3%\), nothing more is done today/);
    expect(session.actions.filter((action) => action.tradingDate === secondDay && action.lookTimeEt !== "10:00")).toEqual([]);
    expect(session.detail.session.runStatistics!.dailyLossBreakerTripDates).toEqual([secondDay]);
    expect(session.detail.session.notes.some((note) => note.startsWith(`The daily-loss breaker (account down 0.3% or more from the previous close) tripped on 1 day(s): ${secondDay}.`))).toBe(true);
    // The third day is measured against the second day's close (the stock already at 88): both its looks run.
    expect(dayOf(session, thirdDay).looksRun).toBe(2);
    expect(dayOf(session, thirdDay).decisionSummary).not.toContain("daily-loss breaker");
  }, 60_000);

  it("bars new opens while SPY is down by the stress percentage, and still rolls", async () => {
    // One symbol holds a put from the first day (rolled the next morning, being near expiry); the other has cheap
    // quotes on the first day and rich ones on the second, when an open on it is Pluto's next choice after the roll.
    const [firstDay, secondDay] = ["2026-03-02", "2026-03-03"];
    const twoSymbols = (holder: string, other: string): LookSymbolSpec[] => [
      { symbol: holder, days: { [fridayBefore]: firstFileDay(), [firstDay]: { looks: looksAt(100, ["10:00"]), close: 100 }, [secondDay]: { looks: looksAt(100, ["10:00", "10:30", "11:00"]), close: 100 } }, expiriesOn: marchExpiries },
      { symbol: other, days: { [fridayBefore]: firstFileDay(), [firstDay]: { looks: looksAt(100, ["10:00"], { impliedVolatility: 0.15 }), close: 100 }, [secondDay]: { looks: looksAt(100, ["10:00", "10:30", "11:00"]), close: 100 } }, expiriesOn: marchExpiries },
    ];
    const describeDay = (session: LookSession) => filledOn(session, secondDay).map((action) => `${action.lookTimeEt} ${action.symbol} ${action.kind.startsWith("open_") ? "open" : action.kind}`);

    // Without SPY bars the check cannot run: the roll and the open both happen at 10:00, and the session says so.
    const unchecked = await runLookSession({ symbols: twoSymbols("LKE", "LKF"), overrides: {} });
    expect(describeDay(unchecked).slice(0, 2)).toEqual(["10:00 LKE roll", "10:00 LKF open"]);
    expect(unchecked.detail.session.runStatistics).toMatchObject({ marketStressLooks: 0, daysWithoutMarketStressBars: 3 });
    expect(unchecked.detail.session.notes).toContain("Market stress was not checked: the local DB holds no SPY 30-minute bars (npm run backtest:backfill-market-stress-bars).");

    // SPY closed the first day at 500; on the second it is at 480 at 10:00 (-4%), 482 at 10:30 (-3.6%), 498 at 11:00.
    await insertMarketBars("2026-02-26", { "15:30": 500 });
    await insertMarketBars(fridayBefore, { "09:30": 500, "15:30": 500 });
    await insertMarketBars(firstDay, { "09:30": 500, "15:30": 500 });
    await insertMarketBars(secondDay, { "09:30": 480, "10:00": 482, "10:30": 498 });
    const stressed = await runLookSession({ symbols: twoSymbols("LKG", "LKH"), overrides: {} });
    const actions = stressed.actions.filter((action) => action.tradingDate === secondDay);
    expect(actions.filter((action) => action.lookTimeEt !== "11:00").map((action) => `${action.lookTimeEt} ${action.symbol} ${action.kind} ${action.outcome}`)).toEqual(["10:00 LKG roll filled"]);
    // At 11:00 SPY is back above the line: the open that waited is sent (and the holder, its cooldown over, may open too).
    const atEleven = describeDay(stressed).filter((line) => line.startsWith("11:00"));
    expect(atEleven).toContain("11:00 LKH open");
    expect(atEleven.every((line) => line.endsWith(" open"))).toBe(true);
    expect(dayOf(stressed, secondDay).decisionSummary).toContain("market stress barred new opens at 10:00 (SPY -4.00%), 10:30 (SPY -3.60%) (at -3% or worse)");
    expect(stressed.detail.session.runStatistics).toMatchObject({ marketStressLooks: 2, marketStressDates: [secondDay], daysWithoutMarketStressBars: 0 });
    expect(stressed.detail.session.notes).toContain("Market stress (SPY down 3% or more on the day) barred new opens at 2 look(s) on 1 day(s).");
  }, 120_000);

  it("keeps buy and hold of SPY beside the session, for comparison: whole shares at SPY's 10:00 price on the first day", async () => {
    // SPY's 09:30 bars close at 410 on 6 April, 420 on the 7th and 400 on the 8th (bars stored before keep their days).
    const days = ["2026-04-06", "2026-04-07", "2026-04-08"];
    for (const [index, dateIso] of days.entries()) await insertMarketBars(dateIso, { "09:30": [410, 420, 400][index]!, "15:30": 405 });
    const session = await runLookSession({ symbols: [{ symbol: "LKS", days: Object.fromEntries(days.map((dateIso) => [dateIso, firstFileDay()])), expiriesOn: () => ["2026-04-17", "2026-04-24"] }] });
    const shares = Math.floor(startingValue / 410);
    const cashLeft = startingValue - shares * 410;
    const [first, second, third] = session.detail.days as [(typeof session.detail.days)[number], (typeof session.detail.days)[number], (typeof session.detail.days)[number]];
    expect(first.spyBaselineValue).toBeCloseTo(startingValue, 2);
    expect(first.spyBaselineDailyReturn).toBeNull();
    // Monday to Tuesday: one day of interest at 4% on the cash left over.
    const secondValue = cashLeft * (1 + 0.04 / 365) + shares * 420;
    expect(second.spyBaselineValue).toBeCloseTo(secondValue, 2);
    expect(second.spyBaselineDailyReturn).toBeCloseTo(secondValue / startingValue - 1, 8);
    expect(third.spyBaselineValue).toBeCloseTo(cashLeft * (1 + 0.04 / 365) ** 2 + shares * 400, 1);
    expect(session.detail.session.spyBaselineMetrics).toMatchObject({ startValue: startingValue, tradeCount: 0, winRate: null });
    expect(session.detail.session.spyBaselineMetrics!.endValue).toBeCloseTo(third.spyBaselineValue!, 1);
    expect(session.detail.session).toMatchObject({ spyBaselineLabel: "Buy and hold · SPY", baselineLabel: "Buy and hold · LKS", pnlBasis: "wheel_cycle" });
    expect(session.detail.monthlyReturns[0]!.spyBaselineReturn).toBeCloseTo(third.spyBaselineValue! / startingValue - 1, 8);
    expect(session.detail.session.notes).toContain(`Buy and hold of SPY (comparison only): ${shares.toLocaleString("en-US")} shares at 410.00 on 2026-04-06, SPY's price at 10:00, the rest in cash at the same interest; dividends not counted.`);
  }, 60_000);

  it("runs only the looks up to 30 minutes before a 13:00 close", async () => {
    // Wednesday 25 November 2026, Thanksgiving, and the Friday that closes at 13:00; every look of both days is stored.
    const [dayBefore, fullDay, holiday, earlyCloseDay] = ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
    const session = await runLookSession({
      symbols: [{ symbol: "LKI", days: { [dayBefore]: firstFileDay(), [fullDay]: { looks: looksAt(100, everyLookTime), close: 100 }, [earlyCloseDay]: { looks: looksAt(100, everyLookTime), close: 100 } }, holidays: [holiday], expiriesOn: () => ["2026-12-04", "2026-12-11"] }],
      plutoOverrides: { maxTickerExposurePct: 50 },
    });
    expect(session.detail.days.map((day) => `${day.tradingDate} ${day.looksRun}`)).toEqual([`${dayBefore} 1`, `${fullDay} 12`, `${earlyCloseDay} 6`]);
    // The full day: an order every second look until the order gate's ticker limit (20% of the account) is reached at
    // 13:00, then a refused attempt at each later look, the last one at 15:30.
    expect(filledOn(session, fullDay).map((action) => action.lookTimeEt)).toEqual(["10:00", "11:00", "12:00", "13:00"]);
    const refusedOn = (dateIso: string) => session.actions.filter((action) => action.tradingDate === dateIso && action.outcome === "blocked").map((action) => action.lookTimeEt);
    expect(refusedOn(fullDay)).toEqual(["14:00", "14:30", "15:00", "15:30"]);
    // The short day: Pluto tries at every look up to 12:30 and at none after it.
    expect(refusedOn(earlyCloseDay)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
    expect(session.actions.filter((action) => action.tradingDate === earlyCloseDay)).toHaveLength(6);
  }, 120_000);

  it("looks at a symbol without intraday quotes only at 10:00, and says so", async () => {
    const dateIso = "2026-03-02";
    const looks = looksAt(100, ["10:00", "10:30", "11:00", "11:30", "12:00"]);
    const session = await runLookSession({
      symbols: [
        { symbol: "LKJ", days: { [fridayBefore]: firstFileDay(), [dateIso]: { looks, close: 100 } }, expiriesOn: marchExpiries },
        { symbol: "LKK", days: { [fridayBefore]: firstFileDay(), [dateIso]: { looks, close: 100 } }, expiriesOn: marchExpiries, intradayQuotes: false },
      ],
      plutoOverrides: { maxTickerExposurePct: 20 },
    });
    expect(dayOf(session, dateIso).looksRun).toBe(5);
    const lookTimesOf = (symbol: string) => filledOn(session, dateIso).filter((action) => action.symbol === symbol).map((action) => action.lookTimeEt);
    // Both are opened at 10:00 (one pass each); only the symbol with intraday quotes is looked at again.
    expect(lookTimesOf("LKK")).toEqual(["10:00"]);
    expect(lookTimesOf("LKJ")).toEqual(["10:00", "11:00", "12:00"]);
    expect(session.actions.filter((action) => action.symbol === "LKK" && action.lookTimeEt !== "10:00")).toEqual([]);
    expect(session.detail.session.notes).toContain(describeDaysWithoutIntradayQuotes("LKK", 2, 2));
    expect(session.detail.session.notes.some((note) => note.startsWith("LKJ:"))).toBe(false);
  }, 60_000);

  it("closes a position before a macro event when the rule says so, and holds it when the rule is never", async () => {
    // A buy-write opened on Monday 8 June; on Tuesday the stock is at 104 and the position is in profit, one session
    // before CPI (Wednesday 08:30).
    const [firstDay, secondDay] = ["2026-06-08", "2026-06-09"];
    const days = { "2026-06-05": firstFileDay(), [firstDay]: { looks: looksAt(100, ["10:00"]), close: 100 }, [secondDay]: { looks: looksAt(104, ["10:00", "10:30"]), close: 104 } };
    const expiriesOn = () => ["2026-06-12", "2026-06-19"];
    const closing = await runLookSession({ symbols: [{ symbol: "LKL", days, expiriesOn }], plutoOverrides: { maxOpenPositions: 1 }, overrides: { policy: { roll: "never", buyback: "never", eventClose: "always" } } });
    const opened = filledOn(closing, firstDay);
    expect(opened.map((action) => action.kind)).toEqual(["open_covered_call"]);
    const closes = filledOn(closing, secondDay);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ kind: "close_position", lookTimeEt: "10:00", automatic: false, chosenBecause: "before a macro event: the rule is to close", positionIds: opened[0]!.positionIds });
    expect(closes[0]!.description).toContain("before the 10 Jun CPI (heavy, 1 session away)");
    // The whole position goes at the look's quotes: the call bought back at mid + half the half-spread, the shares sold a cent under the stock price.
    const buyback = closing.quotesAt("LKL", secondDay, "10:00").find((entry) => entry.expiry === opened[0]!.contract!.expiry && entry.strike === opened[0]!.contract!.strike && entry.right === "C")!;
    const stockPrice = computeParityStockPrice(closing.quotesAt("LKL", secondDay, "10:00"), secondDay, ratePercent / 100, maximumSpreadFractionOfMid)!.price;
    const closingFills = closing.fills.filter((fill) => fill.actionId === closes[0]!.actionId);
    expect(closingFills.map((fill) => `${fill.instrument} ${fill.side}`).sort()).toEqual(["option buy", "stock sell"]);
    expect(closingFills.find((fill) => fill.instrument === "option")!.price).toBeCloseTo((buyback.bid! + buyback.ask!) / 2 + (0.5 * (buyback.ask! - buyback.bid!)) / 2, 6);
    expect(closingFills.find((fill) => fill.instrument === "stock")!.price).toBeCloseTo(stockPrice - 0.01, 3);
    expect(closing.detail.trades[0]).toMatchObject({ endedBy: "bought_back", settledOn: secondDay });

    const holding = await runLookSession({ symbols: [{ symbol: "LKM", days, expiriesOn }], plutoOverrides: { maxOpenPositions: 1 }, overrides: { policy: { roll: "never", buyback: "never", eventClose: "never" } } });
    expect(filledOn(holding, secondDay)).toEqual([]);
    expect(dayOf(holding, secondDay).decisionSummary).toContain("before a macro event: the rule is never to close for events");
    expect(holding.detail.trades[0]).toMatchObject({ endedBy: null });
  }, 120_000);
});

describe("a session scored on worker threads", () => {
  it("stores exactly what the same session scored on one thread stores", async () => {
    // Three symbols on one book over three days, two of them with looks after 10:00 at moving prices, so the symbols
    // compete for the budget, are re-scored after each other's fills and see their own positions.
    const days = ["2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09"];
    const symbolsOf = (prefix: string): LookSymbolSpec[] =>
      [
        { suffix: "A", prices: [100, 98, 101, 97], impliedVolatility: 0.6 },
        { suffix: "B", prices: [50, 51, 49, 52], impliedVolatility: 0.7 },
        { suffix: "C", prices: [200, 204, 199, 202], impliedVolatility: 0.55 },
      ].map(({ suffix, prices, impliedVolatility }) => ({
        symbol: `${prefix}${suffix}`,
        days: Object.fromEntries(days.map((dateIso, index) => [dateIso, index === 0 ? firstFileDay(prices[0]) : { looks: { "10:00": { price: prices[index]!, impliedVolatility }, "10:30": { price: prices[index]! * 0.99, impliedVolatility }, "11:00": { price: prices[index]! * 1.01, impliedVolatility } }, close: prices[index]! }])),
        expiriesOn: () => ["2026-04-10", "2026-04-17", "2026-04-24"],
      }));
    const runWith = async (prefix: string, scoringWorkers: number) => {
      const session = await runLookSession({ symbols: symbolsOf(prefix), overrides: {}, plutoOverrides: { maxTickerExposurePct: 15 }, scoringWorkers });
      // The same session under other symbol names, with the stored rows' serial ids: compare without them.
      const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => (key === "id" && typeof entry === "number" ? undefined : entry)).replaceAll(new RegExp(`${prefix}([ABC])`, "g"), "SYM$1"));
      const { session: sessionRow, ...detail } = session.detail;
      const { id: _id, name: _name, createdAt: _createdAt, finishedAt: _finishedAt, ...sessionFields } = sessionRow as unknown as Record<string, unknown>;
      return strip({ sessionFields, detail, actions: session.actions, fills: session.fills });
    };
    const oneThread = await runWith("LWA", 0);
    const workers = await runWith("LWB", 3);
    expect(oneThread.actions.filter((action: { outcome: string }) => action.outcome === "filled").length).toBeGreaterThan(3);
    expect(workers).toEqual(oneThread);
  }, 120_000);
});

/** What the stand-in for Claude was asked: the masked payload as the CLI would get it. */
interface FakeClaudeCall {
  input: ClaudeSubscriptionCallInput;
  payload: { as_of: string; trigger: { kind: string }; tickers: { symbol: string; candidates?: { id: string; kind: string }[]; rolls?: { id: string }[]; close_actions?: { id: string }[] }[] };
}

type FakeClaudeAnswer = { verdict: "trade"; confidence?: number; reason?: string } | { verdict: "no_trade"; reason?: string } | { verdict: "invalid" } | { verdict: "usage_limit" };

/** A stand-in for the Claude CLI: answers each call as `answerFor` says; a trade names the first candidate of the first ticker that has one (no trade when none has). */
function fakeClaude(answerFor: (call: FakeClaudeCall, callNumber: number) => FakeClaudeAnswer): { callModel: ClaudeCall; calls: FakeClaudeCall[] } {
  const calls: FakeClaudeCall[] = [];
  const callModel: ClaudeCall = async (input) => {
    const call: FakeClaudeCall = { input, payload: JSON.parse(input.userPayload) };
    calls.push(call);
    const answer = answerFor(call, calls.length);
    const result: Omit<ClaudeSubscriptionCallResult, "ok" | "rawText" | "error" | "usageLimitReached" | "failureKind"> = { servedModelId: "claude-sonnet-test", latencyMs: 5, tokensIn: 100, tokensOut: 20, costUsd: 0, serviceTier: null, httpStatus: null };
    if (answer.verdict === "usage_limit") return { ...result, ok: false, rawText: null, error: "Claude AI usage limit reached|1760000000", usageLimitReached: true, failureKind: "usage_limit" };
    if (answer.verdict === "invalid") return { ...result, ok: true, rawText: "I would sell the put.", error: null, usageLimitReached: false, failureKind: null };
    const chosenId = call.payload.tickers.flatMap((ticker) => ticker.candidates ?? [])[0]?.id ?? null;
    const decision =
      answer.verdict === "trade" && chosenId !== null
        ? { decision: "trade", action_kind: kindFromCandidateId(chosenId!), candidate_id: chosenId, confidence: answer.confidence ?? 0.9, reasons: [answer.reason ?? "test: the first candidate"], risks_acknowledged: [], system_concerns: [] }
        : { decision: "no_trade", action_kind: null, candidate_id: null, confidence: 0.8, reasons: [answer.reason ?? "test: nothing worth it"], risks_acknowledged: [], system_concerns: [] };
    return { ...result, ok: true, rawText: JSON.stringify(decision), error: null, usageLimitReached: false, failureKind: null };
  };
  return { callModel, calls };
}

describe("a session with the AI model as decision maker", () => {
  // A week no other test stores SPY bars for: market stress is not checked.
  const [fridayBeforeMonday, monday, tuesday] = ["2026-03-06", "2026-03-09", "2026-03-10"];
  // The cache answers any question asked before, and masked symbols look alike: each test prices its stock differently
  // so that its questions are its own.
  const llmSymbol = (symbol: string, price: number, mondayLooks: string[], tuesdayLooks: string[] | null = null): LookSymbolSpec => ({
    symbol,
    days: { [fridayBeforeMonday]: firstFileDay(price), [monday]: { looks: looksAt(price, mondayLooks), close: price }, ...(tuesdayLooks ? { [tuesday]: { looks: looksAt(price, tuesdayLooks), close: price } } : {}) },
    expiriesOn: marchExpiries,
  });
  const lookTimeOf = (call: FakeClaudeCall) => new Date(call.payload.as_of).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
  const llmCallRows = async (sessionId: string) =>
    (await testDb("backtest_session_llm_calls").where({ session_id: sessionId }).orderBy("sequence").select("sequence", "look_time", "cache_hit", "outcome", "error", "decision", testDb.raw("trading_date::text as trading_date"))) as {
      sequence: number;
      look_time: string;
      cache_hit: boolean;
      outcome: string;
      error: string | null;
      decision: { decision: string; candidateId: string | null } | null;
      trading_date: string;
    }[];

  it("asks at the day's first look, again right after a fill and when a cooldown ends, and trades the candidate the model names", async () => {
    const claude = fakeClaude((_call, callNumber) => (callNumber === 1 ? { verdict: "trade", reason: "test: the richest put" } : { verdict: "no_trade" }));
    const session = await runLookSession({ symbols: [llmSymbol("LMA", 100, ["10:00", "10:30", "11:00", "11:30"])], overrides: { decisionMaker: "llm" }, callModel: claude.callModel });
    expect(session.detail.session.status).toBe("succeeded");

    // The model sees every symbol masked and every date 1,044 weeks later, with Pluto's own system prompt and call timeout.
    const masking = (await testDb("backtest_sessions").where({ id: session.sessionId }).first("llm_masking")).llm_masking as PlutoPromptMasking;
    expect(masking).toEqual({ aliasBySymbol: { LMA: "STOCK_A" }, dateShiftWeeks: 1044 });
    for (const call of claude.calls) {
      expect(call.input.userPayload).not.toMatch(/LMA|2026-0[23]-/);
      expect(call.input.systemPrompt).toBe(buildPlutoSystemPrompt(fixtureBacktestSettings().pluto));
      // Outside every project: inside the repo the CLI would read the project's CLAUDE.md and memory into every call.
      expect(call.input).toMatchObject({ timeoutSeconds: 90, workingDirectory: path.join(tmpdir(), "iorio-backtest-llm-workdir") });
      expect(path.relative(process.cwd(), call.input.workingDirectory).startsWith("..")).toBe(true);
    }
    expect(existsSync(path.join(tmpdir(), "iorio-backtest-llm-workdir"))).toBe(true);

    // Friday: nothing can be sold on the file's first day, so the opening analysis offers nothing and the model is not asked.
    expect(dayOf(session, fridayBeforeMonday).decisionSummary).toBe("No action: opening analysis: not asked, nothing eligible after the deterministic filters");
    // Monday 10:00: the opening analysis, a forced round: the model names a candidate and the put is sold.
    const [opening, afterFill] = claude.calls as [FakeClaudeCall, FakeClaudeCall];
    expect([opening.payload.trigger.kind, lookTimeOf(opening)]).toEqual(["opening_analysis", "10:00"]);
    const chosenId = unmaskPlutoText(opening.payload.tickers[0]!.candidates![0]!.id, masking);
    const filled = filledOn(session, monday);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ lookTimeEt: "10:00", passNumber: 1, candidateId: chosenId, chosenBecause: "test: the richest put", automatic: false });
    expect(filled[0]!.gateResults.find((gate) => gate.gate === "confidence_floor")).toEqual({ gate: "confidence_floor", ok: true, detail: "0.90 vs floor 0.6" });
    // Right after the fill, a forced "order_ended" round: the ticker is cooling down (no opens), its new put can be rolled.
    expect([afterFill.payload.trigger.kind, lookTimeOf(afterFill)]).toEqual(["order_ended", "10:00"]);
    expect(afterFill.payload.tickers[0]!.candidates).toBeUndefined();
    // The ticker's cooldown after the fill ends at 11:00: a forced round over it; the look's own round then finds nothing
    // changed since that call and does not ask.
    const atEleven = claude.calls.filter((call) => lookTimeOf(call) === "11:00");
    expect(atEleven.map((call) => call.payload.trigger.kind)).toEqual(["cooldown_ended"]);
    expect(atEleven[0]!.payload.tickers[0]!.candidates!.length).toBeGreaterThan(0);

    // Every call is logged on the session in real symbols, and counted in the run's statistics.
    const rows = await llmCallRows(session.sessionId);
    expect(rows.map((row) => row.sequence)).toEqual(claude.calls.map((_call, index) => index + 1));
    expect(rows.map((row) => row.look_time)).toEqual(claude.calls.map(lookTimeOf));
    expect(rows.every((row) => row.outcome === "decided" && !row.cache_hit && row.trading_date === monday)).toBe(true);
    expect(rows[0]!.decision).toMatchObject({ decision: "trade", candidateId: chosenId });
    expect(session.detail.session.runStatistics!.llmCalls).toEqual({ asked: claude.calls.length, fromCache: 0 });
    expect(session.detail.session.notes).toContain(`Decisions by Claude (sonnet, medium effort) through the subscription, as live Pluto asks its model: ${claude.calls.length} decision(s) asked, 0 answered from the cache. The model saw LMA as STOCK_A, every date 1044 weeks later. The decision rules (roll, buyback, shares in profit, closes before macro events, after a refused choice) do not apply.`);
  }, 60_000);

  it("asks over every ticker after a fill, before the look's own round, and otherwise only when a ticker's candidates changed and its model cooldown is over", async () => {
    // A 45-minute model cooldown: the 10:30 look's round does not ask about a ticker the model saw at 10:00. The model
    // trades at the opening analysis and when the bought ticker's cooldown ends.
    const claude = fakeClaude((call) => (call.payload.trigger.kind === "opening_analysis" || call.payload.trigger.kind === "cooldown_ended" ? { verdict: "trade" } : { verdict: "no_trade" }));
    const session = await runLookSession({
      symbols: [llmSymbol("LMB", 100, ["10:00", "10:30", "11:00"]), llmSymbol("LMC", 100, ["10:00", "10:30", "11:00"])],
      plutoOverrides: { perTickerModelCooldownMinutes: 45 },
      overrides: { decisionMaker: "llm" },
      callModel: claude.callModel,
    });
    expect(claude.calls.map((call) => `${lookTimeOf(call)} ${call.payload.trigger.kind} ${call.payload.tickers.map((ticker) => ticker.symbol).join(",")}`)).toEqual([
      "10:00 opening_analysis STOCK_A,STOCK_B",
      // The fill's forced round covers both tickers, whatever changed.
      "10:00 order_ended STOCK_A,STOCK_B",
      // 10:30: both seen at 10:00, 30 minutes ago: no call. 11:00: the bought ticker's cooldown after the fill is over
      // (forced, over it alone) and it is bought again; the fill's forced round comes before the look's own round, which
      // then finds nothing changed since and does not ask.
      "11:00 cooldown_ended STOCK_A",
      "11:00 order_ended STOCK_A,STOCK_B",
    ]);
    expect(filledOn(session, monday).map((action) => `${action.lookTimeEt} ${action.symbol}`)).toEqual(["10:00 LMB", "11:00 LMB"]);
  }, 60_000);

  it("refuses a trade below the confidence floor, and the next call sees the refusal among the recent decisions", async () => {
    const claude = fakeClaude(() => ({ verdict: "trade", confidence: 0.3, reason: "test: unsure" }));
    const session = await runLookSession({ symbols: [llmSymbol("LMD", 101, ["10:00"], ["10:00"])], overrides: { decisionMaker: "llm" }, callModel: claude.callModel });
    expect(session.fills).toEqual([]);
    // One decision a round: the refused choice ends it, nothing else is chosen in its place.
    expect(session.actions.map((action) => `${action.tradingDate} ${action.lookTimeEt} ${action.outcome}`)).toEqual([`${monday} 10:00 blocked`, `${tuesday} 10:00 blocked`]);
    for (const action of session.actions) {
      expect(action.chosenBecause).toBe("test: unsure");
      expect(action.kind).toMatch(/^open_/);
      expect(action.gateResults.find((gate) => gate.gate === "confidence_floor")).toEqual({ gate: "confidence_floor", ok: false, detail: "0.30 vs floor 0.6" });
      expect(action.blockReason).toContain("confidence_floor: 0.30 vs floor 0.6");
    }
    // Tuesday's call carries Monday's decision and what came of it (masked like the rest).
    const tuesdayCall = claude.calls[1]!;
    expect(tuesdayCall.payload.trigger.kind).toBe("opening_analysis");
    expect((tuesdayCall.payload as unknown as { recent_decisions: unknown[] }).recent_decisions).toEqual([
      expect.objectContaining({ verdict: "trade", candidate_id: claude.calls[0]!.payload.tickers[0]!.candidates![0]!.id, outcome: "blocked", outcome_detail: expect.stringContaining("confidence_floor"), reason: "test: unsure" }),
    ]);
  }, 60_000);

  it("takes no action on an answer it cannot read or on a no-trade, and says why", async () => {
    const claude = fakeClaude((_call, callNumber) => (callNumber === 1 ? { verdict: "invalid" } : { verdict: "no_trade", reason: "test: premiums too thin" }));
    const session = await runLookSession({ symbols: [llmSymbol("LME", 102, ["10:00"], ["10:00"])], overrides: { decisionMaker: "llm" }, callModel: claude.callModel });
    expect(session.actions).toEqual([]);
    expect(dayOf(session, monday).decisionSummary).toMatch(/^No action: opening analysis: the model's answer could not be read \(invalid decision: not JSON: /);
    expect(dayOf(session, tuesday).decisionSummary).toBe("No action: opening analysis: the model chose no trade: test: premiums too thin");
    expect((await llmCallRows(session.sessionId)).map((row) => [row.trading_date, row.outcome])).toEqual([
      [monday, "invalid_answer"],
      [tuesday, "decided"],
    ]);
  }, 60_000);

  it("stops on the plan's usage limit; run again, it answers the calls made before from the cache and asks only the rest", async () => {
    const spec: LookSessionSpec = { symbols: [llmSymbol("LMF", 103, ["10:00"], ["10:00"])], overrides: { decisionMaker: "llm" } };
    const { sessionId, quotesBySymbol } = await createLookSession(spec);
    const limited = fakeClaude((_call, callNumber) => (callNumber === 1 ? { verdict: "no_trade" } : { verdict: "usage_limit" }));
    await expect(runBacktestSession(sessionId, { ...hooks, callModel: limited.callModel })).rejects.toThrow("Claude usage limit reached: resume the session later; answered calls are cached. (Claude AI usage limit reached|1760000000)");
    expect((await llmCallRows(sessionId)).map((row) => [row.trading_date, row.outcome, row.cache_hit])).toEqual([
      [monday, "decided", false],
      [tuesday, "usage_limit", false],
    ]);

    // A resumed job runs the session again from its first day: Monday's question is the same, answered from the cache;
    // Tuesday's is asked (a trade, then the forced round after its fill).
    const resumed = fakeClaude((_call, callNumber) => (callNumber === 1 ? { verdict: "trade" } : { verdict: "no_trade" }));
    await runBacktestSession(sessionId, { ...hooks, callModel: resumed.callModel });
    const maskedTuesday = maskPlutoText(tuesday, { aliasBySymbol: {}, dateShiftWeeks: 1044 });
    expect(resumed.calls.map((call) => `${call.payload.as_of.slice(0, 10)} ${lookTimeOf(call)} ${call.payload.trigger.kind}`)).toEqual([`${maskedTuesday} 10:00 opening_analysis`, `${maskedTuesday} 10:00 order_ended`]);
    expect((await llmCallRows(sessionId)).map((row) => [row.trading_date, row.outcome, row.cache_hit])).toEqual([
      [monday, "decided", true],
      [tuesday, "decided", false],
      [tuesday, "decided", false],
    ]);
    const session = await readLookSession(sessionId, quotesBySymbol);
    expect(session.detail.session.runStatistics!.llmCalls).toEqual({ asked: 3, fromCache: 1 });
    expect(filledOn(session, tuesday)).toHaveLength(1);
  }, 60_000);
});
