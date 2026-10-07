import { db } from "../db/connection.js";
import { evaluateCloseGateForPosition } from "../lib/closeGate.js";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoCloseActionOffer } from "./prompt.js";
import type { PlutoSettings } from "./settingsStore.js";
import { formatSignedDollars } from "../lib/formatSignedDollars.js";
import { resolveIsOpenDay } from "../lib/marketSessionStatus.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";

// Formulas P1 and P2 (approved 2026-09-28) as deterministic offers. The model never invents a
// close: code decides which closes are even on the table, the model chooses among them (or the
// code executes them outright where no judgement is involved).
//
// P1 — unstructured shares: offered only when the live open-cycle P&L is at least the larger of
//   unstructuredCloseMinPct of the shares' capital and unstructuredCloseMinDollars, the position
//   is older than one full session, and the cycle has no data flags (the close gate says so).
//   Odd lots below 100 shares are closed on the same condition without a model call.
//   Never at a cycle loss.
// P2 — short-leg buyback: offered only when holdEdge$ − closeCost$ < 0, no credit roll on the leg
//   grades Weak or better, the leg's own P&L at the ask is positive, and at least buybackMinDte
//   remain. Never at a loss. Limited to single-leg positions (cash-secured puts): closing only the
//   call of a covered call is not allowed for anyone (Marcelo 2026-09-29), so it never becomes unstructured.
//   The leg's premium for the loss check is the price we set on it when it was opened by a two-part
//   order (Marcelo 2026-09-29): IBKR fills a combo at exactly its net but splits it between the legs
//   its own way, so its recorded fill for one leg is arbitrary (orderedEntryPremium).
// P3 — earnings buyback (approved 2026-10-07): a single-leg short whose expiry is on or after the ticker's next earnings
//   announcement is bought back by code, without a model call, within the last earningsBuybackWindowSessions sessions before
//   the announcement, and only when its P&L at the ask is positive (never at a loss). The last session before the
//   announcement is the report day for an after-close report, the session before it otherwise (before the open, or a time
//   TradingView does not know). P2's hold-edge, roll and minimum-DTE conditions do not apply: the point is the event.

export interface UnstructuredSharePosition {
  positionId: string;
  symbol: string;
  legId: string;
  shares: number;
  entryPrice: number;
  /** ISO time the stock leg was created. */
  entryAtIso: string;
}

export interface CloseOffer extends PlutoCloseActionOffer {
  positionId: string;
  legIds: string[];
  /** Executed by code without a model call (odd lots, earnings buybacks), with the rule that did it. */
  automatic: boolean;
  automaticReason: string | null;
  /** Reference price for the order and the pessimistic bracket. */
  limitPrice: number;
  side: "sell" | "buy";
  multiplier: number;
  quantity: number;
  /** The held option a buyback closes, recorded on the action so the screen can name it (close_leg only). */
  contract?: { strategyKey: "covered_call" | "cash_secured_put"; expiry: string; strike: number; right: "C" | "P" };
}

export interface OpeningTradeForPremium {
  quantity: number;
  price: number;
  /** The price we set on this leg in the order, when the order had more than one leg; null otherwise. */
  orderedLegPrice: number | null;
}

/**
 * Pure: the leg's recorded entry premium moved by IBKR's combo split — entry + (our leg price − IBKR's
 * leg fill), quantity-weighted over the opening trades. Keeps the recorded entry's commission treatment
 * and changes nothing for legs opened by single-leg orders. Null when no opening trade came from a combo.
 */
export function orderedEntryPremium(recordedEntryPrice: number, openingTrades: OpeningTradeForPremium[]): number | null {
  const totalQuantity = openingTrades.reduce((sum, trade) => sum + trade.quantity, 0);
  if (totalQuantity === 0 || openingTrades.every((trade) => trade.orderedLegPrice === null)) return null;
  const splitSkew = openingTrades.reduce((sum, trade) => sum + ((trade.orderedLegPrice ?? trade.price) - trade.price) * trade.quantity, 0) / totalQuantity;
  return recordedEntryPrice + splitSkew;
}

function normalizedExpiry(value: unknown): string {
  return String(value ?? "").replace(/-/g, "").slice(0, 8);
}

