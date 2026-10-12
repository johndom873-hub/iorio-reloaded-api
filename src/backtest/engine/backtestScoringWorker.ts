import { parentPort } from "node:worker_threads";
import { scoreTicker } from "../../lib/signalsLiveScoring.js";
import type { TickerSignalsInputs } from "../../lib/signalsTypes.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import type { BacktestScoringWorkerReply, BacktestScoringWorkerRequest } from "./backtestScoringPool.js";
import { buildHistoricalTickerInputs } from "./backtestTickerInputs.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";

// One scoring worker of a session (backtestScoringPool.ts): it keeps the session's calendar, the bars and profile of the
// symbols given to it, and each one's Signals inputs of the day, and runs the two heavy steps of a symbol's look on them:
// building the day's inputs (the surface fit among them) and scoring the ticker. The same functions as the look runs
// without a pool, on structured copies of the same values, so the results are the same.

if (!parentPort) throw new Error("backtestScoringWorker.ts runs as a worker thread of a backtest session.");
const port = parentPort;

let calendar: BacktestTradingCalendar | null = null;
const symbolState = new Map<string, { profile: Extract<BacktestScoringWorkerRequest, { type: "init" }>["symbols"][number]["profile"]; bars: BacktestBarHistory; barsByFactor: Map<number, BacktestBarHistory>; day: { todayIso: string; inputs: TickerSignalsInputs } | null }>();
const modelTablesById = new Map<number, VolatilityModelTables>();

function stateOf(symbol: string) {
  const state = symbolState.get(symbol);
  if (!state) throw new Error(`The scoring worker was not given ${symbol}.`);
  return state;
}

function handle(request: BacktestScoringWorkerRequest): unknown {
  switch (request.type) {
    case "init": {
      calendar = new BacktestTradingCalendar(request.calendar.fileDays, request.calendar.marketCalendarRows);
      for (const { symbol, profile, barRows } of request.symbols) {
        const bars = new BacktestBarHistory(barRows);
        symbolState.set(symbol, { profile, bars, barsByFactor: new Map([[1, bars]]), day: null });
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
      const built = buildHistoricalTickerInputs({ profile: state.profile, bars, market: request.market, calendar, elevatedVolatility: request.elevatedVolatility, macroEvents: request.macroEvents });
      state.day = { todayIso: request.market.todayIso, inputs: built.inputs };
      return built;
    }
    case "score": {
      const state = stateOf(request.symbol);
      if (!state.day || state.day.todayIso !== request.todayIso) throw new Error(`The scoring worker has no inputs of ${request.todayIso} for ${request.symbol}.`);
      if (request.modelTables) modelTablesById.set(request.modelTablesId, request.modelTables);
      const modelTables = modelTablesById.get(request.modelTablesId);
      if (!modelTables) throw new Error(`The scoring worker was not given the model tables ${request.modelTablesId}.`);
      const inputs: TickerSignalsInputs = { ...state.day.inputs, freeShares: request.freeShares, openShortLegs: request.openShortLegs, dayQuotes: request.dayQuotes };
      return scoreTicker(inputs, { freeCash: request.freeCash }, request.trading, request.live, undefined, { modelTables, scoredAtMs: request.scoredAtMs });
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
