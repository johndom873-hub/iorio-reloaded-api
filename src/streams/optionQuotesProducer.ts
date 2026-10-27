import { subscribeToPooledQuote } from "../ibkr/marketDataPool.js";
import { streamOptionQuotes } from "../ibkr/streamOptionQuotes.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { impliedVolatilityFromPrice } from "../lib/impliedVolatilitySurface.js";
import { loadTradingSessionsBetween } from "../lib/marketSessionStatus.js";
import { calendarDaysUntilExpiry } from "../lib/optionChainCaptureWindow.js";
import { deltaFromQuoteMid, yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import type { StreamProducer } from "./streamProducers.js";
import { StreamRequestError } from "./streamProtocol.js";

// The Ticker modal's `optionQuotes` stream (2026-10-27, replacing `signalsQuotes`): live quotes for exactly the contracts
// the modal has on screen, plus any pinned ones (an order under review), from the shared market-data pool, with the
// stock's live price. Each quote carries its own delta and implied volatility read from its mid on the forward
// spot × e^(rT) (quoteOwnDelta.ts, the platform's delta), else IBKR's delta. Frames carry full state, at most once a second.

export const optionQuotesMaxContracts = 64;
const contractKeyPattern = /^\d{4}-\d{2}-\d{2}\|\d+(\.\d+)?\|[CP]$/;
const symbolPattern = /^[A-Za-z0-9.\-]{1,15}$/;
const frameIntervalMs = 1_000;

export interface LiveContractQuote {
  bid: number | null;
  ask: number | null;
  delta: number | null;
  impliedVolatility: number | null;
}

export interface OptionQuotesFrame {
  type: "optionQuotes";
  at: string;
  spotPrice: number | null;
  /** By `${expiry}|${strike}|${right}`. */
  quotes: Record<string, LiveContractQuote>;
}

function parseParameters(rawParameters: unknown): Record<string, string> {
  if (rawParameters === null || typeof rawParameters !== "object" || Array.isArray(rawParameters)) throw new StreamRequestError(400, "parameters must be an object.");
  const { symbol, contracts, ...rest } = rawParameters as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new StreamRequestError(400, `Unknown parameter: ${Object.keys(rest)[0]}.`);
  if (typeof symbol !== "string" || !symbolPattern.test(symbol)) throw new StreamRequestError(400, "symbol is required.");
  if (!Array.isArray(contracts) || contracts.length === 0) throw new StreamRequestError(400, "contracts must be a non-empty array.");
  if (contracts.length > optionQuotesMaxContracts) throw new StreamRequestError(400, `contracts may hold at most ${optionQuotesMaxContracts} entries.`);
  for (const key of contracts) if (typeof key !== "string" || !contractKeyPattern.test(key)) throw new StreamRequestError(400, "contracts contains an invalid entry.");
  return { symbol: symbol.toUpperCase(), contracts: [...new Set(contracts as string[])].join(",") };
}

/** Pure: a quote's own delta and IV from its mid (exported for tests). */
export function readOwnGreeks(input: { bid: number | null; ask: number | null; ibkrDelta: number | null; spotPrice: number | null; strike: number; isCall: boolean; yearsToExpiry: number; riskFreeRate: number }): Pick<LiveContractQuote, "delta" | "impliedVolatility"> {
  const { bid, ask, spotPrice, strike, isCall, yearsToExpiry, riskFreeRate } = input;
  if (spotPrice === null || bid === null || ask === null || !(bid > 0) || !(ask > bid) || !(yearsToExpiry > 0)) return { delta: input.ibkrDelta, impliedVolatility: null };
  const delta = deltaFromQuoteMid({ bid, ask, spotPrice, strike, isCall, yearsToExpiry, riskFreeRate });
  const impliedVolatility = impliedVolatilityFromPrice((bid + ask) / 2, spotPrice * Math.exp(riskFreeRate * yearsToExpiry), strike, yearsToExpiry, riskFreeRate, isCall);
  return { delta: delta ?? input.ibkrDelta, impliedVolatility };
}

export const optionQuotesProducer: StreamProducer = {
  isSnapshotStream: true,
  parseParameters,
  async run(parameters, _context, emit, signal) {
    const symbol = parameters.symbol!;
    const contracts = parameters.contracts!.split(",").map((key) => {
      const [expiry, strike, right] = key.split("|") as [string, string, "C" | "P"];
      return { expiry, strike: Number(strike), right };
    });
    const now = new Date();
    const todayIso = easternIsoDate(now);
    const [riskFreeRate, sessions] = await Promise.all([getRiskFreeRate(), loadTradingSessionsBetween(todayIso, todayIso)]);
    const closeMinutesEt = sessions[0]?.closeMinutesEt ?? 16 * 60;

    let spotPrice: number | null = null;
    let latest: { expiry: string; strike: number; right: "C" | "P"; bid: number | null; ask: number | null; delta: number | null }[] = [];
    let lastEmitAtMs = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const emitFrame = () => {
      pending = null;
      lastEmitAtMs = Date.now();
      const yearsToTodaysClose = yearsToSessionClose(new Date(), closeMinutesEt);
      const quotes: Record<string, LiveContractQuote> = {};
      for (const quote of latest) {
        const daysToExpiry = calendarDaysUntilExpiry(todayIso, quote.expiry.replaceAll("-", ""));
        const greeks = readOwnGreeks({ bid: quote.bid, ask: quote.ask, ibkrDelta: quote.delta, spotPrice, strike: quote.strike, isCall: quote.right === "C", yearsToExpiry: daysToExpiry <= 0 ? yearsToTodaysClose : daysToExpiry / 365, riskFreeRate: riskFreeRate ?? 0 });
        quotes[`${quote.expiry}|${quote.strike}|${quote.right}`] = { bid: quote.bid, ask: quote.ask, ...greeks };
      }
      emit({ type: "optionQuotes", at: new Date().toISOString(), spotPrice, quotes } satisfies OptionQuotesFrame);
    };
    const scheduleFrame = () => {
      if (pending || signal.aborted) return;
      pending = setTimeout(emitFrame, Math.max(0, frameIntervalMs - (Date.now() - lastEmitAtMs)));
    };

    const unsubscribeStock = await subscribeToPooledQuote({ key: `${symbol}|stock`, legType: "stock", symbol }, (quote) => {
      spotPrice = quote.last ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : spotPrice);
      scheduleFrame();
    });
    try {
      await streamOptionQuotes(
        symbol,
        contracts,
        (quotes) => {
          latest = quotes;
          scheduleFrame();
        },
        signal,
      );
    } finally {
      unsubscribeStock();
      if (pending) clearTimeout(pending);
    }
  },
};
