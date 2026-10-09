import type { Request, Response } from "express";
import { settleGraceMs, subscribeToPooledQuote } from "../ibkr/marketDataPool.js";
import { loadCloseLiveInputs, toCloseLiveQuote } from "../lib/closeGate.js";
import { closeCommissionRates, flatCommissionEstimator, flatStockCommissionEstimator, loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { deriveCloseLiveState, type CloseLiveQuote } from "../lib/closeLiveState.js";
import { computeMarketSessionStatus, type MarketSessionState } from "../lib/marketSessionStatus.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Live data behind the Close form only (approved 2026-09-28): one SSE stream per open modal carrying the
// position's live bid/ask, the live wheel-cycle P&L and whether closing is allowed right now. It reads the
// shared quote pool exactly like the other streams (no extra IBKR lines), and nothing else consumes it.
// Each state also carries the commission rates the form uses to estimate the cycle P&L at its limit prices.

const positionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emitThrottleMs = 500;
const periodicEmitMs = 5_000;
const heartbeatIntervalMs = 20_000;

export async function streamCloseLiveHandler(request: Request, response: Response): Promise<void> {
  const positionId = String(request.params.id);
  if (!positionIdPattern.test(positionId)) {
    response.status(404).json({ error: "Position not found." });
    return;
  }

  // Legs, pool contracts and cycle inputs come from the same loader the server-side close gate
  // (lib/closeGate.ts) uses, so the form and the gate can never disagree on what to quote.
  const inputs = await loadCloseLiveInputs(positionId);
  if (!inputs) {
    response.status(404).json({ error: "Open position not found." });
    return;
  }
  const { symbol, legs } = inputs;

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const startedAt = Date.now();
  let closed = false;
  let marketState: MarketSessionState = "closed";
  let stockQuote: CloseLiveQuote | null = null;
  const optionQuotesByLegId: Record<string, CloseLiveQuote | null> = {};
  const unsubscribers: Array<() => void> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let commissionRates = closeCommissionRates(flatCommissionEstimator, flatStockCommissionEstimator);

  const emit = () => {
    if (closed) return;
    send({
      type: "state",
      data: {
        ...deriveCloseLiveState({
          symbol,
          positionId,
          legs,
          marketState,
          optionQuotesByLegId,
          stockQuote,
          cycleInput: inputs.cycleInput,
          todayIso: easternIsoDate(new Date()),
          waitedMs: Date.now() - startedAt,
          settleGraceMs,
        }),
        commissionRates,
      },
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
    const [, optionCommissionEstimator, stockCommissionEstimator] = await Promise.all([refreshMarketState(), loadCommissionEstimator(), loadStockCommissionEstimator()]);
    commissionRates = closeCommissionRates(optionCommissionEstimator, stockCommissionEstimator);
    const contracts = inputs.contracts.map(({ key, contract }) => ({
      contract,
      onQuote: (quote: CloseLiveQuote) => {
        if (key === "stock") stockQuote = quote;
        else optionQuotesByLegId[key] = quote;
      },
    }));
    for (const { contract, onQuote } of contracts) {
      const unsubscribe = await subscribeToPooledQuote(contract, (quote) => {
        onQuote(toCloseLiveQuote(quote));
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
