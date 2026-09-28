import { db } from "../db/connection.js";
import { evaluateCloseGateForPosition } from "../lib/closeGate.js";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoCloseActionOffer } from "./prompt.js";
import type { PlutoSettings } from "./settingsStore.js";

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
//   remain. Never at a loss. Limited to single-leg positions (cash-secured puts) because the close
//   route requires every open leg of a structured position; a covered call's call-only buyback
//   needs a route extension first.

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
  /** Executed by code without a model call (odd lots). */
  automatic: boolean;
  /** Reference price for the order and the pessimistic bracket. */
  limitPrice: number;
  side: "sell" | "buy";
  multiplier: number;
  quantity: number;
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
}

/** Pure P2: the buyback offer, or the reason there is none. */
export function evaluateShortLegBuyback(input: P2Input): { offer: CloseOffer | null; reason: string | null } {
  const { leg, settings } = input;
  if (leg.unscoredReason) return { offer: null, reason: `held leg not scored: ${leg.unscoredReason}` };
  if (!input.singleLegPosition) return { offer: null, reason: "buybacks are limited to single-leg positions for now" };
  if (leg.holdEdgeDollars === null || leg.closeCostDollars === null) return { offer: null, reason: "no hold edge / close cost" };
  if (leg.holdEdgeDollars - leg.closeCostDollars >= 0) return { offer: null, reason: `holding still offers ${(leg.holdEdgeDollars - leg.closeCostDollars).toFixed(0)}/contract net of closing` };
  if (input.rolls.some((roll) => roll.legId === leg.legId && roll.grade !== "avoid")) return { offer: null, reason: "a credit roll grades Weak or better" };
  if (leg.dte === null || leg.dte < settings.buybackMinDte) return { offer: null, reason: `DTE ${leg.dte ?? "unknown"} below ${settings.buybackMinDte}` };
  if (leg.ask === null || leg.bid === null || !(leg.ask > 0) || leg.ask < leg.bid) return { offer: null, reason: "no live two-sided quote on the held leg" };
  const pnlAtAsk = (leg.entryPrice - leg.ask) * leg.quantity * 100;
  if (pnlAtAsk <= 0) return { offer: null, reason: `buying back at the ask would realise ${pnlAtAsk.toFixed(0)}` };
  const limitPrice = Math.round(((leg.bid + leg.ask) / 2) * 100) / 100;
  return {
    offer: {
      id: `${input.symbol}:close_leg:${leg.legId}`,
      kind: "close_leg",
      symbol: input.symbol,
      description: `Buy back ${leg.quantity}× ${input.symbol} $${leg.strike}${leg.right} ${leg.expiry} at ~${limitPrice.toFixed(2)} (sold at ${leg.entryPrice.toFixed(2)}); locks ${pnlAtAsk.toFixed(0)} at the ask`,
      cycle_pnl: pnlAtAsk,
      detail: { dte: leg.dte, entry_credit: leg.entryPrice, ask: leg.ask, hold_edge_dollars: Math.round(leg.holdEdgeDollars), close_cost_dollars: Math.round(leg.closeCostDollars), pnl_at_ask: Math.round(pnlAtAsk) },
      positionId: leg.positionId,
      legIds: [leg.legId],
      automatic: false,
      limitPrice,
      side: "buy",
      multiplier: 100,
      quantity: leg.quantity,
    },
    reason: null,
  };
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
    for (const leg of input.heldLegs) {
      const result = evaluateShortLegBuyback({ symbol: input.symbol, leg, rolls: input.rolls, settings: input.settings, singleLegPosition: (openLegCountByPosition.get(leg.positionId) ?? 0) === 1 });
      if (result.offer) offers.push(result.offer);
      else skipped.push({ id: `${input.symbol}:close_leg:${leg.legId}`, reason: result.reason ?? "not offered" });
    }
  }
  return { offers, skipped };
}
