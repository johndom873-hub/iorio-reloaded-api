import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { isoDateFromDbDate } from "../lib/dbDate.js";
import { lastCompletedSessionDate } from "../lib/marketSessionStatus.js";

// Hold-to-expiry outcome for every candidate a pass offered the model (formula approved by
// Marcelo 2026-09-29). It is a ranking label for backtests, not booked P&L: it ignores early
// closes, rolls and assignment timing, and takes the premium at the bid the model saw.
//   put:  premium_bid × multiplier − max(0, strike − expiry_close) × multiplier
//   call: premium_bid × multiplier − max(0, expiry_close − strike) × multiplier

export interface OfferedContract {
  candidateId: string;
  symbol: string;
  strategyKey: "cash_secured_put" | "covered_call";
  expiry: string;
  strike: number;
  premiumBid: number;
}

export function holdToExpiryPnl(strategyKey: "cash_secured_put" | "covered_call", strike: number, premiumBid: number, expiryClose: number, multiplier = 100): number {
  const intrinsic = strategyKey === "cash_secured_put" ? Math.max(0, strike - expiryClose) : Math.max(0, expiryClose - strike);
  return Math.round((premiumBid - intrinsic) * multiplier * 100) / 100;
}

function strategyFromKind(kind: unknown, id: string): "cash_secured_put" | "covered_call" | null {
  if (kind === "open_cash_secured_put" || kind === "cash_secured_put") return "cash_secured_put";
  if (kind === "open_covered_call" || kind === "covered_call") return "covered_call";
  if (id.includes(":cash_secured_put:")) return "cash_secured_put";
  if (id.includes(":covered_call:")) return "covered_call";
  return null;
}

/** Pure: the open candidates and roll replacements in a recorded payload, with what the label needs. Close offers carry no contract to hold. */
export function extractOfferedContracts(payload: Record<string, unknown>): OfferedContract[] {
  const contracts: OfferedContract[] = [];
  const tickers = Array.isArray(payload.tickers) ? (payload.tickers as Record<string, unknown>[]) : [];
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol ?? "");
    const add = (id: string, kind: unknown, contract: Record<string, unknown>) => {
      const strategyKey = strategyFromKind(kind, id);
      const expiry = typeof contract.expiry === "string" ? contract.expiry : null;
      const strike = typeof contract.strike === "number" ? contract.strike : null;
      const bid = typeof contract.bid === "number" ? contract.bid : null;
      if (!symbol || !strategyKey || !expiry || strike === null || bid === null) return;
      contracts.push({ candidateId: id, symbol, strategyKey, expiry, strike, premiumBid: bid });
    };
    for (const candidate of Array.isArray(ticker.candidates) ? (ticker.candidates as Record<string, unknown>[]) : []) {
      if (typeof candidate.id === "string") add(candidate.id, candidate.kind, candidate);
    }
    for (const roll of Array.isArray(ticker.rolls) ? (ticker.rolls as Record<string, unknown>[]) : []) {
      const replacement = roll.replacement as Record<string, unknown> | undefined;
      if (typeof roll.id === "string" && replacement) add(roll.id, replacement.kind, replacement);
    }
  }
  return contracts;
}

export interface LabelOutcomesResult {
  labelled: number;
  pending: number;
  missingBars: string[];
}

/**
 * Labels every offered contract whose expiry has settled and has no outcome row yet. The expiry
 * close is the newest daily bar on or before the expiry (a contract expiring on a holiday takes the
 * previous session's close); a symbol with no bar within 5 days of the expiry is skipped and listed.
 */
export async function labelExpiredCandidateOutcomes(now: Date = new Date(), connection: Knex = db): Promise<LabelOutcomesResult> {
  const settledThroughIso = await lastCompletedSessionDate(now);
  const passes: { id: string; input_payload: Record<string, unknown> }[] = await connection("pluto_decisions as d")
    .join("pluto_passes as p", "p.id", "d.pass_id")
    .where("d.call_index", 1)
    .select("p.id", "d.input_payload");
  const passIds = passes.map((pass) => pass.id);
  const existing: { pass_id: string; candidate_id: string }[] = passIds.length === 0 ? [] : await connection("pluto_candidate_outcomes").whereIn("pass_id", passIds).select("pass_id", "candidate_id");
  const done = new Set(existing.map((row) => `${row.pass_id}|${row.candidate_id}`));
  const result: LabelOutcomesResult = { labelled: 0, pending: 0, missingBars: [] };
  for (const pass of passes) {
    for (const contract of extractOfferedContracts(pass.input_payload)) {
      if (done.has(`${pass.id}|${contract.candidateId}`)) continue;
      if (contract.expiry > settledThroughIso) {
        result.pending += 1;
        continue;
      }
      const bar = await connection("daily_price_bars as b")
        .join("tickers as t", "t.id", "b.ticker_id")
        .where("t.symbol", contract.symbol)
        .where("b.trading_date", "<=", contract.expiry)
        .orderBy("b.trading_date", "desc")
        .first("b.trading_date", "b.close_price");
      const barDate = bar ? isoDateFromDbDate(bar.trading_date) : null;
      if (!bar || !barDate || daysBetween(barDate, contract.expiry) > 5) {
        result.missingBars.push(`${contract.symbol} ${contract.expiry}`);
        continue;
      }
      const expiryClose = Number(bar.close_price);
      await connection("pluto_candidate_outcomes")
        .insert({
          pass_id: pass.id,
          candidate_id: contract.candidateId,
          symbol: contract.symbol,
          strategy_key: contract.strategyKey,
          expiry: contract.expiry,
          strike: contract.strike,
          premium_bid: contract.premiumBid,
          multiplier: 100,
          expiry_close: expiryClose,
          hold_to_expiry_pnl: holdToExpiryPnl(contract.strategyKey, contract.strike, contract.premiumBid, expiryClose),
        })
        .onConflict(["pass_id", "candidate_id"])
        .ignore();
      done.add(`${pass.id}|${contract.candidateId}`);
      result.labelled += 1;
    }
  }
  return result;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T12:00:00Z`).getTime() - new Date(`${fromIso}T12:00:00Z`).getTime()) / (24 * 60 * 60 * 1000));
}

/** Outcome per candidate id for a set of passes, for the backtest. */
export async function loadCandidateOutcomes(passIds: string[], connection: Knex = db): Promise<Map<string, Map<string, number>>> {
  const byPass = new Map<string, Map<string, number>>();
  if (passIds.length === 0) return byPass;
  const rows: { pass_id: string; candidate_id: string; hold_to_expiry_pnl: string }[] = await connection("pluto_candidate_outcomes").whereIn("pass_id", passIds).select("pass_id", "candidate_id", "hold_to_expiry_pnl");
  for (const row of rows) {
    if (!byPass.has(row.pass_id)) byPass.set(row.pass_id, new Map());
    byPass.get(row.pass_id)!.set(row.candidate_id, Number(row.hold_to_expiry_pnl));
  }
  return byPass;
}
