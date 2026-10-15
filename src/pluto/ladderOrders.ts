import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { ladderDeltaVerdict, type LadderOrderGateContext } from "../lib/ladderOrderGates.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import type { LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import type { ExecuteLadderOpenInput, ExecuteResult } from "./executor.js";
import type { PlutoGateResult, RecordPlutoActionInput } from "./ledger.js";
import { loadWorkingLadderSales } from "./ladderLookLoader.js";
import type { PlannedLadderSale } from "./ladderLookBook.js";
import { midLimitPrice } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";

// The CC + Put Ladder's orders (Marcelo 2026-10-15): the sales a look planned go out in order through Pluto's executor
// (the order routes and every gate), each re-quoted live first and priced at its mid, within the ladder's caps:
//   working orders  at most ladderMaxWorkingOrdersPerTicker of the ticker's ladder orders work at once; the rest go at
//                   the next looks (the look counts the working ones as filled)
//   orders a day    at most ladderMaxOrdersPerTickerPerDay sent per ticker per day, every one counting, re-prices included
//   open positions  at most ladderMaxOpenPositionsPerTicker on the ticker; each sale opens one
// An unfilled order is left to the 15-minute sweep and planned afresh at a later look; a partial fill moves on.

export interface LadderTickerOrderCounts {
  workingOrders: number;
  ordersToday: number;
  openPositions: number;
}

export async function loadLadderTickerOrderCounts(ticker: { tickerId: string; symbol: string }, now: Date, connection: Knex = db): Promise<LadderTickerOrderCounts> {
  const [working, ordersToday, openPositions] = await Promise.all([
    loadWorkingLadderSales(ticker.symbol, connection),
    connection("pluto_actions")
      .where({ symbol: ticker.symbol, execution_strategy: "cc_put_ladder" })
      .whereNotNull("order_request_id")
      .whereRaw("(created_at at time zone 'America/New_York')::date = ?::date", [easternIsoDate(now)])
      .count({ count: "*" })
      .first(),
    connection("positions").where({ ticker_id: ticker.tickerId, status: "open" }).count({ count: "*" }).first(),
  ]);
  return { workingOrders: working.length, ordersToday: Number(ordersToday?.count ?? 0), openPositions: Number(openPositions?.count ?? 0) };
}

/** Pure: the planned sales the caps let go now, in the look's order, and why the rest wait. */
export function admitLadderSales(planned: readonly PlannedLadderSale[], counts: LadderTickerOrderCounts, settings: Pick<PlutoSettings, "ladderMaxWorkingOrdersPerTicker" | "ladderMaxOrdersPerTickerPerDay" | "ladderMaxOpenPositionsPerTicker">): { send: PlannedLadderSale[]; waiting: { sale: PlannedLadderSale; reason: string }[] } {
  const caps = [
    { room: settings.ladderMaxWorkingOrdersPerTicker - counts.workingOrders, reason: `${counts.workingOrders} of the ticker's orders are working, at most ${settings.ladderMaxWorkingOrdersPerTicker} at once` },
    { room: settings.ladderMaxOrdersPerTickerPerDay - counts.ordersToday, reason: `${counts.ordersToday} of the ticker's ${settings.ladderMaxOrdersPerTickerPerDay} orders a day are sent` },
    { room: settings.ladderMaxOpenPositionsPerTicker - counts.openPositions - counts.workingOrders, reason: `the ticker has ${counts.openPositions} open position(s) and ${counts.workingOrders} working order(s), at most ${settings.ladderMaxOpenPositionsPerTicker} positions` },
  ];
  const binding = caps.reduce((tightest, cap) => (cap.room < tightest.room ? cap : tightest));
  const sendCount = Math.max(0, binding.room);
  const reason = binding.reason;
  return { send: planned.slice(0, sendCount), waiting: planned.slice(sendCount).map((sale) => ({ sale, reason })) };
}

export interface LadderOrderDependencies {
  burst(symbol: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[]): Promise<LiveOptionQuote[]>;
  recordAction(input: RecordPlutoActionInput): Promise<string>;
  /** Pluto's event log: a sale validated before it is sent, or blocked by the ladder's own check (the executor logs the rest). */
  recordEvent(type: "action_validated" | "action_blocked", detail: Record<string, unknown>): Promise<void>;
  execute(input: ExecuteLadderOpenInput): Promise<ExecuteResult>;
  /** Watches a confirmed order to its end (the agent keeps the watch alive after the pass). */
  watch(input: { actionId: string; orderId: string; symbol: string; limitPrice: number; quantity: number; description: string; otherReferenceLegs: ExecuteResult["otherReferenceLegs"] }): void;
  now(): Date;
}

export interface LadderSaleOutcome {
  sale: PlannedLadderSale;
  actionId: string;
  outcome: ExecuteResult["outcome"] | "blocked";
  detail: string;
}