/** Opening trades per option leg, each with the price we set on that leg when its order had more than one leg. */
export async function loadOpeningTradesForPremium(legIds: string[]): Promise<Map<string, OpeningTradeForPremium[]>> {
  const result = new Map<string, OpeningTradeForPremium[]>();
  if (legIds.length === 0) return result;
  const rows: { legId: string; quantity: number; price: string; side: string; strike: string; expiry: Date | string; optionType: string; payload: { legs?: { role: string; action: string; strike?: number; expiry?: string; right?: string; unitPrice: number }[] } | null }[] = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .leftJoin("order_requests as o", "o.id", "t.source_order_request_id")
    .whereIn("t.position_leg_id", legIds)
    .where("t.is_closing_trade", false)
    .select("t.position_leg_id as legId", "t.quantity", "t.price", "t.side", "pl.strike_price as strike", db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as expiry"), "pl.option_type as optionType", "o.payload");
  for (const row of rows) {
    const orderLegs = row.payload?.legs ?? [];
    const orderedLeg =
      orderLegs.length > 1
        ? orderLegs.find(
            (leg) =>
              leg.role === "option" &&
              leg.action === (row.side === "sell" ? "SELL" : "BUY") &&
              Number(leg.strike) === Number(row.strike) &&
              normalizedExpiry(leg.expiry) === normalizedExpiry(row.expiry) &&
              leg.right === (row.optionType === "call" ? "C" : "P"),
          )
        : undefined;
    const trades = result.get(row.legId) ?? [];
    trades.push({ quantity: Number(row.quantity), price: Number(row.price), orderedLegPrice: orderedLeg ? Number(orderedLeg.unitPrice) : null });
    result.set(row.legId, trades);
  }
  return result;
}

export async function loadUnstructuredSharePositions(symbols: string[]): Promise<UnstructuredSharePosition[]> {
  if (symbols.length === 0) return [];
  const rows: { positionId: string; symbol: string; legId: string; quantity: number; entryPrice: string; entryAt: Date }[] = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .join("position_legs as pl", "pl.position_id", "p.id")
    .where("p.status", "open")
    .where("p.strategy_key", "unstructured")
    .whereIn("t.symbol", symbols)
    .where({ "pl.leg_type": "stock", "pl.side": "long" })
    .whereNull("pl.exit_at")
    .select("p.id as positionId", "t.symbol", "pl.id as legId", "pl.quantity", "pl.entry_price as entryPrice", "pl.entry_at as entryAt");
  return rows.map((row) => ({ positionId: row.positionId, symbol: row.symbol, legId: row.legId, shares: Number(row.quantity), entryPrice: Number(row.entryPrice), entryAtIso: new Date(row.entryAt).toISOString() }));
}

export interface P1Input {
  position: UnstructuredSharePosition;
  /** Live open-cycle P&L from the close gate; null when the gate blocks. */
  cycleTotal: number | null;
  cycleBlockReason: string | null;
  stockBid: number | null;
  stockAsk: number | null;
  settings: PlutoSettings;
  /** Previous open session's date: a position must have been created before it to count as "older than one full session". */
  previousSessionDateIso: string;
}

/** Pure P1: the offer, or the reason there is none. */
export function evaluateUnstructuredClose(input: P1Input): { offer: CloseOffer | null; reason: string | null } {
  const { position, settings } = input;
  if (input.cycleBlockReason) return { offer: null, reason: input.cycleBlockReason };
  if (input.cycleTotal === null) return { offer: null, reason: "no live cycle P&L" };
  if (position.entryAtIso.slice(0, 10) >= input.previousSessionDateIso) return { offer: null, reason: "position younger than one full session" };
  const capital = position.entryPrice * position.shares;
  const floor = Math.max((capital * settings.unstructuredCloseMinPct) / 100, settings.unstructuredCloseMinDollars);
  if (input.cycleTotal < floor) return { offer: null, reason: `cycle P&L ${input.cycleTotal.toFixed(0)} below the floor ${floor.toFixed(0)}` };
  if (input.stockBid === null || input.stockAsk === null || !(input.stockBid > 0) || input.stockAsk < input.stockBid) return { offer: null, reason: "no live two-sided stock quote" };
  const limitPrice = Math.round(((input.stockBid + input.stockAsk) / 2) * 100) / 100;
  const oddLot = position.shares < 100;
  return {
    offer: {
      id: `${position.symbol}:close_shares:${position.positionId}`,
      kind: "close_shares",
      symbol: position.symbol,
      description: `Sell ${position.shares} ${position.symbol} shares (unstructured) at ~${limitPrice.toFixed(2)}; open cycle P&L ${input.cycleTotal.toFixed(0)}`,
      cycle_pnl: input.cycleTotal,
      detail: { shares: position.shares, entry_price: position.entryPrice, cycle_pnl_pct_of_capital: capital > 0 ? Math.round((input.cycleTotal / capital) * 1000) / 10 : null, odd_lot: oddLot || undefined },
      positionId: position.positionId,
      legIds: [position.legId],
      automatic: oddLot,
      automaticReason: oddLot ? "odd lot below 100 shares at a positive cycle P&L (Formula P1)" : null,
      limitPrice,
      side: "sell",
      multiplier: 1,
      quantity: position.shares,
    },
    reason: null,
  };
}

export interface P2Input {
  symbol: string;
  leg: HeldLegScore;
  rolls: RollSignalCandidate[];
  settings: PlutoSettings;
  /** Whether the leg's position has exactly this one open leg (the close route needs every leg). */
  singleLegPosition: boolean;
  /** The leg's premium corrected for a combo split (orderedEntryPremium); null = use the recorded entry. */
  orderedEntryPremium?: number | null;
}

/** Pure P2: the buyback offer, or the reason there is none. */
export function evaluateShortLegBuyback(input: P2Input): { offer: CloseOffer | null; reason: string | null } {
  const { leg, settings } = input;
  const entryPremium = input.orderedEntryPremium ?? leg.entryPrice;
  if (leg.unscoredReason) return { offer: null, reason: `held leg not scored: ${leg.unscoredReason}` };
  if (!input.singleLegPosition) return { offer: null, reason: "buybacks are limited to single-leg positions for now" };
  if (leg.holdEdgeDollars === null || leg.closeCostDollars === null) return { offer: null, reason: "no hold edge / close cost" };
  if (leg.holdEdgeDollars - leg.closeCostDollars >= 0) return { offer: null, reason: `holding is still worth ${formatSignedDollars(leg.holdEdgeDollars - leg.closeCostDollars, 0)} per contract more than buying back, after closing costs` };
  if (input.rolls.some((roll) => roll.legId === leg.legId && roll.grade !== "avoid")) return { offer: null, reason: "a credit roll grades Weak or better" };
  if (leg.dte === null || leg.dte < settings.buybackMinDte) return { offer: null, reason: `DTE ${leg.dte ?? "unknown"} below ${settings.buybackMinDte}` };
  if (leg.ask === null || leg.bid === null || !(leg.ask > 0) || leg.ask < leg.bid) return { offer: null, reason: "no live two-sided quote on the held leg" };
  const pnlAtAsk = (entryPremium - leg.ask) * leg.quantity * 100;
  if (pnlAtAsk <= 0) return { offer: null, reason: pnlAtAsk < 0 ? `buying back at the ask would lose ${formatSignedDollars(-pnlAtAsk, 0)}` : "buying back at the ask would only break even" };
  const limitPrice = Math.round(((leg.bid + leg.ask) / 2) * 100) / 100;
  return {
    offer: {
      id: `${input.symbol}:close_leg:${leg.legId}`,
      kind: "close_leg",
      symbol: input.symbol,
      description: `Buy back ${leg.quantity}× ${input.symbol} $${leg.strike}${leg.right} ${leg.expiry} at ~${limitPrice.toFixed(2)} (sold at ${entryPremium.toFixed(2)}); locks ${pnlAtAsk.toFixed(0)} at the ask`,
      cycle_pnl: pnlAtAsk,
      detail: { dte: leg.dte, entry_credit: entryPremium, recorded_entry_credit: leg.entryPrice, ask: leg.ask, hold_edge_dollars: Math.round(leg.holdEdgeDollars), close_cost_dollars: Math.round(leg.closeCostDollars), pnl_at_ask: Math.round(pnlAtAsk) },
      positionId: leg.positionId,
      legIds: [leg.legId],
      automatic: false,
      automaticReason: null,
      limitPrice,
      side: "buy",
      multiplier: 100,
      quantity: leg.quantity,
      contract: { strategyKey: leg.right === "C" ? "covered_call" : "cash_secured_put", expiry: leg.expiry, strike: leg.strike, right: leg.right },
    },
    reason: null,
  };
}

export const earningsBuybackWindowSessions = 5;

export interface UpcomingEarnings {
  dateIso: string;
  /** TradingView's event_time: "-1" before the open, "1" after the close, "0" or null unknown. */
  time: string | null;
}

const earningsTimeLabel = (time: string | null) => (time === "1" ? "after the close" : time === "-1" ? "before the open" : "time unknown");

/** The ticker's next earnings announcement still to come (a report before today's open is already out). */
export async function loadUpcomingEarnings(symbol: string, todayIso: string): Promise<UpcomingEarnings | null> {
  const row = await db("ticker_calendar_events as e")
    .join("tickers as t", "t.id", "e.ticker_id")
    .where({ "t.symbol": symbol, "e.event_type": "earnings" })
    .where("e.event_date", ">=", todayIso)
    .whereRaw("not (e.event_date = ?::date and e.event_time is not distinct from '-1')", [todayIso])
    .orderBy("e.event_date")
    .first(db.raw("e.event_date::text as \"dateIso\""), "e.event_time as time");
  return row ? { dateIso: row.dateIso, time: row.time ?? null } : null;
}

/** Pure: open sessions from today through the last session before the announcement (at least 1 while it is still ahead). */
export function countSessionsLeftBeforeEarnings(todayIso: string, earnings: UpcomingEarnings, openDaysIso: string[]): number {
  const announcementDayCounts = earnings.time === "1" && openDaysIso.includes(earnings.dateIso);
  const lastSession = [...openDaysIso].filter((day) => (announcementDayCounts ? day <= earnings.dateIso : day < earnings.dateIso)).sort().at(-1);
  if (!lastSession) return 1;
  return Math.max(1, openDaysIso.filter((day) => day >= todayIso && day <= lastSession).length);
}

/** Calendar days today..date inclusive (YYYY-MM-DD). */
function calendarDaysThrough(todayIso: string, endIso: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${todayIso}T12:00:00Z`); at <= Date.parse(`${endIso}T12:00:00Z`); at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

export interface P3Input {
  symbol: string;
  leg: HeldLegScore;
  singleLegPosition: boolean;
  orderedEntryPremium?: number | null;
  earnings: UpcomingEarnings | null;
  /** countSessionsLeftBeforeEarnings, or null when the announcement is too far off to count. */
  sessionsLeft: number | null;
}

/** Pure P3: the automatic buyback, the reason there is none, or neither when the leg does not span an announcement. */
export function evaluateEarningsBuyback(input: P3Input): { offer: CloseOffer | null; reason: string | null } {
  const { leg, earnings } = input;
  if (!earnings || leg.expiry < earnings.dateIso) return { offer: null, reason: null };
  const spans = `expires after the ${earnings.dateIso} earnings (${earningsTimeLabel(earnings.time)})`;
  if (!input.singleLegPosition) return { offer: null, reason: `${spans}, but buybacks are limited to single-leg positions` };
  if (input.sessionsLeft === null || input.sessionsLeft > earningsBuybackWindowSessions) return { offer: null, reason: `${spans}; bought back only in the last ${earningsBuybackWindowSessions} sessions before it` };
  if (leg.ask === null || leg.bid === null || !(leg.ask > 0) || leg.ask < leg.bid) return { offer: null, reason: `${spans}; no live two-sided quote on the held leg` };
  const entryPremium = input.orderedEntryPremium ?? leg.entryPrice;
  const pnlAtAsk = (entryPremium - leg.ask) * leg.quantity * 100;
  if (pnlAtAsk <= 0) return { offer: null, reason: `${spans}; buying back at the ask would ${pnlAtAsk < 0 ? `lose ${formatSignedDollars(-pnlAtAsk, 0)}` : "only break even"}, so it stays open` };
  const limitPrice = Math.round(((leg.bid + leg.ask) / 2) * 100) / 100;
  return {
    offer: {
      id: `${input.symbol}:close_leg:${leg.legId}`,
      kind: "close_leg",
      symbol: input.symbol,
      description: `Buy back ${leg.quantity}× ${input.symbol} $${leg.strike}${leg.right} ${leg.expiry} at ~${limitPrice.toFixed(2)} (sold at ${entryPremium.toFixed(2)}) before the ${earnings.dateIso} earnings; locks ${pnlAtAsk.toFixed(0)} at the ask`,
      cycle_pnl: pnlAtAsk,
      detail: { dte: leg.dte, entry_credit: entryPremium, recorded_entry_credit: leg.entryPrice, ask: leg.ask, earnings_date: earnings.dateIso, earnings_time: earnings.time, sessions_left: input.sessionsLeft, pnl_at_ask: Math.round(pnlAtAsk) },
      positionId: leg.positionId,
      legIds: [leg.legId],
      automatic: true,
      automaticReason: `${spans}: bought back at a profit within the last ${earningsBuybackWindowSessions} sessions before it (Formula P3)`,
      limitPrice,
      side: "buy",
      multiplier: 100,
      quantity: leg.quantity,
      contract: { strategyKey: leg.right === "C" ? "covered_call" : "cash_secured_put", expiry: leg.expiry, strike: leg.strike, right: leg.right },
    },
    reason: null,
  };
}

/** Whether the position already has an order that may still be working (a second one would be refused by the order route). */
async function positionHasActiveOrder(positionId: string): Promise<boolean> {
  return Boolean(await db("order_requests").where({ related_position_id: positionId }).whereIn("status", activeOrderRequestStatuses).first("id"));
}

/** Everything close-related for one ticker this pass: offers for the model, automatic ones for code, and why the rest were skipped. */
export async function buildCloseOffersForTicker(input: {
  symbol: string;
  heldLegs: HeldLegScore[];
  rolls: RollSignalCandidate[];
  settings: PlutoSettings;
  stockBid: number | null;
  stockAsk: number | null;
  previousSessionDateIso: string;
  todayIso: string;
}): Promise<{ offers: CloseOffer[]; skipped: { id: string; reason: string }[] }> {
  const offers: CloseOffer[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const sharePositions = await loadUnstructuredSharePositions([input.symbol]);
  for (const position of sharePositions) {
    const gate = await evaluateCloseGateForPosition(position.positionId);
    const result = evaluateUnstructuredClose({ position, cycleTotal: gate.cycleTotal, cycleBlockReason: gate.blocked ? gate.reason : null, stockBid: input.stockBid, stockAsk: input.stockAsk, settings: input.settings, previousSessionDateIso: input.previousSessionDateIso });
    if (result.offer) offers.push(result.offer);
    else skipped.push({ id: `${input.symbol}:close_shares:${position.positionId}`, reason: result.reason ?? "not offered" });
  }
  if (input.heldLegs.length > 0) {
    const legCounts: { position_id: string; count: string }[] = await db("position_legs").whereIn("position_id", [...new Set(input.heldLegs.map((leg) => leg.positionId))]).whereNull("exit_at").groupBy("position_id").select("position_id").count("* as count");
    const openLegCountByPosition = new Map(legCounts.map((row) => [row.position_id, Number(row.count)]));
    const openingTradesByLeg = await loadOpeningTradesForPremium(input.heldLegs.map((leg) => leg.legId));
    const earnings = await loadUpcomingEarnings(input.symbol, input.todayIso);
    // Five sessions never reach past fourteen calendar days, so a later announcement needs no calendar lookups.
    const earningsDays = earnings && Date.parse(earnings.dateIso) - Date.parse(input.todayIso) <= 14 * 86_400_000 ? calendarDaysThrough(input.todayIso, earnings.dateIso) : null;
    const openDays = earningsDays ? (await Promise.all(earningsDays.map(async (day) => ((await resolveIsOpenDay(day)) ? day : null)))).filter((day): day is string => day !== null) : null;
    const sessionsLeft = earnings && openDays ? countSessionsLeftBeforeEarnings(input.todayIso, earnings, openDays) : null;
    for (const leg of input.heldLegs) {
      const singleLegPosition = (openLegCountByPosition.get(leg.positionId) ?? 0) === 1;
      const orderedPremium = orderedEntryPremium(leg.entryPrice, openingTradesByLeg.get(leg.legId) ?? []);
      const earningsResult = evaluateEarningsBuyback({ symbol: input.symbol, leg, singleLegPosition, orderedEntryPremium: orderedPremium, earnings, sessionsLeft });
      if (earningsResult.offer && !(await positionHasActiveOrder(leg.positionId))) {
        offers.push(earningsResult.offer);
        continue;
      }
      if (earningsResult.reason) skipped.push({ id: `${input.symbol}:earnings_close:${leg.legId}`, reason: earningsResult.reason });
      const result = evaluateShortLegBuyback({
        symbol: input.symbol,
        leg,
        rolls: input.rolls,
        settings: input.settings,
        singleLegPosition,
        orderedEntryPremium: orderedPremium,
      });
      if (result.offer) offers.push(result.offer);
      else skipped.push({ id: `${input.symbol}:close_leg:${leg.legId}`, reason: result.reason ?? "not offered" });
    }
  }
  return { offers, skipped };
}
