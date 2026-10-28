import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { baselineExpiryInRange, baselineMinimumBid, baselineMinimumSaleYield, baselineQuoteRejection, baselineSaleYield, type BaselineCommissions } from "../backtest/engine/baselineSaleSteps.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import { ladderDeltaVerdict, type LadderDeltaContext } from "../lib/ladderOrderGates.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { ladderBookCapitalVerdict } from "../lib/orderLimits.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import type { LiveOptionQuote } from "../lib/optionContractKey.js";
import type { ExecuteLadderOpenInput, ExecuteResult } from "./executor.js";
import type { PlutoGateResult, RecordPlutoActionInput } from "./ledger.js";
import { loadWorkingLadderSales } from "./ladderLookLoader.js";
import type { LadderSale, PlannedLadderSale } from "./ladderLookBook.js";
import type { LadderBaselineSettings } from "./ladderSettings.js";
import { midLimitPrice } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";

// The CC + Put Ladder's orders (Marcelo 2026-10-15 and 2026-10-21): the sales a look planned go out in order through
// Pluto's executor (the order routes and every gate), each re-quoted live first and priced at its mid on the option's
// tick, within the ladder's caps; the tightest binds and the rest wait for a later look:
//   working orders  at most ladderMaxWorkingOrdersPerTicker of the ticker's ladder orders work at once (the look counts
//                   the working ones as filled)
//   orders a day    at most ladderMaxOrdersPerTickerPerDay sent per ticker per day, every one counting, re-prices included;
//                   at most ladderMaxOrdersPerDay across the book
//   open positions  at most ladderMaxOpenPositionsPerTicker on the ticker, each sale opening one; across the book, at most
//                   ladderMaxOpenPositions open positions plus working ladder orders
//   capital         every ladder ticker's exposure and working orders together, after the sale, at most Pluto's capital
//                   budget × the account's value (ladderBookCapitalVerdict; the order gate checks it again at confirm)
// The live quote is held to the ladder's own contract rules once more (the bid's minimum, the spread, the expiry range,
// the minimum yield where it applies, the delta range for Calls and entry Puts); a sale that fails is blocked and planned
// afresh at a later look, never re-ranked or resized. An unfilled order is left to the 15-minute sweep and planned afresh
// at a later look; a partial fill moves on.

export interface LadderOrderCounts {
  workingOrders: number;
  ordersToday: number;
  openPositions: number;
}

/** Pluto's strategies, whose orders the caps count together (Marcelo 2026-10-27: Vol Farmer v2's under the ladder's caps). */
const plutoStrategiesUnderCaps = ["cc_put_ladder", "vol_farmer_v2"];

/** Pluto's open-order rows (open_* order requests of actions taken under its strategies) still working or not yet confirmed. */
function workingLadderOrderRows(connection: Knex) {
  return connection("order_requests as orq").join("pluto_actions as pa", "pa.id", "orq.pluto_action_id").whereIn("pa.execution_strategy", plutoStrategiesUnderCaps).whereIn("orq.status", [...activeOrderRequestStatuses]).whereRaw("orq.request_type like 'open_%'");
}

/** Pluto's orders sent on the Eastern date of `now`, under either strategy, on `symbol` or (null) across the book: every order built counts. */
export function ladderOrdersSentToday(now: Date, symbol: string | null, connection: Knex = db) {
  const query = connection("pluto_actions").whereIn("execution_strategy", plutoStrategiesUnderCaps).whereNotNull("order_request_id").whereRaw("(created_at at time zone 'America/New_York')::date = ?::date", [easternIsoDate(now)]);
  return (symbol === null ? query : query.where({ symbol })).count({ count: "*" }).first();
}

/** Ladder orders sent today across the book, as the book's daily cap counts them (the screen's "Orders today"). */
export async function loadLadderOrdersSentToday(now: Date, connection: Knex = db): Promise<number> {
  return Number((await ladderOrdersSentToday(now, null, connection))?.count ?? 0);
}

export async function loadLadderTickerOrderCounts(ticker: { tickerId: string; symbol: string }, now: Date, connection: Knex = db): Promise<LadderOrderCounts> {
  const [working, ordersToday, openPositions] = await Promise.all([
    loadWorkingLadderSales(ticker.symbol, connection),
    ladderOrdersSentToday(now, ticker.symbol, connection),
    connection("positions").where({ ticker_id: ticker.tickerId, status: "open" }).count({ count: "*" }).first(),
  ]);
  return { workingOrders: working.length, ordersToday: Number(ordersToday?.count ?? 0), openPositions: Number(openPositions?.count ?? 0) };
}