/** Sends the admitted sales one by one: live quote, the ladder's delta range on it, the mid as the limit, then the order. */
export async function sendLadderSales(
  input: { passId: string; symbol: string; tickerId: string; sales: readonly PlannedLadderSale[]; gateContext: Omit<LadderOrderGateContext, "forwardAnchor">; forwardAnchors: ReadonlyMap<string, { forward: number; spotPrice: number }>; stockPrice: number; todayIso: string },
  dependencies: LadderOrderDependencies,
): Promise<LadderSaleOutcome[]> {
  const outcomes: LadderSaleOutcome[] = [];
  for (const sale of input.sales) {
    const gateContext: LadderOrderGateContext = { ...input.gateContext, forwardAnchor: input.forwardAnchors.get(sale.expiry) ?? null };
    const contract = { expiry: sale.expiry, strike: sale.strike, right: sale.right };
    const [live] = await dependencies.burst(input.symbol, [contract]);
    const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
    const verdict = twoSided ? ladderDeltaVerdict({ ...twoSided, stockPrice: input.stockPrice, strike: sale.strike, expiryIso: sale.expiry, isCall: sale.right === "C", now: dependencies.now(), context: gateContext }) : null;
    const limitPrice = twoSided ? midLimitPrice(twoSided.bid, twoSided.ask) : null;
    const gateResults: PlutoGateResult[] = [
      { gate: "ladder", ok: true, detail: sale.chosenBecause },
      { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : "no live two-sided quote" },
      ...(verdict ? [{ gate: "ladder_delta", ok: verdict.compliant, detail: verdict.reason ?? `own |delta| ${Math.abs(verdict.delta!).toFixed(3)} inside ${gateContext.minAbsDelta}–${gateContext.maxAbsDelta}` }] : []),
    ];
    const ok = twoSided !== null && verdict?.compliant === true && limitPrice !== null;
    const dte = daysToExpiry(sale.expiry, input.todayIso);
    const actionId = await dependencies.recordAction({
      passId: input.passId,
      kind: sale.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put",
      symbol: input.symbol,
      tickerId: input.tickerId,
      contract: { strategyKey: sale.strategyKey, ...contract },
      candidateScores: { ...sale.candidate, ...sale.scores, eligibleCount: sale.eligibleCount, sharesBought: sale.sharesBought, stockPrice: sale.stockPrice },
      deterministicTopPick: null,
      gateResults,
      sizeTier: null,
      quantity: sale.contracts,
      limitPrice,
      outcome: ok ? "validated" : "blocked",
      blockReason: ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "),
      referenceBid: twoSided?.bid ?? null,
      referenceMid: twoSided ? (twoSided.bid + twoSided.ask) / 2 : null,
    });
    if (!ok) {
      const detail = gateResults.filter((gate) => !gate.ok).map((gate) => gate.detail).join("; ");
      await dependencies.recordEvent("action_blocked", { passId: input.passId, actionId, symbol: input.symbol, stage: "ladder", reason: detail });
      outcomes.push({ sale, actionId, outcome: "blocked", detail });
      continue;
    }
    await dependencies.recordEvent("action_validated", { passId: input.passId, actionId, symbol: input.symbol, quantity: sale.contracts, limitPrice, reasons: [sale.chosenBecause] });
    const plan = { quantity: sale.contracts, limitPrice: limitPrice!, notional: sale.strategyKey === "cash_secured_put" ? (sale.strike - limitPrice!) * 100 * sale.contracts : sale.sharesBought * Math.max(0, input.stockPrice - limitPrice!), fullSizeQuantity: sale.contracts };
    const quotedAt = live!.quotedAt ?? dependencies.now().toISOString();
    const result = await dependencies.execute({
      kind: "ladder_open",
      actionId,
      symbol: input.symbol,
      strategyKey: sale.strategyKey,
      contract: { ...contract, dte },
      plan,
      buyEveryShare: sale.strategyKey === "covered_call" && sale.sharesBought === sale.contracts * 100,
      reasons: [`CC + Put Ladder: ${sale.chosenBecause}.`],
      scoresSnapshot: { kind: "ladder", version: "ladder-1", contract: { ...contract, bid: twoSided!.bid, ask: twoSided!.ask, quoteSource: "live", quotedAt, delta: verdict!.delta }, sale: { contracts: sale.contracts, sharesBought: sale.sharesBought, chosenBecause: sale.chosenBecause, scores: sale.scores } },
    });
    outcomes.push({ sale, actionId, outcome: result.outcome, detail: result.detail });
    if (result.outcome === "confirmed" && result.orderId) dependencies.watch({ actionId, orderId: result.orderId, symbol: input.symbol, limitPrice: plan.limitPrice, quantity: plan.quantity, description: result.detail, otherReferenceLegs: result.otherReferenceLegs });
  }
  return outcomes;
}
