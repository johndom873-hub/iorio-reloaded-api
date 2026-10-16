import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { maximumSpreadFractionOfMid } from "../../lib/impliedVolatilitySurface.js";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import { backtestTickerBaselineKeys, defaultBacktestBaselineSettings, type BacktestAction, type BacktestBaselineSettings, type BacktestFill, type BacktestSessionDetail, type BacktestSettingsOverrides, type BacktestSymbolSettings } from "../backtestTypes.js";
import { computeParityStockPrice } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween, writeSyntheticIbkrBarsFromQuotes, writeSyntheticSymbolFile, writeSyntheticMacroEventHistory } from "./testSupport/syntheticBacktestData.js";
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
const { loadBacktestSessionActions, loadBacktestSessionDetail, loadBacktestSessionFills } = await import("../jobs/backtestSessionStore.js");
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
  writeSyntheticMacroEventHistory(dataDirectory);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
  if (previousDataDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
  else process.env.BACKTEST_DATA_DIR = previousDataDirectory;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("a session through the wheel", () => {
  it("sells a put, rolls it, takes the assignment, sells a call on the shares and is called away", async () => {
    // The stock slides from 100 to 95.40 at the 24 April close, then recovers to 101 at the 1 May close. Ticker room for
    // one 5-contract position, so nothing else is opened beside it.
    const fileDates = weekdaysBetween("2026-04-06", "2026-05-04");
    //                        6     7      8     9     10    13    14    15    16    17    20    21    22    23    24    27    28    29    30    1      4
    const tenOClockPrices = [100, 100.2, 99.8, 99.5, 99.0, 98.6, 98.2, 97.8, 97.4, 97.0, 96.6, 96.2, 95.8, 95.6, 95.5, 96.5, 97.5, 98.5, 99.5, 100.5, 101];
    const closes = /*     */ [100.1, 100, 99.6, 99.2, 98.8, 98.4, 98.0, 97.6, 97.2, 96.8, 96.4, 96.0, 95.7, 95.5, 95.4, 97.0, 98.0, 99.0, 100, 101, 101];
    const session = await runWheelSession({
      symbol: "WHLA",
      fileDates,
      lastSessionDate: "2026-05-04",
      tenOClockPrices,
      closes,
      expiriesOn: (dateIso) => (dateIso < "2026-04-24" ? ["2026-04-17", "2026-04-24"] : dateIso < "2026-05-01" ? ["2026-04-24", "2026-05-01"] : ["2026-05-01", "2026-05-08"]),
      plutoOverrides: { maxTickerPctOfBudget: 10 },
    });
    const { detail } = session;
    expect(detail.session.status).toBe("succeeded");
    expectAccountToReconcile(session);

    // What was done, in order: the put on the 7th, its roll the next day (near expiry, a later put for a credit), the
    // call code sold on the assigned shares at the next session (the highest premium yield whose strike reaches the
    // cycle break-even), and a new position after the shares were called away.
    const filled = filledActionsOf(session);
    expect(filled.map((action) => `${action.tradingDate} ${action.kind}`)).toEqual(["2026-04-07 open_cash_secured_put", "2026-04-08 roll", "2026-04-27 open_covered_call", "2026-05-04 open_covered_call"]);
    const [openPut, roll, callOnShares, nextCycleOpen] = filled as [(typeof filled)[number], (typeof filled)[number], (typeof filled)[number], (typeof filled)[number]];
    expect(openPut).toMatchObject({ quantity: 5, contract: { strategyKey: "cash_secured_put", expiry: "2026-04-17", strike: 98, right: "P" }, chosenBecause: "Pluto's top pick by Edge Yield" });
    expect(roll).toMatchObject({ quantity: 5, contract: { strategyKey: "cash_secured_put", expiry: "2026-04-24", strike: 97, right: "P", fromStrike: 98, fromExpiry: "2026-04-17" }, chosenBecause: "the best eligible roll on a leg flagged near expiry" });
    expect(callOnShares).toMatchObject({ quantity: 5, automatic: true, contract: { strategyKey: "covered_call", expiry: "2026-05-01", strike: 97, right: "C" } });
    expect(callOnShares.chosenBecause).toMatch(/^code sells calls on held shares: the highest premium yield, \d+% a year; if called away the cycle ends \$\d+$/);
    expect(callOnShares.description).toContain("on 500 held shares");
    expect(nextCycleOpen.description).toContain("with 500 shares bought @");

    const firstPut = quoteOf(session, "2026-04-07", "2026-04-17", 98, "P");
    const firstPutBuyback = quoteOf(session, "2026-04-08", "2026-04-17", 98, "P");
    const rolledPut = quoteOf(session, "2026-04-08", "2026-04-24", 97, "P");
    const call = quoteOf(session, "2026-04-27", "2026-05-01", 97, "C");
    expect(openPut.fillPrice).toBeCloseTo(firstPut.saleFill, 8);
    expect(roll.fillPrice).toBeCloseTo(rolledPut.saleFill, 8);
    expect(callOnShares.fillPrice).toBeCloseTo(call.saleFill, 8);

    // The settlements, in the next session's summary.
    expect(dayOf(session, "2026-04-27").decisionSummary).toContain("$97 Put · 24 Apr assigned at the 95.40 close: 500 shares bought at the strike");
    expect(dayOf(session, "2026-05-04").decisionSummary).toContain("$97 Call · 1 May assigned at the 101.00 close: 500 shares called away at the strike");

    // The first wheel cycle, by hand: the roll's cost, the second put's premium, the call's premium, and 500 shares put
    // at 97 and called away at 97. Five sessions from the assignment (24 April) to the close (1 May).
    const rollCost = (firstPut.saleFill - firstPutBuyback.purchaseFill) * 500 - 2 * 5 * commissionPerContract;
    const putPremium = rolledPut.saleFill * 500 - 5 * commissionPerContract;
    const callPremium = call.saleFill * 500 - 5 * commissionPerContract;
    const cycleTotal = rollCost + putPremium + callPremium + (97 - 97) * 500;
    expect(detail.cycles).toHaveLength(2);
    const [cycle, nextCycle] = detail.cycles as [(typeof detail.cycles)[number], (typeof detail.cycles)[number]];
    expect(cycle).toMatchObject({ symbol: "WHLA", cycleNumber: 1, status: "closed", openedOn: "2026-04-07", assignedOn: "2026-04-24", closedOn: "2026-05-01", closedAt: "2026-05-01T20:00:00.000Z", recoverySessions: 5, ageSessions: null, sharesHeld: 0, dataFlags: [] });
    expect(cycle.totalDollars).toBeCloseTo(cycleTotal, 2);
    expect(cycle.netPremiumDollars).toBeCloseTo(rollCost + putPremium + callPremium, 2);
    expect(cycle.buckets.csp.premium).toBeCloseTo(rollCost + putPremium, 2);
    expect(cycle.buckets.cc.premium).toBeCloseTo(callPremium, 2);
    // The put's bucket carries the shares' loss to the assignment close; the shares' buckets what they did after it.
    expect(cycle.buckets.csp.stock).toBeCloseTo((95.4 - 97) * 500, 2);
    expect(cycle.buckets.unstructured.stock + cycle.buckets.cc.stock).toBeCloseTo((97 - 95.4) * 500, 2);
    expect(nextCycle).toMatchObject({ cycleNumber: 2, status: "open", openedOn: "2026-05-04", assignedOn: null, recoverySessions: null, ageSessions: 0, sharesHeld: 500 });

    // The book behind it.
    const [putPosition, rolledPosition, sharesPosition, coveredCall, nextPosition] = detail.positions as [(typeof detail.positions)[number], (typeof detail.positions)[number], (typeof detail.positions)[number], (typeof detail.positions)[number], (typeof detail.positions)[number]];
    expect(detail.positions).toHaveLength(5);
    expect(putPosition).toMatchObject({ strategyKey: "cash_secured_put", status: "closed", closeReason: "closed_via_app", closedAt: "2026-04-08T14:00:00.000Z" });
    expect(putPosition.realizedPnlDollars).toBeCloseTo(rollCost, 2);
    expect(rolledPosition).toMatchObject({ strategyKey: "cash_secured_put", status: "closed", closeReason: "assigned", closedAt: "2026-04-24T20:00:00.000Z" });
    expect(rolledPosition.legs[0]).toMatchObject({ optionType: "put", strike: 97, expiry: "2026-04-24", quantity: 5, settledAs: "assigned", expiryClose: 95.4, exitPrice: 0, dteAtEntry: 16 });
    expect(rolledPosition.realizedPnlDollars).toBeCloseTo(putPremium, 2);
    expect(sharesPosition).toMatchObject({ strategyKey: "unstructured", unstructuredReason: "csp_assigned_stock", status: "closed", closeReason: "stock_rolled_into_covered_call", openedAt: "2026-04-24T20:00:00.000Z", shareSourcePositionIds: [rolledPosition.positionId], realizedPnlDollars: 0 });
    expect(sharesPosition.legs[0]).toMatchObject({ legType: "stock", quantity: 500, entryPrice: 97, exitPrice: 97 });
    expect(coveredCall).toMatchObject({ strategyKey: "covered_call", status: "closed", closeReason: "assigned", closedAt: "2026-05-01T20:00:00.000Z", shareSourcePositionIds: [sharesPosition.positionId], realizedStockPnlDollars: 0 });
    expect(coveredCall.realizedPremiumPnlDollars).toBeCloseTo(callPremium, 2);
    expect(coveredCall.legs.find((leg) => leg.legType === "stock")).toMatchObject({ quantity: 500, entryPrice: 97, exitPrice: 97, exitAt: "2026-05-01T20:00:00.000Z" });
    expect(coveredCall.legs.find((leg) => leg.legType === "option")).toMatchObject({ optionType: "call", strike: 97, settledAs: "assigned", expiryClose: 101, dteAtEntry: 4 });
    expect(nextPosition).toMatchObject({ strategyKey: "covered_call", status: "open" });
    expect(callOnShares.positionIds).toEqual([coveredCall.positionId]);
    expect(roll.positionIds).toEqual([putPosition.positionId, rolledPosition.positionId]);

    // Fills: the shares came in at the strike with no commission, the call on them bought no share, and the call-away
    // has no stock trade (the shares leave at the strike).
    expect(session.fills.filter((fill) => fill.actionId === null)).toEqual([expect.objectContaining({ instrument: "stock", side: "buy", quantity: 500, price: 97, commissionDollars: 0, executedAt: "2026-04-24T20:00:00.000Z", positionId: sharesPosition.positionId })]);
    expect(session.fills.filter((fill) => fill.actionId === callOnShares.actionId).map((fill) => `${fill.instrument} ${fill.side}`)).toEqual(["option sell"]);
    expect(session.fills.filter((fill) => fill.actionId === roll.actionId).map((fill) => `${fill.instrument} ${fill.side} ${fill.isClosing}`)).toEqual(["option buy true", "option sell false"]);
    expect(session.fills.filter((fill) => fill.positionId === coveredCall.positionId && fill.instrument === "stock")).toEqual([]);

    // One row per option sold, with how it ended, its position's P&L and its wheel cycle (no P&L of its own).
    expect(detail.trades.map((trade) => `${trade.openedOn} ${trade.optionRight}${trade.strike} ${trade.endedBy} ${trade.settledOn}`)).toEqual(["2026-04-07 P98 rolled 2026-04-08", "2026-04-08 P97 assigned 2026-04-24", "2026-04-27 C97 assigned 2026-05-01", "2026-05-04 C103 null null"]);
    expect(detail.trades.map((trade) => [trade.pnlDollars, trade.cycleLabel, trade.cycleStatus])).toEqual([
      [null, "WHLA #1", "closed"],
      [null, "WHLA #1", "closed"],
      [null, "WHLA #1", "closed"],
      [null, "WHLA #2", "open"],
    ]);
    for (const trade of detail.trades.slice(0, 3)) expect(trade.cycleTotalDollars).toBeCloseTo(cycleTotal, 2);
    expect(detail.trades[0]!.positionPnlDollars).toBeCloseTo(rollCost, 2);
    expect(detail.trades[1]!.positionPnlDollars).toBeCloseTo(putPremium, 2);
    expect(detail.trades[1]).toMatchObject({ settlementClose: 95.4, inTheMoneyAtExpiry: true, legId: rolledPosition.legs[0]!.legId, positionId: rolledPosition.positionId, positionStatus: "closed" });
    expect(detail.trades[2]!.positionPnlDollars).toBeCloseTo(callPremium, 2);

    // The account on the last day, flat at its mark: the start, the interest and the closed cycle.
    const lastDay = detail.days.at(-1)!;
    expect(lastDay.cash).toBeCloseTo(lastDay.accountValue, 2);
    expect(lastDay.accountValue).toBeCloseTo(startingValue + totalInterest(session) + cycleTotal, 1);

    // The per-ticker statistics.
    expect(detail.tickerStatistics).toHaveLength(1);
    const statistics = detail.tickerStatistics[0]!;
    expect(statistics).toMatchObject({ symbol: "WHLA", optionSaleCount: 4, averageTradedDte: (10 + 16 + 4 + 4) / 4, putPositionCount: 2, putPositionsEnded: 2, putPositionsAssigned: 1, putAssignedShare: 0.5, closedCycleCount: 1, openCycleCount: 1, recoverySessions: { count: 1, mean: 5, median: 5, longest: 5 } });
    expect(statistics.realizedPnlDollars).toBeCloseTo(cycleTotal, 2);
    expect(statistics.totalPnlDollars).toBeCloseTo(cycleTotal + nextCycle.totalDollars, 2);
    expect(statistics.openCycles).toEqual([{ symbol: "WHLA", cycleNumber: 2, openedOn: "2026-05-04", assignedOn: null, ageSessions: 0, totalDollars: nextCycle.totalDollars, sharesHeld: 500 }]);
    expect(detail.allSymbolsStatistics).toEqual({ ...statistics, symbol: "All symbols" });
    expect(detail.trades.every((trade) => trade.symbol === "WHLA")).toBe(true);
    expect(detail.session).toMatchObject({ symbol: "WHLA", symbols: ["WHLA"] });

    // Blocked attempts are kept with the gate that refused them: the ticker had no room for a second position.
    const blocked = session.actions.filter((action) => action.outcome === "blocked");
    expect(detail.bookCounts).toEqual({ filledActions: filled.length, blockedActions: blocked.length, fills: session.fills.length });
    expect(session.actions.map((action) => Number(action.actionId.replace("action-", "")))).toEqual(session.actions.map((_, index) => index + 1));
    expect(session.fills.map((fill) => fill.tradingDate)).toEqual(session.fills.map((fill) => (fill.actionId === null ? "2026-04-24" : session.actions.find((action) => action.actionId === fill.actionId)!.tradingDate)));
    expect(blocked.length).toBeGreaterThan(5);
    for (const action of blocked) {
      expect(action.blockReason).toMatch(/^sizing: /);
      expect(action.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
      expect(action).toMatchObject({ fillPrice: null, automatic: false });
    }
  }, 60_000);

  it("buys a put back when holding no longer pays, and code sells a call on the assigned shares at the next session", async () => {
    // Options trade at 15% volatility on 8 and 21 April (against a 25% forecast) and at 60% otherwise: on the 8th the
    // put sold the day before is worth less than holding it pays. The shares assigned on the 17th get a call from code on
    // the 20th, whatever its edge (Marcelo 2026-10-12): selling the shares (P1) is for when no call clears Pluto's rules.
    const fileDates = weekdaysBetween("2026-04-06", "2026-04-22");
    //                        6     7      8      9     10    13    14    15    16    17    20    21    22
    const tenOClockPrices = [100, 100.2, 100.6, 100.4, 99.6, 98.8, 98.2, 97.8, 97.4, 97.2, 97.6, 99.0, 99.2];
    const closes = /*     */ [100.1, 100.4, 100.5, 100, 99.2, 98.5, 98.0, 97.6, 97.3, 97.0, 98.4, 99.1, 99.3];
    const session = await runWheelSession({
      symbol: "WHLB",
      fileDates,
      lastSessionDate: "2026-04-22",
      tenOClockPrices,
      closes,
      expiriesOn: (dateIso) => (dateIso < "2026-04-17" ? ["2026-04-17"] : ["2026-04-17", "2026-04-24", "2026-05-01"]),
      impliedVolatilityOn: { "2026-04-08": 0.15, "2026-04-21": 0.15 },
      plutoOverrides: { maxTickerPctOfBudget: 10 },
    });
    const { detail } = session;
    expectAccountToReconcile(session);

    const filled = filledActionsOf(session);
    expect(filled.map((action) => `${action.tradingDate} ${action.kind}`)).toEqual(["2026-04-07 open_cash_secured_put", "2026-04-08 close_leg", "2026-04-09 open_cash_secured_put", "2026-04-20 open_covered_call"]);
    const [, buyback, secondPutOpen, callOnShares] = filled as [(typeof filled)[number], (typeof filled)[number], (typeof filled)[number], (typeof filled)[number]];

    // The buyback: offered because holding no longer pays, taken by the rule, filled at mid + λ × half-spread.
    const firstPut = quoteOf(session, "2026-04-07", "2026-04-17", 98, "P");
    const firstPutBuyback = quoteOf(session, "2026-04-08", "2026-04-17", 98, "P");
    expect(buyback).toMatchObject({ automatic: false, quantity: 5, chosenBecause: "holding the put no longer pays its closing cost", contract: { strategyKey: "cash_secured_put", expiry: "2026-04-17", strike: 98, right: "P" } });
    expect(buyback.fillPrice).toBeCloseTo(firstPutBuyback.purchaseFill, 8);
    expect(buyback.gateResults.map((gate) => gate.gate)).toEqual(["verdict", "confidence_floor", "offer_fresh", "working_order", "close_gate"]);
    expect(dayOf(session, "2026-04-08").decisionSummary).toMatch(/^Closed WHLB Buy back \$98 Put · 17 Apr \(9DTE\) · 5× @ /);
    const buybackProfit = (firstPut.saleFill - firstPutBuyback.purchaseFill) * 500 - 2 * 5 * commissionPerContract;

    // The call: 500 shares put at 98 on the 17th (close 97); on the 20th code sells the highest premium yield whose
    // strike reaches the cycle break-even (98 less the put's premium), on the held shares, buying none.
    const secondPut = quoteOf(session, "2026-04-09", "2026-04-17", 98, "P");
    expect(secondPutOpen.fillPrice).toBeCloseTo(secondPut.saleFill, 8);
    expect(dayOf(session, "2026-04-20").decisionSummary).toContain("$98 Put · 17 Apr assigned at the 97.00 close: 500 shares bought at the strike");
    expect(callOnShares).toMatchObject({ automatic: true, quantity: 5, contract: { strategyKey: "covered_call", expiry: "2026-04-24", strike: 98, right: "C" } });
    expect(callOnShares.chosenBecause).toMatch(/^code sells calls on held shares: the highest premium yield, \d+% a year; if called away the cycle ends \$\d+$/);
    expect(callOnShares.description).toContain("on 500 held shares");
    expect(callOnShares.fillPrice).toBeCloseTo(quoteOf(session, "2026-04-20", "2026-04-24", 98, "C").saleFill, 8);
    expect(session.fills.filter((fill) => fill.actionId === callOnShares.actionId).map((fill) => `${fill.instrument} ${fill.side}`)).toEqual(["option sell"]);

    // Two cycles: the put bought back; the put assigned, its shares now under the call.
    expect(detail.cycles.map((cycle) => ({ number: cycle.cycleNumber, status: cycle.status, openedOn: cycle.openedOn, assignedOn: cycle.assignedOn, closedOn: cycle.closedOn }))).toEqual([
      { number: 1, status: "closed", openedOn: "2026-04-07", assignedOn: null, closedOn: "2026-04-08" },
      { number: 2, status: "open", openedOn: "2026-04-09", assignedOn: "2026-04-17", closedOn: null },
    ]);
    expect(detail.cycles[0]!.totalDollars).toBeCloseTo(buybackProfit, 2);
    const sharesPosition = detail.positions.find((position) => position.strategyKey === "unstructured")!;
    expect(sharesPosition).toMatchObject({ status: "closed", closeReason: "stock_rolled_into_covered_call", unstructuredReason: "csp_assigned_stock" });
    expect(detail.trades.map((trade) => `${trade.openedOn} ${trade.optionRight}${trade.strike} ${trade.endedBy} ${trade.settledOn}`)).toEqual(["2026-04-07 P98 bought_back 2026-04-08", "2026-04-09 P98 assigned 2026-04-17", "2026-04-20 C98 null null"]);
    expect(detail.trades[0]!.pnlDollars).toBeNull();
    expect(detail.trades[0]!.positionPnlDollars).toBeCloseTo(buybackProfit, 2);

    const statistics = detail.tickerStatistics[0]!;
    expect(statistics).toMatchObject({ optionSaleCount: 3, averageTradedDte: (10 + 8 + 4) / 3, putPositionCount: 2, putPositionsEnded: 2, putPositionsAssigned: 1, putAssignedShare: 0.5, closedCycleCount: 1, openCycleCount: 1 });
    // Realized: the bought-back put and the assigned put's premium (its position closed at the assignment).
    expect(statistics.realizedPnlDollars).toBeCloseTo(buybackProfit + secondPut.saleFill * 500 - 5 * commissionPerContract, 2);
    expect(statistics.openCycles.map((cycle) => cycle.cycleNumber)).toEqual([2]);
  }, 60_000);

  it("buys a put back by code before an earnings report it would be held through", async () => {
    // An ETF's calendar is not checked when a put is sold, but an earnings row on it still triggers the close before
    // the report, as live: the report is after the close of Thursday 16 April, so from Friday the 10th five sessions
    // are left, and by then the put sold on the 7th shows a profit (the stock rose). The file runs past the session's
    // end so the sessions before the report can be counted.
    const fileDates = weekdaysBetween("2026-04-06", "2026-04-24");
    const tenOClockPrices = [100, 100.2, 100.6, 101, 101.6, 102, 102.2, 102.4, 102.6, 102.8, 103, 103, 103, 103, 103];
    const closes = /*     */ [100.1, 100.4, 100.8, 101.3, 101.8, 102.1, 102.3, 102.5, 102.7, 102.9, 103, 103, 103, 103, 103];
    const session = await runWheelSession({
      symbol: "WHLC",
      fileDates,
      lastSessionDate: "2026-04-13",
      tenOClockPrices,
      closes,
      expiriesOn: () => ["2026-04-24"],
      sector: "ETF",
      earnings: [{ dateIso: "2026-04-16", eventTime: "1" }],
      plutoOverrides: { maxTickerPctOfBudget: 10 },
    });
    const { detail } = session;
    expect(detail.session.dataLastDate).toBe("2026-04-24");
    expect(detail.days.map((day) => day.tradingDate)).toEqual(weekdaysBetween("2026-04-06", "2026-04-13"));
    expectAccountToReconcile(session);

    const filled = filledActionsOf(session);
    expect(filled.map((action) => `${action.tradingDate} ${action.kind} ${action.automatic}`)).toEqual(["2026-04-07 open_cash_secured_put false", "2026-04-10 close_leg true", "2026-04-13 open_cash_secured_put false"]);
    const automaticClose = filled[1]!;
    const put = quoteOf(session, "2026-04-07", "2026-04-24", 97, "P");
    const putBuyback = quoteOf(session, "2026-04-10", "2026-04-24", 97, "P");
    expect(automaticClose).toMatchObject({ passNumber: 1, quantity: 5, contract: { strategyKey: "cash_secured_put", expiry: "2026-04-24", strike: 97, right: "P" }, chosenBecause: "expires after the 16 Apr earnings (after the close): bought back at a profit within the last 5 sessions before it (Formula P3)" });
    expect(automaticClose.gateResults.map((gate) => `${gate.gate} ${gate.ok}`)).toEqual(["automatic_close true", "close_gate true"]);
    expect(automaticClose.fillPrice).toBeCloseTo(putBuyback.purchaseFill, 8);
    expect(automaticClose.candidateScores).toMatchObject({ earnings_date: "2026-04-16", earnings_time: "1", sessions_left: 5 });
    expect(dayOf(session, "2026-04-10").decisionSummary).toMatch(/^Closed WHLC Buy back \$97 Put · 24 Apr .* before the 16 Apr earnings; locks \d+ at the ask \(automatic\)$/);
    // Not before the window: on the 8th and 9th six and more sessions were left.
    expect(session.actions.filter((action) => action.tradingDate < "2026-04-10" && action.kind === "close_leg")).toEqual([]);

    const closedCycle = detail.cycles[0]!;
    expect(closedCycle).toMatchObject({ status: "closed", openedOn: "2026-04-07", closedOn: "2026-04-10", assignedOn: null, recoverySessions: null });
    expect(closedCycle.totalDollars).toBeCloseTo((put.saleFill - putBuyback.purchaseFill) * 500 - 2 * 5 * commissionPerContract, 2);
    expect(detail.trades[0]).toMatchObject({ endedBy: "bought_back", settledOn: "2026-04-10", inTheMoneyAtExpiry: null, settlementClose: null });
    expect(detail.tickerStatistics[0]).toMatchObject({ putPositionCount: 2, putPositionsEnded: 1, putPositionsAssigned: 0, putAssignedShare: 0, closedCycleCount: 1, openCycleCount: 1, recoverySessions: { count: 0, mean: null, median: null, longest: null } });
  }, 60_000);

  it("skips the days the downloader could not retrieve and says when volume was unknown", async () => {
    // 8 April could not be downloaded at all; the 9th is stored without its end-of-day part, so on the 10th the previous
    // session's volume is unknown and Pluto's volume rule refuses every contract.
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
      plutoOverrides: { maxTickerPctOfBudget: 60 },
    });
    const { detail } = session;
    expect(detail.session.status).toBe("succeeded");
    expect(detail.days.map((day) => day.tradingDate)).toEqual(["2026-04-06", "2026-04-07", "2026-04-09", "2026-04-10", "2026-04-13", "2026-04-14"]);
    expectAccountToReconcile(session);

    expect(dayOf(session, "2026-04-07").decisionSummary).toMatch(/^Opened WHLD Sell /);
    expect(dayOf(session, "2026-04-07").decisionSummary).not.toContain("could not be downloaded");
    // The day after the gap names it; it still trades (the volume of the 7th is known).
    expect(dayOf(session, "2026-04-09").decisionSummary).toMatch(/^Opened WHLD Sell .* · 1 day\(s\) before this one could not be downloaded and were skipped: 2026-04-08$/);
    // Interest over the two calendar days since the 7th.
    const dayAfterTheGap = dayOf(session, "2026-04-09");
    expect(dayAfterTheGap.interestDollars).toBeCloseTo(((dayAfterTheGap.cash - dayAfterTheGap.interestDollars) * 0.04 * 2) / 365, 2);
    // No volume for the 9th: nothing is eligible on the 10th, and the summary says why.
    expect(dayOf(session, "2026-04-10").decisionSummary).toMatch(/^No action: \d+ candidates, none eligible \(rejected by volume \d+.* · volume unknown for every contract \(refused by the volume rule\): the file has no end-of-day data for 2026-04-09$/);
    expect(filledActionsOf(session).filter((action) => action.tradingDate === "2026-04-10")).toEqual([]);
    // Back to normal on the 13th.
    expect(dayOf(session, "2026-04-13").decisionSummary).not.toContain("volume unknown");
  }, 60_000);

  it("settles on IBKR's last 30-minute bar when there is no daily bar for the expiry, and fails when there is neither", async () => {
    const fileDates = weekdaysBetween("2026-04-06", "2026-04-21");
    //                        6     7      8      9     10    13    14    15    16    17    20    21
    const tenOClockPrices = [100, 100.2, 100.6, 100.4, 99.6, 98.8, 98.2, 97.8, 97.4, 97.2, 97.6, 99.0];
    const closes = /*     */ [100.1, 100.4, 100.5, 100, 99.2, 98.5, 98.0, 97.6, 97.3, 97.0, 98.4, 99.1];
    const spec = { fileDates, lastSessionDate: "2026-04-21", tenOClockPrices, closes, expiriesOn: (dateIso: string) => (dateIso < "2026-04-17" ? ["2026-04-17"] : ["2026-04-17", "2026-04-24"]), plutoOverrides: { maxTickerPctOfBudget: 10 } };

    // No daily bar for Friday 17 April, but 30-minute bars: the stock settles at the last one's close (≈ 97.2), under the $98 strike.
    const settled = await runWheelSession({ ...spec, symbol: "WHLE", datesWithoutBar: ["2026-04-17"] });
    const monday = dayOf(settled, "2026-04-20").decisionSummary!;
    expect(monday).toContain("$98 Put · 17 Apr assigned at the 97.20 close: 500 shares bought at the strike");
    expect(monday).toContain("settled 2026-04-17 at the close of IBKR's last 30-minute bar (no daily bar)");
    expectAccountToReconcile(settled);

    // Neither a daily nor a 30-minute bar: the session stops rather than guess a price or leave the put open.
    await expect(runWheelSession({ ...spec, symbol: "WHLF", datesWithoutBar: ["2026-04-17"], unavailableDates: ["2026-04-17"] })).rejects.toThrow(
      "Cannot settle WHLF $98 Put · 17 Apr: the WHLF data file has no IBKR daily or 30-minute bar for 2026-04-17. Press Update on its row in Data files and run the session again.",
    );
  }, 60_000);
});

describe("a session of several symbols on one book", () => {
  const dates = weekdaysBetween("2026-04-06", "2026-04-15");
  //                        6     7      8      9      10     13     14     15
  const pricesA = /*    */ [100, 100.2, 100.3, 100.1, 100.4, 100.6, 100.5, 100.7];
  const pricesB = /*    */ [100, 99.8, 99.9, 100.2, 100.1, 100.3, 100.5, 100.4];
  const symbolSpec = (symbol: string, prices: number[], change: Partial<WheelSymbolSpec> = {}): WheelSymbolSpec => ({ symbol, fileDates: dates, tenOClockPrices: prices, closes: prices.map((price) => price + 0.1), expiriesOn: () => ["2026-04-24"], ...change });

  it("scores every symbol each day, trades the best across them and keeps one account", async () => {
    // WMA's options are priced at 60% volatility, WMB's at 90%: WMB's best contract has the higher Edge Yield. WMB's
    // file lacks 8 April (it could not be downloaded). Neither has end-of-day data for the 14th, so the 15th is quiet.
    const session = await runWheelSession({ ...symbolSpec("WMA", pricesA, { datesWithoutEndOfDay: ["2026-04-14"] }), lastSessionDate: "2026-04-15", moreSymbols: [symbolSpec("WMB", pricesB, { impliedVolatility: 0.9, unavailableDates: ["2026-04-08"], datesWithoutEndOfDay: ["2026-04-14"] })] });
    const { detail } = session;
    expect(detail.session).toMatchObject({ status: "succeeded", symbol: "WMA, WMB", symbols: ["WMA", "WMB"], dataLastDate: "2026-04-15" });
    // A session day is a date either file holds: the 8th counts although WMB lacks it.
    expect(detail.days.map((day) => day.tradingDate)).toEqual(dates);
    expectAccountToReconcile(session);

    // The 7th: the top pick across both symbols is on WMB; its fill cools WMB down, not WMA, whose own best follows in
    // the next pass. The 8th: only WMA is scored. The 9th: WMB again; WMA then has no room left on its ticker.
    expect(session.actions.filter((action) => action.tradingDate <= "2026-04-09").map((action) => `${action.tradingDate} p${action.passNumber} ${action.symbol} ${action.kind} ${action.outcome}`)).toEqual([
      "2026-04-07 p1 WMB open_cash_secured_put filled",
      "2026-04-07 p2 WMA open_cash_secured_put filled",
      "2026-04-08 p1 WMA open_cash_secured_put filled",
      "2026-04-09 p1 WMB open_cash_secured_put filled",
      "2026-04-09 p2 WMA open_cash_secured_put blocked",
    ]);
    const edgeYieldOf = (action: BacktestAction) => (action.candidateScores as { model: { expectedAnnualizedReturn: number } }).model.expectedAnnualizedReturn;
    expect(edgeYieldOf(session.actions[0]!)).toBeGreaterThan(edgeYieldOf(session.actions[1]!));
    // WMA's two positions hold about $94,000 of its $100,000 ticker room: less than one more contract.
    expect(dollarsAfter("ticker room", session.actions[4]!.blockReason!)).toBeLessThan(9_000);
    expect(session.actions[4]!.blockReason).toMatch(/^sizing: .*→ 0 contract\(s\) at \$[\d,]+ each/);

    // The day lines name the symbols.
    expect(dayOf(session, "2026-04-06").decisionSummary).toMatch(/^No action: WMA: \d+ candidates, none eligible \(rejected by volume .*\) \| WMB: \d+ candidates, none eligible \(rejected by volume /);
    expect(dayOf(session, "2026-04-07").decisionSummary).toMatch(/^Opened WMB Sell \$\d+ Put · 24 Apr \(17DTE\) · \d+× @ .* · Opened WMA Sell \$\d+ Put · 24 Apr \(17DTE\) · \d+× @ /);
    const closeBefore = session.previousCloseOf("WMB", "2026-04-08");
    expect(dayOf(session, "2026-04-08").decisionSummary).toMatch(new RegExp(`^Opened WMA Sell .* · WMB: not scored: the day could not be downloaded; marked at the previous close ${closeBefore.toFixed(2)}$`));
    expect(dayOf(session, "2026-04-09").decisionSummary).toMatch(/^Opened WMB Sell .* · Blocked WMA Sell .*: sizing: /);
    const lastDay = detail.days.at(-1)!;
    expect(lastDay.decisionSummary).toMatch(/^No action: WMA: .* \| WMB: .* · WMA: volume unknown for every contract .* for 2026-04-14 · WMB: volume unknown for every contract .* for 2026-04-14$/);

    // One book: every option sold names its symbol, each symbol has its own cycle, and the account is the start, the
    // interest and the cycles together (nothing was done on the last day, so its mark holds everything).
    expect(detail.trades.map((trade) => `${trade.openedOn} ${trade.symbol}`)).toEqual(["2026-04-07 WMB", "2026-04-07 WMA", "2026-04-08 WMA", "2026-04-09 WMB"]);
    expect(detail.cycles.map((cycle) => [cycle.symbol, cycle.cycleNumber, cycle.status, cycle.openedOn])).toEqual([
      ["WMA", 1, "open", "2026-04-07"],
      ["WMB", 1, "open", "2026-04-07"],
    ]);
    expect(filledActionsOf(session).filter((action) => action.tradingDate === lastDay.tradingDate)).toEqual([]);
    expect(lastDay.accountValue).toBeCloseTo(startingValue + totalInterest(session) + detail.cycles.reduce((sum, cycle) => sum + cycle.totalDollars, 0), 1);
    expect(lastDay.exposureDollars).toBeCloseTo(detail.positions.reduce((sum, position) => sum + (position.capitalAtRiskDollars ?? 0), 0), 1);

    // Statistics per symbol, and over both: counts and dollars add up, the average DTE is over all four options.
    expect(detail.tickerStatistics.map((row) => [row.symbol, row.optionSaleCount, row.putPositionCount, row.openCycleCount])).toEqual([
      ["WMA", 2, 2, 1],
      ["WMB", 2, 2, 1],
    ]);
    const [statisticsA, statisticsB] = detail.tickerStatistics as [(typeof detail.tickerStatistics)[number], (typeof detail.tickerStatistics)[number]];
    expect(detail.allSymbolsStatistics).toMatchObject({ symbol: "All symbols", optionSaleCount: 4, averageTradedDte: (17 + 16 + 17 + 15) / 4, putPositionCount: 4, putPositionsEnded: 0, putAssignedShare: null, closedCycleCount: 0, openCycleCount: 2 });
    expect(detail.allSymbolsStatistics!.totalPnlDollars).toBeCloseTo(statisticsA.totalPnlDollars + statisticsB.totalPnlDollars, 6);
    expect(detail.allSymbolsStatistics!.openCycles.map((cycle) => cycle.symbol)).toEqual(["WMA", "WMB"]);

    // Buy and hold: half the start in each symbol's whole shares at the first 10:00 price, the rest in cash; on the 8th
    // WMB is valued at its previous close.
    const priceOn = (symbol: string, dateIso: string) => computeParityStockPrice(session.quotesOn(dateIso, symbol), dateIso, ratePercent / 100, maximumSpreadFractionOfMid)?.price ?? session.previousCloseOf(symbol, dateIso);
    const sharesOf = (symbol: string) => Math.floor(startingValue / 2 / priceOn(symbol, "2026-04-06"));
    const baselineCash = startingValue - sharesOf("WMA") * priceOn("WMA", "2026-04-06") - sharesOf("WMB") * priceOn("WMB", "2026-04-06");
    expect(detail.days[0]!.baselineValue).toBeCloseTo(startingValue, 6);
    for (const dateIso of ["2026-04-08", "2026-04-15"]) expect(dayOf(session, dateIso).baselineValue).toBeCloseTo(baselineCash + sharesOf("WMA") * priceOn("WMA", dateIso) + sharesOf("WMB") * priceOn("WMB", dateIso), 0);

    // Everything can be read for one symbol: the pages of actions and fills, and the session narrowed to it.
    const ofSymbol = { ...everything, symbol: "WMB", limit: 100, offset: 0 };
    const actionsOfB = await loadBacktestSessionActions(session.sessionId, ofSymbol);
    expect(actionsOfB.total).toBe(session.actions.filter((action) => action.symbol === "WMB").length);
    expect(actionsOfB.actions.every((action) => action.symbol === "WMB")).toBe(true);
    const fillsOfB = await loadBacktestSessionFills(session.sessionId, ofSymbol);
    expect(fillsOfB.fills.map((fill) => [fill.symbol, fill.tradingDate])).toEqual([
      ["WMB", "2026-04-07"],
      ["WMB", "2026-04-09"],
    ]);
    const onlyB = await loadBacktestSessionDetail(session.sessionId, "WMB");
    expect(onlyB.trades.map((trade) => trade.symbol)).toEqual(["WMB", "WMB"]);
    expect(onlyB.positions.every((position) => position.symbol === "WMB")).toBe(true);
    expect(onlyB.cycles.map((cycle) => cycle.symbol)).toEqual(["WMB"]);
    expect(onlyB.tickerStatistics).toEqual([statisticsB]);
    expect(onlyB.allSymbolsStatistics).toEqual({ ...statisticsB, symbol: "All symbols" });
    // The account's days are the whole book's either way.
    expect(onlyB.days).toEqual(detail.days);
  }, 60_000);

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

  it("applies the book's limits across the symbols: the budget, the open positions and the sector", async () => {
    // Three days each: nothing on the first (no volume yet), and on the second the best contract is on the second
    // symbol (90% volatility against 60%), which leaves the first one to the limit under test.
    const threeDays = dates.slice(0, 3);
    const twoSymbols = (first: string, second: string, plutoOverrides: Partial<PlutoSettings>, secondSector = "Technology") =>
      runWheelSession({ ...symbolSpec(first, pricesA, { fileDates: threeDays }), lastSessionDate: "2026-04-08", plutoOverrides, moreSymbols: [symbolSpec(second, pricesB, { fileDates: threeDays, impliedVolatility: 0.9, sector: secondSector })] });
    const secondDay = (session: WheelSession) => session.actions.filter((action) => action.tradingDate === "2026-04-07").map((action) => [action.symbol, action.outcome]);

    // The capital budget: 5% of $1,000,000 = $50,000, and one order may take all of it.
    const budget = await twoSymbols("WBA", "WBB", { capitalBudgetPct: 5, orderSizePctOfBudget: 100, maxTickerPctOfBudget: 100 });
    expect(secondDay(budget)).toEqual([
      ["WBB", "filled"],
      ["WBA", "blocked"],
    ]);
    const refusedForBudget = budget.actions.find((action) => action.symbol === "WBA" && action.outcome === "blocked")!;
    const budgetLeft = dollarsAfter("budget left", refusedForBudget.blockReason!);
    expect(budgetLeft).toBeCloseTo(50_000 - budget.detail.trades[0]!.exposureDollars, -3);
    expect(budgetLeft).toBeLessThan(9_000);
    expect(refusedForBudget.blockReason).toMatch(/^sizing: /);
    expectAccountToReconcile(budget);

    // The open positions: room for one.
    const positions = await twoSymbols("WPA", "WPB", { maxOpenPositions: 1 });
    expect(secondDay(positions)).toEqual([
      ["WPB", "filled"],
      ["WPA", "blocked"],
    ]);
    expect(positions.actions.find((action) => action.symbol === "WPA" && action.outcome === "blocked")!.blockReason).toBe("open_positions_cap: 1 of 1 managed positions");

    // The sector: both tickers are Technology, capped together at 10% of the $500,000 budget ($50,000).
    const sector = await twoSymbols("WSA", "WSB", { maxSectorPctOfBudget: 10 });
    expect(secondDay(sector)).toEqual([
      ["WSB", "filled"],
      ["WSA", "blocked"],
    ]);
    const refusedForSector = sector.actions.find((action) => action.symbol === "WSA" && action.outcome === "blocked")!;
    expect(dollarsAfter("sector room", refusedForSector.blockReason!)).toBeCloseTo(50_000 - sector.detail.trades[0]!.exposureDollars, -3);
    expect(dollarsAfter("ticker room", refusedForSector.blockReason!)).toBeGreaterThan(40_000);
    expect(dayOf(sector, "2026-04-07").decisionSummary).toMatch(/^Opened WSB Sell .* · Blocked WSA Sell .*: sizing: .*sector room /);
    // With the second ticker in another sector the same cap refuses nothing.
    const otherSector = await twoSymbols("WOA", "WOB", { maxSectorPctOfBudget: 10 }, "Healthcare");
    expect(secondDay(otherSector)).toEqual([
      ["WOB", "filled"],
      ["WOA", "filled"],
    ]);
  }, 120_000);
});
