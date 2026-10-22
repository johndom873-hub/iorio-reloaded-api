import { parentPort } from "node:worker_threads";
import { enableExactInputCaches } from "../../lib/exactInputCaches.js";
import { scoreHeldShareCalls, scoreTicker } from "../../lib/signalsLiveScoring.js";
import type { TickerSignalsInputs } from "../../lib/signalsTypes.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import type { BacktestScoredTicker, BacktestScoringWorkerReply, BacktestScoringWorkerRequest } from "./backtestScoringPool.js";
import { buildHistoricalTickerInputs } from "./backtestTickerInputs.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { remainingSessionVarianceCurveOf } from "../backtestSettingsOverrides.js";
import { defaultBacktestModelSettings } from "../backtestTypes.js";
import type { BacktestScoringModelSettings } from "./backtestScoringPool.js";

// One scoring worker of a session (backtestScoringPool.ts): it keeps the session's calendar, the bars and profile of the
// symbols given to it, and each one's Signals inputs of the day, and runs the two heavy steps of a symbol's look on them:
// building the day's inputs (the surface fit among them) and scoring the ticker, with the calls Pluto may sell on its free shares. The same functions as the look runs
// without a pool, on structured copies of the same values, so the results are the same.

if (!parentPort) throw new Error("backtestScoringWorker.ts runs as a worker thread of a backtest session.");
const port = parentPort;
enableExactInputCaches();

let calendar: BacktestTradingCalendar | null = null;
let sessionModel: BacktestScoringModelSettings = { forecastMethod: defaultBacktestModelSettings.forecastMethod, restOfDayCurve: defaultBacktestModelSettings.restOfDayCurve };
const symbolState = new Map<string, { profile: Extract<BacktestScoringWorkerRequest, { type: "init" }>["symbols"][number]["profile"]; bars: BacktestBarHistory; barsByFactor: Map<number, BacktestBarHistory>; inputsByDay: Map<string, TickerSignalsInputs> }>();
/** A symbol's inputs are kept for its two latest days: the next day's can be built while today's looks are still scored. */
const daysKeptPerSymbol = 2;
const modelTablesById = new Map<number, VolatilityModelTables>();
const tradingById = new Map<number, NonNullable<Extract<BacktestScoringWorkerRequest, { type: "score" }>["trading"]>>();
/** Each symbol's day quotes from its last warm request: a score whose quotes are the same is sent without them. */
const lastWarmDayQuotesBySymbol = new Map<string, Extract<BacktestScoringWorkerRequest, { type: "warm" }>["dayQuotes"]>();
/** Each symbol's last warm request and what scoring it gave: a score of the same day quotes on the same book gets that answer. */
const lastWarmScoringBySymbol = new Map<string, { request: Extract<BacktestScoringWorkerRequest, { type: "warm" }>; result: unknown }>();

/**
 * True when two values received from the session's thread are the same data: plain objects with the same keys,
 * arrays, and equal primitives (numbers by Object.is, so −0 and 0 differ and NaN equals NaN). Anything else (a Map, a
 * Date) counts as different.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameData(item, b[index]));
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const aKeys = Object.keys(a);
  const bRecord = b as Record<string, unknown>;
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => Object.hasOwn(bRecord, key) && sameData((a as Record<string, unknown>)[key], bRecord[key]));
}

/** What a scoring reads besides its day quotes: when these are the same data, scoreTicker gives the same answer. */
const scoringBookOf = (request: Extract<BacktestScoringWorkerRequest, { type: "score" | "warm" }>) => ({ symbol: request.symbol, todayIso: request.todayIso, freeShares: request.freeShares, openShortLegs: request.openShortLegs, freeCash: request.freeCash, tradingId: request.tradingId, live: request.live, modelTablesId: request.modelTablesId, scoredAtMs: request.scoredAtMs });

function stateOf(symbol: string) {
  const state = symbolState.get(symbol);
  if (!state) throw new Error(`The scoring worker was not given ${symbol}.`);
  return state;
}