/** The book's counts: open positions on the ladder's tickers, the ladder's working orders on them, and its orders sent today. */
export async function loadLadderBookOrderCounts(tickers: readonly { tickerId: string; symbol: string }[], now: Date, connection: Knex = db): Promise<LadderOrderCounts> {
  const [working, ordersToday, openPositions] = await Promise.all([
    workingLadderOrderRows(connection).whereRaw("orq.payload->>'symbol' = any(?)", [tickers.map((ticker) => ticker.symbol)]).count({ count: "*" }).first(),
    ladderOrdersSentToday(now, null, connection),
    connection("positions").whereIn("ticker_id", tickers.map((ticker) => ticker.tickerId)).where({ status: "open" }).count({ count: "*" }).first(),
  ]);
  return { workingOrders: Number(working?.count ?? 0), ordersToday: Number(ordersToday?.count ?? 0), openPositions: Number(openPositions?.count ?? 0) };
}

/** The book as the round sees it: its counts, the capital its tickers commit, and Pluto's capital budget. Incremented as the round sends. */
export interface LadderBookRoom {
  counts: LadderOrderCounts;
  committedCapitalDollars: number;
  /** Pluto's capital budget as a share of the account (0.5 = 50%). */
  budgetFraction: number;
  netLiquidationValue: number;
}

/** Which cap holds a sale: one of the ticker's, or one of the book's. */
export type LadderCap = "ticker_working_orders" | "ticker_orders_per_day" | "ticker_open_positions" | "book_open_positions" | "book_orders_per_day" | "book_committed_capital";

export interface LadderWaitingSale {
  sale: PlannedLadderSale;
  cap: LadderCap;
  reason: string;
}

/** What a sale commits at an option price, net of the premium as the order gate counts it: a Put's strike, a Covered Call entry's shares. */
export function ladderSaleNotional(sale: Pick<LadderSale, "strategyKey" | "strike" | "contracts" | "sharesBought" | "stockPrice">, optionPrice: number): number {
  return sale.strategyKey === "cash_secured_put" ? Math.max(0, sale.strike - optionPrice) * 100 * sale.contracts : sale.sharesBought * Math.max(0, sale.stockPrice - optionPrice);
}

type LadderCapSettings = Pick<PlutoSettings, "ladderMaxWorkingOrdersPerTicker" | "ladderMaxOrdersPerTickerPerDay" | "ladderMaxOpenPositionsPerTicker" | "ladderMaxOpenPositions" | "ladderMaxOrdersPerDay">;

/**
 * Pure: the planned sales the caps let go now, in the look's order, and why the rest wait. The counted caps (the ticker's
 * and the book's) let the first `room` sales go, the tightest binding; the book's capital then lets them go in order up to
 * the first that would take it over Pluto's capital budget (at the sale's planned price), which waits with every one after it.
 */
export function admitLadderSales(planned: readonly PlannedLadderSale[], ticker: LadderOrderCounts, book: LadderBookRoom, settings: LadderCapSettings): { send: PlannedLadderSale[]; waiting: LadderWaitingSale[] } {
  const caps: { cap: LadderCap; room: number; reason: string }[] = [
    { cap: "ticker_working_orders", room: settings.ladderMaxWorkingOrdersPerTicker - ticker.workingOrders, reason: `${ticker.workingOrders} of the ticker's orders are working, at most ${settings.ladderMaxWorkingOrdersPerTicker} at once` },
    { cap: "ticker_orders_per_day", room: settings.ladderMaxOrdersPerTickerPerDay - ticker.ordersToday, reason: `${ticker.ordersToday} of the ticker's ${settings.ladderMaxOrdersPerTickerPerDay} orders a day are sent` },
    { cap: "ticker_open_positions", room: settings.ladderMaxOpenPositionsPerTicker - ticker.openPositions - ticker.workingOrders, reason: `the ticker has ${ticker.openPositions} open position(s) and ${ticker.workingOrders} working order(s), at most ${settings.ladderMaxOpenPositionsPerTicker} positions` },
    { cap: "book_open_positions", room: settings.ladderMaxOpenPositions - book.counts.openPositions - book.counts.workingOrders, reason: `the ladder's tickers have ${book.counts.openPositions} open position(s) and ${book.counts.workingOrders} working order(s), at most ${settings.ladderMaxOpenPositions} across the book` },
    { cap: "book_orders_per_day", room: settings.ladderMaxOrdersPerDay - book.counts.ordersToday, reason: `${book.counts.ordersToday} of the book's ${settings.ladderMaxOrdersPerDay} ladder orders a day are sent` },
  ];
  const binding = caps.reduce((tightest, cap) => (cap.room < tightest.room ? cap : tightest));
  const sendCount = Math.min(planned.length, Math.max(0, binding.room));
  const send: PlannedLadderSale[] = [];
  let committed = book.committedCapitalDollars;
  for (const sale of planned.slice(0, sendCount)) {
    const verdict = ladderBookCapitalVerdict({ committedBeforeDollars: committed, orderNotional: ladderSaleNotional(sale, sale.optionPrice), budgetFraction: book.budgetFraction, netLiquidationValue: book.netLiquidationValue });
    if (!verdict.fits) break;
    send.push(sale);
    committed = verdict.committedAfterDollars;
  }
  const capitalReason = `the ladder's tickers would commit more than Pluto's capital budget of ${formatWholeDollars(book.budgetFraction * book.netLiquidationValue)} together (${formatWholeDollars(committed)} committed)`;
  const waiting = planned.slice(send.length).map((sale, index): LadderWaitingSale => (send.length + index < sendCount ? { sale, cap: "book_committed_capital", reason: capitalReason } : { sale, cap: binding.cap, reason: binding.reason }));
  return { send, waiting };
}

