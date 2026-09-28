import type { Request, Response } from "express";
import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { settleGraceMs, subscribeToPooledQuote, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { loadCycleInputsForTickers } from "../lib/cycleQueries.js";
import { deriveCloseLiveState, type CloseLiveLeg, type CloseLiveQuote } from "../lib/closeLiveState.js";
import { computeMarketSessionStatus, easternDateIso, type MarketSessionState } from "../lib/marketSessionStatus.js";

// Live data behind the Close form only (approved 2026-09-28): one SSE stream per open modal carrying the
// position's live bid/ask, the live wheel-cycle P&L and whether closing is allowed right now. It reads the
// shared quote pool exactly like the other streams (no extra IBKR lines), and nothing else consumes it.

const positionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emitThrottleMs = 500;
const periodicEmitMs = 5_000;
const heartbeatIntervalMs = 20_000;

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

function toQuote(quote: PooledQuote): CloseLiveQuote {
  return { bid: quote.bid, ask: quote.ask, last: quote.last };
}

export async function streamCloseLiveHandler(request: Request, response: Response): Promise<void> {
  const positionId = String(request.params.id);
  if (!positionIdPattern.test(positionId)) {
    response.status(404).json({ error: "Position not found." });
    return;
  }

  const position = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("p.id", positionId)
    .first("p.status as status", "p.ticker_id as tickerId", "t.symbol as symbol");
  if (!position || position.status !== "open") {
    response.status(404).json({ error: "Open position not found." });
    return;
  }
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
    label: leg.legType === "stock" ? `${symbol} stock` : `$${Number(leg.strikePrice)}${leg.optionType === "call" ? "C" : "P"} ${leg.expiryLabel}`,
  }));

  const [cycleSymbolInput] = await loadCycleInputsForTickers([position.tickerId]);

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!cycleSymbolInput) {
    send({ type: "streamError", message: `No wheel cycle data could be loaded for ${symbol}.` });
    response.end();
    return;
  }

  const startedAt = Date.now();
  let closed = false;
  let marketState: MarketSessionState = "closed";
  let stockQuote: CloseLiveQuote | null = null;
  const optionQuotesByLegId: Record<string, CloseLiveQuote | null> = {};
  const unsubscribers: Array<() => void> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    if (closed) return;
    send({
      type: "state",
      data: deriveCloseLiveState({
        symbol,
        positionId,
        legs,
        marketState,
        optionQuotesByLegId,
        stockQuote,
        cycleInput: cycleSymbolInput.input,
        todayIso: easternDateIso(new Date()),
        waitedMs: Date.now() - startedAt,
        settleGraceMs,
      }),
    });
  };
  const scheduleEmit = () => {
    if (throttleTimer !== null || closed) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      emit();
    }, emitThrottleMs);
  };
  // A lookup failure counts as "closed" so the form fails closed rather than trusting a stale "open".
  const refreshMarketState = async () => {
    try {
      marketState = (await computeMarketSessionStatus()).state;
    } catch {
      marketState = "closed";
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    if (throttleTimer !== null) clearTimeout(throttleTimer);
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (!response.writableEnded) response.end();
  };
  request.on("close", cleanup);

  timers.push(setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs));

  try {
    await refreshMarketState();
    const contracts: Array<{ contract: PriceContract; onQuote: (quote: CloseLiveQuote) => void }> = [
      { contract: { key: "stock", legType: "stock", symbol }, onQuote: (quote) => { stockQuote = quote; } },
      ...legRows
        .filter((leg) => leg.legType === "option")
        .map((leg) => ({
          contract: {
            key: leg.id,
            legType: "option" as const,
            symbol,
            expiry: leg.expiryDate ?? undefined,
            strike: Number(leg.strikePrice),
            right: leg.optionType === "call" ? OptionType.Call : OptionType.Put,
          },
          onQuote: (quote: CloseLiveQuote) => { optionQuotesByLegId[leg.id] = quote; },
        })),
    ];
    for (const { contract, onQuote } of contracts) {
      const unsubscribe = await subscribeToPooledQuote(contract, (quote) => {
        onQuote(toQuote(quote));
        scheduleEmit();
      });
      if (closed) unsubscribe();
      else unsubscribers.push(unsubscribe);
    }
    if (closed) return;

    emit();
    // Flip "waiting" to "unavailable" once the settle grace passes, and keep the market gate fresh (the 4 PM close).
    timers.push(setTimeout(emit, settleGraceMs + 100));
    timers.push(setInterval(() => {
      void refreshMarketState().then(emit);
    }, periodicEmitMs));
  } catch (error) {
    send({ type: "streamError", message: error instanceof Error ? error.message : String(error) });
    cleanup();
  }
}