function handle(request: BacktestScoringWorkerRequest): unknown {
  switch (request.type) {
    case "init": {
      calendar = new BacktestTradingCalendar(request.calendar.fileDays, request.calendar.marketCalendarRows);
      sessionModel = request.model;
      for (const { symbol, profile, barRows } of request.symbols) {
        const bars = new BacktestBarHistory(barRows);
        symbolState.set(symbol, { profile, bars, barsByFactor: new Map([[1, bars]]), inputsByDay: new Map() });
      }
      return null;
    }
    case "prepareDay": {
      if (!calendar) throw new Error("The scoring worker has no calendar yet.");
      const state = stateOf(request.symbol);
      let bars = state.barsByFactor.get(request.splitFactor);
      if (!bars) {
        bars = state.bars.scaled(request.splitFactor);
        state.barsByFactor.set(request.splitFactor, bars);
      }
      const built = buildHistoricalTickerInputs({ profile: state.profile, bars, market: request.market, calendar, elevatedVolatility: request.elevatedVolatility, macroEvents: request.macroEvents, forecastMethod: sessionModel.forecastMethod });
      state.inputsByDay.set(request.market.todayIso, built.inputs);
      for (const dayIso of [...state.inputsByDay.keys()].sort().slice(0, -daysKeptPerSymbol)) state.inputsByDay.delete(dayIso);
      return built;
    }
    case "warm": {
      lastWarmDayQuotesBySymbol.set(request.symbol, request.dayQuotes);
      lastWarmScoringBySymbol.delete(request.symbol);
      // A guess at the next look: its answer is kept for a score on the same book; a failure is dropped (the look's own scoring reports any real one).
      try {
        lastWarmScoringBySymbol.set(request.symbol, { request, result: handle({ ...request, type: "score" }) });
      } catch {
        // Nothing kept.
      }
      return null;
    }
    case "score": {
      const state = stateOf(request.symbol);
      const dayInputs = state.inputsByDay.get(request.todayIso);
      if (!dayInputs) throw new Error(`The scoring worker has no inputs of ${request.todayIso} for ${request.symbol}.`);
      if (request.modelTables) modelTablesById.set(request.modelTablesId, request.modelTables);
      const modelTables = modelTablesById.get(request.modelTablesId);
      if (!modelTables) throw new Error(`The scoring worker was not given the model tables ${request.modelTablesId}.`);
      if (request.trading) tradingById.set(request.tradingId, request.trading);
      const trading = tradingById.get(request.tradingId);
      if (!trading) throw new Error(`The scoring worker was not given the trading settings ${request.tradingId}.`);
      const warmed = request.dayQuotesOfLastWarm ? lastWarmScoringBySymbol.get(request.symbol) : undefined;
      if (warmed && sameData(scoringBookOf(warmed.request), scoringBookOf(request))) return warmed.result;
      const dayQuotes = request.dayQuotesOfLastWarm ? lastWarmDayQuotesBySymbol.get(request.symbol) : request.dayQuotes;
      if (!dayQuotes) throw new Error(`The scoring worker has no warmed day quotes for ${request.symbol}.`);
      const inputs: TickerSignalsInputs = { ...dayInputs, freeShares: request.freeShares, openShortLegs: request.openShortLegs, dayQuotes };
      const account = { freeCash: request.freeCash };
      const history = { modelTables, scoredAtMs: request.scoredAtMs, remainingSessionVarianceCurve: remainingSessionVarianceCurveOf(sessionModel.restOfDayCurve) };
      const result: BacktestScoredTicker = { scored: scoreTicker(inputs, account, trading, request.live, undefined, history), heldShareCallCandidates: scoreHeldShareCalls(inputs, account, trading, request.live, history) };
      return result;
    }
  }
}

port.on("message", (message: { id: number; request: BacktestScoringWorkerRequest }) => {
  let reply: BacktestScoringWorkerReply;
  try {
    reply = { id: message.id, ok: true, result: handle(message.request) };
  } catch (error) {
    reply = { id: message.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  port.postMessage(reply);
});