/**
 * Pure: the ladder's own contract rules on a sale's live quote (the shared steps' predicates, baselineSaleSteps.ts): a bid of
 * at least the minimum with an ask above it, the spread within the ladder's share of the mid, the expiry still in range,
 * and, for the sales it applies to (the entries), a premium yield on the live mid above the minimum. Null when all pass.
 */
export function ladderLiveRuleFailure(input: { sale: Pick<PlannedLadderSale, "step" | "expiry" | "strike" | "right">; bid: number; ask: number; stockPrice: number; todayIso: string; now: Date; closeMinutesEt: number; baseline: Pick<LadderBaselineSettings, "minDte" | "maxDte" | "maxSpreadPctOfMid" | "minCallYieldPct" | "minCallYieldAppliesTo">; commissions: BaselineCommissions }): string | null {
  const { sale, bid, ask, baseline } = input;
  const quoteRejection = baselineQuoteRejection({ bid, ask }, baseline.maxSpreadPctOfMid);
  if (quoteRejection === "noUsableQuote") return `the live bid ${bid.toFixed(2)} is under the ladder's ${baselineMinimumBid.toFixed(2)} minimum, or the ask is not above it`;
  const mid = (bid + ask) / 2;
  if (quoteRejection === "spreadTooWide") return `the live spread is ${(((ask - bid) / mid) * 100).toFixed(1)}% of the mid, above the ladder's ${baseline.maxSpreadPctOfMid}%`;
  const dte = daysToExpiry(sale.expiry, input.todayIso);
  if (!baselineExpiryInRange(dte, baseline)) return `${dte} DTE is outside the ladder's ${baseline.minDte}–${baseline.maxDte} days`;
  const minimumYield = baselineMinimumSaleYield(baseline, sale.right, sale.step === "entry", sale.step === "ladder_put");
  if (minimumYield === null) return null;
  const yearsToExpiry = dte === 0 ? yearsToSessionClose(input.now, input.closeMinutesEt) : yearsBetweenIsoDates(input.todayIso, sale.expiry);
  const { premiumYield } = baselineSaleYield({ isCall: sale.right === "C", fillPrice: mid, strike: sale.strike, stockPrice: input.stockPrice, yearsToExpiry, commissions: input.commissions });
  if (premiumYield === null) return "no time value left on the live mid after the commission";
  if (!(premiumYield > minimumYield)) return `the premium yield on the live mid is ${(premiumYield * 100).toFixed(1)}% a year, not above the ${+(minimumYield * 100).toFixed(4)}% minimum`;
  return null;
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
  /** The order built for it, when one was (a refusal at confirm included); null when none was. */
  orderId: string | null;
  limitPrice: number | null;
  /** Blocked by the ladder's own live re-check (quote, its time, the contract rules, the delta range) before any order. */
  blockedOnLiveCheck: boolean;
}

