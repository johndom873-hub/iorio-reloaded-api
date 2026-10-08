import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { settleGraceMs, subscribeToPooledQuote, waitForFirstReading, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { loadCycleInputsForTickers, type SymbolCycleInput } from "./cycleQueries.js";
import { deriveCloseLiveState, type CloseLiveLeg, type CloseLiveQuote, type CloseLiveState } from "./closeLiveState.js";
import { computeMarketSessionStatus, type MarketSessionState } from "./marketSessionStatus.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { daysToExpiry, describeOptionContract } from "./optionContractLabel.js";

// Server-side close gate (gap fix 4 for Pluto, 2026-09-28). The Close form's live stream
// (routes/positionCloseLive.ts) already derives "may this position be closed right now" —
// regular session open, a live two-sided quote on every leg, a consistent open wheel cycle —
// but until now only the browser honoured it: a direct API call, Genosuke, or a bot could
// build and confirm a close at 2 AM. This module runs the same derivation once, synchronously
// enough for a route: subscribe the legs on the shared quote pool, wait at most the settle
// grace for quotes, derive, unsubscribe. Fail closed: any failure to load or derive is a block.

export interface CloseLiveLegContract {
  leg: CloseLiveLeg;
  contract: PriceContract;
}

export interface CloseLiveInputs {
  positionId: string;
  tickerId: string;
  symbol: string;
  legs: CloseLiveLeg[];
  /** One pool contract per leg plus the stock itself under key "stock" (the stock leg, if any, shares it). */
  contracts: Array<{ key: string; contract: PriceContract }>;
  cycleInput: SymbolCycleInput["input"];
}

interface OpenLegRow {
  id: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entryPrice: string;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  expiryLabel: string | null;
}

/** Everything the close derivation needs except quotes and the clock; null when the position is not open. */
export async function loadCloseLiveInputs(positionId: string): Promise<CloseLiveInputs | null> {
  const position = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.id", positionId)
    .first("p.status as status", "p.ticker_id as tickerId", "t.symbol as symbol");
  if (!position || position.status !== "open") return null;
  const symbol: string = position.symbol;

  const legRows: OpenLegRow[] = await db("position_legs")
    .where({ position_id: positionId })
    .whereNull("exit_at")
    .select(
      "id",
      "leg_type as legType",
      "side",
      "quantity",
      "multiplier",
      "entry_price as entryPrice",
      "option_type as optionType",
      "strike_price as strikePrice",
      db.raw("to_char(expiry_date, 'YYYYMMDD') as \"expiryDate\""),
      db.raw("to_char(expiry_date, 'YYYY-MM-DD') as \"expiryLabel\""),
    );
  const legs: CloseLiveLeg[] = legRows.map((leg) => ({
    id: leg.id,
    legType: leg.legType,
    side: leg.side,
    quantity: leg.quantity,
    multiplier: leg.multiplier,
    entryPrice: Number(leg.entryPrice),
    label: leg.legType === "stock" || !leg.expiryLabel ? `${symbol} ${leg.legType === "stock" ? "stock" : `$${Number(leg.strikePrice)} ${leg.optionType === "call" ? "Call" : "Put"}`}` : describeOptionContract({ symbol, strike: Number(leg.strikePrice), right: leg.optionType === "call" ? "C" : "P", expiry: leg.expiryLabel, dte: Math.max(0, daysToExpiry(leg.expiryLabel, easternIsoDate(new Date()))) }),
  }));
  const contracts: CloseLiveInputs["contracts"] = [
    { key: "stock", contract: { key: "stock", legType: "stock", symbol } },
    ...legRows
      .filter((leg) => leg.legType === "option")
      .map((leg) => ({
        key: leg.id,
        contract: {
          key: leg.id,
          legType: "option" as const,
          symbol,
          expiry: leg.expiryDate ?? undefined,
          strike: Number(leg.strikePrice),
          right: leg.optionType === "call" ? OptionType.Call : OptionType.Put,
        },
      })),
  ];

  const [cycleSymbolInput] = await loadCycleInputsForTickers([position.tickerId]);
  if (!cycleSymbolInput) return null;
  return { positionId, tickerId: position.tickerId, symbol, legs, contracts, cycleInput: cycleSymbolInput.input };
}

export function toCloseLiveQuote(quote: PooledQuote): CloseLiveQuote {
  return { bid: quote.bid, ask: quote.ask, last: quote.last };
}

export interface CloseGateVerdict {
  blocked: boolean;
  reason: string | null;
  /** The live wheel-cycle P&L when the close is allowed. */
  cycleTotal: number | null;
}

/** The pure verdict: pending-after-grace is a block, and so is anything not live. */
export function closeGateVerdictFromState(state: CloseLiveState): CloseGateVerdict {
  if (state.live) return { blocked: false, reason: null, cycleTotal: state.cycleTotal };
  return { blocked: true, reason: state.blockReason ?? "Closing is blocked: live quotes are unavailable.", cycleTotal: null };
}

/**
 * One-shot evaluation for the close build route and the confirm gate. Holds the legs on the
 * shared pool for at most the settle grace (the same window the Close form waits), so a screen
 * that already has the position open makes this instant.
 */
export async function evaluateCloseGateForPosition(positionId: string): Promise<CloseGateVerdict> {
  let inputs: CloseLiveInputs | null;
  try {
    inputs = await loadCloseLiveInputs(positionId);
  } catch (error) {
    return { blocked: true, reason: `Closing is blocked: the position's data could not be loaded (${error instanceof Error ? error.message : String(error)}).`, cycleTotal: null };
  }
  if (!inputs) return { blocked: true, reason: "Closing is blocked: the position is not open or its wheel-cycle data could not be loaded.", cycleTotal: null };

  let marketState: MarketSessionState;
  try {
    marketState = (await computeMarketSessionStatus()).state;
  } catch {
    marketState = "closed";
  }
  // No pool round trip when the market is closed: the derivation blocks on that first anyway.
  if (marketState !== "open") {
    return closeGateVerdictFromState(
      deriveCloseLiveState({ ...inputsForDerivation(inputs, {}, null), marketState, waitedMs: settleGraceMs, settleGraceMs }),
    );
  }

  const startedAt = Date.now();
  let stockQuote: CloseLiveQuote | null = null;
  const optionQuotesByLegId: Record<string, CloseLiveQuote | null> = {};
  const unsubscribers: Array<() => void> = [];
  const derive = () =>
    deriveCloseLiveState({ ...inputsForDerivation(inputs!, optionQuotesByLegId, stockQuote), marketState, waitedMs: Date.now() - startedAt, settleGraceMs });
  const { settled, check } = waitForFirstReading(() => {
    const state = derive();
    return state.live || !state.pending;
  });
  try {
    for (const { key, contract } of inputs.contracts) {
      unsubscribers.push(
        await subscribeToPooledQuote(contract, (quote) => {
          if (key === "stock") stockQuote = toCloseLiveQuote(quote);
          else optionQuotesByLegId[key] = toCloseLiveQuote(quote);
          check();
        }),
      );
    }
    await settled;
    // Past the grace the derivation flips "waiting" into a real block on its own.
    return closeGateVerdictFromState(deriveCloseLiveState({ ...inputsForDerivation(inputs, optionQuotesByLegId, stockQuote), marketState, waitedMs: Math.max(Date.now() - startedAt, settleGraceMs), settleGraceMs }));
  } catch (error) {
    return { blocked: true, reason: `Closing is blocked: live quotes could not be read (${error instanceof Error ? error.message : String(error)}).`, cycleTotal: null };
  } finally {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.error(`Close gate: could not release a quote subscription: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export function inputsForDerivation(inputs: CloseLiveInputs, optionQuotesByLegId: Record<string, CloseLiveQuote | null>, stockQuote: CloseLiveQuote | null) {
  return {
    symbol: inputs.symbol,
    positionId: inputs.positionId,
    legs: inputs.legs,
    optionQuotesByLegId,
    stockQuote,
    cycleInput: inputs.cycleInput,
    todayIso: easternIsoDate(new Date()),
  };
}