/** Sends the admitted sales one by one: live quote, the ladder's rules and delta range on it, the mid on the tick as the limit, then the order. */
export async function sendLadderSales(
  input: {
    passId: string;
    symbol: string;
    tickerId: string;
    sales: readonly PlannedLadderSale[];
    deltaContext: Omit<LadderDeltaContext, "forwardAnchor">;
    forwardAnchors: ReadonlyMap<string, { forward: number; spotPrice: number }>;
    stockPrice: number;
    todayIso: string;
    /** The ticker's ladder settings and the commissions the look ranked with: the contract rules re-run on the live quote. */
    baseline: LadderBaselineSettings;
    commissions: BaselineCommissions;
  },
  dependencies: LadderOrderDependencies,
): Promise<LadderSaleOutcome[]> {
  const outcomes: LadderSaleOutcome[] = [];
  for (const sale of input.sales) {
    const deltaContext: LadderDeltaContext = { ...input.deltaContext, forwardAnchor: input.forwardAnchors.get(sale.expiry) ?? null };
    const contract = { expiry: sale.expiry, strike: sale.strike, right: sale.right };
    const [live] = await dependencies.burst(input.symbol, [contract]);
    const now = dependencies.now();
    const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
    const quotedAt = live?.quotedAt ?? null;
    const isEntryPut = sale.right === "P" && sale.step === "entry";
    const ruleFailure = twoSided ? ladderLiveRuleFailure({ sale, ...twoSided, stockPrice: input.stockPrice, todayIso: input.todayIso, now, closeMinutesEt: input.deltaContext.closeMinutesEt, baseline: input.baseline, commissions: input.commissions }) : null;
    const verdict = twoSided ? ladderDeltaVerdict({ ...twoSided, stockPrice: input.stockPrice, strike: sale.strike, expiryIso: sale.expiry, isCall: sale.right === "C", putHeldToRange: isEntryPut, now, context: deltaContext }) : null;
    const limitPrice = twoSided ? midLimitPrice(twoSided.bid, twoSided.ask, input.symbol) : null;
    const describeDelta = (delta: number | null) => (sale.right === "P" && !isEntryPut ? `own |delta| ${delta === null ? "unknown" : Math.abs(delta).toFixed(3)} (the ladder's Puts have no |delta| range)` : `own |delta| ${Math.abs(delta!).toFixed(3)} inside ${deltaContext.minAbsDelta}–${deltaContext.maxAbsDelta}`);
    const gateResults: PlutoGateResult[] = [
      { gate: "ladder", ok: true, detail: sale.chosenBecause },
      { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : "no live two-sided quote" },
      ...(twoSided ? [{ gate: "quote_time", ok: quotedAt !== null, detail: quotedAt ?? "the live quote carries no time" }] : []),
      ...(twoSided ? [{ gate: "ladder_rules", ok: ruleFailure === null, detail: ruleFailure ?? "the live quote passes the ladder's bid, spread, expiry and yield rules" }] : []),
      ...(verdict ? [{ gate: "ladder_delta", ok: verdict.compliant, detail: verdict.reason ?? describeDelta(verdict.delta) }] : []),
    ];
    const ok = gateResults.every((gate) => gate.ok) && verdict?.compliant === true && limitPrice !== null;
    const dte = daysToExpiry(sale.expiry, input.todayIso);
    const actionId = await dependencies.recordAction({
      passId: input.passId,
      kind: sale.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put",
      symbol: input.symbol,
      tickerId: input.tickerId,
      contract: { strategyKey: sale.strategyKey, ...contract, saleStep: sale.step },
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
      outcomes.push({ sale, actionId, outcome: "blocked", detail, orderId: null, limitPrice, blockedOnLiveCheck: true });
      continue;
    }
    await dependencies.recordEvent("action_validated", { passId: input.passId, actionId, symbol: input.symbol, quantity: sale.contracts, limitPrice, reasons: [sale.chosenBecause] });
    const plan = { quantity: sale.contracts, limitPrice: limitPrice!, notional: ladderSaleNotional(sale, limitPrice!), fullSizeQuantity: sale.contracts };
    const result = await dependencies.execute({
      kind: "ladder_open",
      actionId,
      symbol: input.symbol,
      strategyKey: sale.strategyKey,
      contract: { ...contract, dte },
      plan,
      buyEveryShare: sale.strategyKey === "covered_call" && sale.sharesBought === sale.contracts * 100,
      reasons: [`CC + Put Ladder: ${sale.chosenBecause}.`],
      scoresSnapshot: { kind: "ladder", version: "ladder-1", contract: { ...contract, bid: twoSided!.bid, ask: twoSided!.ask, quoteSource: "live", quotedAt, delta: verdict!.delta }, sale: { contracts: sale.contracts, sharesBought: sale.sharesBought, step: sale.step, chosenBecause: sale.chosenBecause, scores: sale.scores } },
    });
    outcomes.push({ sale, actionId, outcome: result.outcome, detail: result.detail, orderId: result.orderId, limitPrice: plan.limitPrice, blockedOnLiveCheck: false });
    if (result.outcome === "confirmed" && result.orderId) dependencies.watch({ actionId, orderId: result.orderId, symbol: input.symbol, limitPrice: plan.limitPrice, quantity: plan.quantity, description: result.detail, otherReferenceLegs: result.otherReferenceLegs });
  }
  return outcomes;
}
