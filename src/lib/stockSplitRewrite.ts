import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { describeSplitRatio } from "./stockSplits.js";

// Stock splits, part 3 (Marcelo 2026-10-15): a frozen ticker's records are rewritten once to the split's new basis, so they
// agree with IBKR and with the split-adjusted price history (dailyBarSplitCheck.ts replaces it on detection). Run by a person
// through the split:rewrite script: a preview by default, applied only with --apply. Every value replaced is kept in
// stock_split_record_rewrites (split:undo puts them back). The ticker stays frozen until ticker:unfreeze.
//
// With r = new shares per old share, every record dated before the split's first day moves to the new basis, dollars unchanged:
//   stock legs and stock trades:  shares × r, prices ÷ r
//   options, r a whole number:    strike ÷ r, contracts × r, prices ÷ r          (a 2-for-1: 3 × $90 Put @ 2.00 → 6 × $45 Put @ 1.00)
//   options, any other r:         strike ÷ r, shares per contract × r, prices ÷ r (a 3-for-2: 100 → 150 shares; 1-for-10: 100 → 10)
// A contract that no longer delivers 100 shares is left to IBKR (the order route refuses it). Open legs take IBKR's contract id
// from the holdings the worker kept on the split, matched by right, expiry, new strike and size.

export interface SplitRecordRewriteChange {
  tableName: "position_legs" | "trades";
  rowId: string;
  columnName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface SplitLegRow {
  id: string;
  positionId: string;
  legType: "stock" | "option";
  side: string;
  quantity: number;
  optionType: "call" | "put" | null;
  strike: number | null;
  expiryDateIso: string | null;
  multiplier: number;
  ibkrContractId: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Whether the leg closed before the split's first day (its exit is on the old basis). */
  exitedBeforeSplit: boolean;
  isOpen: boolean;
}

export interface SplitTradeRow {
  id: string;
  legId: string;
  quantity: number;
  price: number;
}

export interface IbkrHeldSnapshot {
  conId: number | null;
  secType: string | null;
  right: string | null;
  strike: number | null;
  expiry: string | null;
  multiplier: number | string | null;
  quantity: number;
  avgCost: number;
}

export interface SplitRewritePlan {
  splitId: string;
  symbol: string;
  ratio: number;
  description: string;
  effectiveDateIso: string;
  changes: SplitRecordRewriteChange[];
  /** Open holdings after the rewrite against IBKR's, one line each. */
  holdingsComparison: string[];
  /** Anything that stops --apply (a person must look). */
  problems: string[];
  /** Worth reading, does not stop --apply. */
  notes: string[];
}

const priceDecimals = 6;
const formatNumber = (value: number) => String(Number(value.toFixed(priceDecimals)));
const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;
const expiryKey = (iso: string) => iso.slice(0, 10).replaceAll("-", "");

/** The rewrite of one split's records, from rows already loaded: pure, so it is tested without a database. */
export function planSplitRecordRewrite(input: {
  splitId: string;
  symbol: string;
  ratio: number;
  effectiveDateIso: string;
  legs: SplitLegRow[];
  trades: SplitTradeRow[];
  ibkrHoldings: IbkrHeldSnapshot[] | null;
}): SplitRewritePlan {
  const { ratio } = input;
  const optionsByContracts = isWhole(ratio) && ratio >= 1;
  const changes: SplitRecordRewriteChange[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const change = (tableName: SplitRecordRewriteChange["tableName"], rowId: string, columnName: string, oldValue: number | string | null, newValue: number | string | null) => {
    const before = oldValue === null ? null : String(oldValue);
    const after = newValue === null ? null : String(newValue);
    if (before !== after) changes.push({ tableName, rowId, columnName, oldValue: before, newValue: after });
  };
  const legById = new Map(input.legs.map((leg) => [leg.id, leg]));
  const newQuantityOfLeg = new Map<string, number>();
  const newStrikeOfLeg = new Map<string, number>();
  const newMultiplierOfLeg = new Map<string, number>();

  for (const leg of input.legs) {
    const quantityFactor = leg.legType === "stock" || optionsByContracts ? ratio : 1;
    const newQuantity = leg.quantity * quantityFactor;
    if (!isWhole(newQuantity)) {
      problems.push(`${leg.legType} leg ${leg.id}: ${leg.quantity} × ${ratio} = ${newQuantity} is not a whole number (IBKR pays cash for the fraction): rewrite it by hand.`);
      continue;
    }
    newQuantityOfLeg.set(leg.id, Math.round(newQuantity));
    change("position_legs", leg.id, "quantity", leg.quantity, Math.round(newQuantity));
    if (leg.entryPrice !== null) change("position_legs", leg.id, "entry_price", formatNumber(leg.entryPrice), formatNumber(leg.entryPrice / ratio));
    if (leg.exitPrice !== null) {
      if (leg.exitedBeforeSplit) change("position_legs", leg.id, "exit_price", formatNumber(leg.exitPrice), formatNumber(leg.exitPrice / ratio));
      else notes.push(`${leg.legType} leg ${leg.id} opened before the split and closed on or after its first day: its exit ${leg.exitPrice} is left as recorded (check it is on the new basis).`);
    }
    if (leg.legType === "option") {
      if (leg.strike === null) {
        problems.push(`option leg ${leg.id} has no strike.`);
        continue;
      }
      const newStrike = leg.strike / ratio;
      newStrikeOfLeg.set(leg.id, newStrike);
      change("position_legs", leg.id, "strike_price", formatNumber(leg.strike), formatNumber(newStrike));
      if (!optionsByContracts) {
        const newMultiplier = leg.multiplier * ratio;
        if (!isWhole(newMultiplier)) {
          problems.push(`option leg ${leg.id}: ${leg.multiplier} shares per contract × ${ratio} = ${newMultiplier} is not whole (IBKR adds cash to the deliverable): rewrite it by hand.`);
          continue;
        }
        newMultiplierOfLeg.set(leg.id, Math.round(newMultiplier));
        change("position_legs", leg.id, "multiplier", leg.multiplier, Math.round(newMultiplier));
        if (leg.isOpen) notes.push(`option leg ${leg.id} will deliver ${Math.round(newMultiplier)} shares per contract: the platform leaves it to IBKR (no closes or rolls from here).`);
      } else {
        newMultiplierOfLeg.set(leg.id, leg.multiplier);
      }
    }
  }

  for (const trade of input.trades) {
    const leg = legById.get(trade.legId);
    if (!leg) continue;
    const quantityFactor = leg.legType === "stock" || optionsByContracts ? ratio : 1;
    const newQuantity = trade.quantity * quantityFactor;
    if (!isWhole(newQuantity)) {
      problems.push(`trade ${trade.id}: ${trade.quantity} × ${ratio} = ${newQuantity} is not a whole number: rewrite it by hand.`);
      continue;
    }
    change("trades", trade.id, "quantity", trade.quantity, Math.round(newQuantity));
    change("trades", trade.id, "price", formatNumber(trade.price), formatNumber(trade.price / ratio));
  }

  const holdingsComparison: string[] = [];
  if (input.ibkrHoldings === null) {
    problems.push("The worker has not kept IBKR's holdings on this split yet (it does so each minute while the ticker is frozen and the Gateway is up).");
  } else {
    const matched = new Set<IbkrHeldSnapshot>();
    const openLegs = input.legs.filter((leg) => leg.isOpen && newQuantityOfLeg.has(leg.id));
    const stockShares = openLegs.filter((leg) => leg.legType === "stock").reduce((sum, leg) => sum + newQuantityOfLeg.get(leg.id)!, 0);
    const ibkrStock = input.ibkrHoldings.find((held) => held.secType === "STK");
    if (ibkrStock) matched.add(ibkrStock);
    const ibkrShares = ibkrStock?.quantity ?? 0;
    holdingsComparison.push(`${stockShares === ibkrShares ? "✅" : "❌"} shares: ours after the rewrite ${stockShares}, IBKR ${ibkrShares}`);
    if (stockShares !== ibkrShares) problems.push(`Shares after the rewrite (${stockShares}) differ from IBKR's (${ibkrShares}).`);
    if (ibkrStock?.conId != null) {
      for (const leg of openLegs.filter((l) => l.legType === "stock")) change("position_legs", leg.id, "ibkr_contract_id", leg.ibkrContractId, String(ibkrStock.conId));
    }

    for (const leg of openLegs.filter((l) => l.legType === "option")) {
      const strike = newStrikeOfLeg.get(leg.id);
      const contracts = newQuantityOfLeg.get(leg.id)!;
      const right = leg.optionType === "call" ? "C" : "P";
      const label = `${contracts} × $${strike === undefined ? "?" : formatNumber(strike)} ${leg.optionType} ${leg.expiryDateIso ?? "?"} (${newMultiplierOfLeg.get(leg.id) ?? leg.multiplier} shares each)`;
      const held = input.ibkrHoldings.find(
        (candidate) =>
          !matched.has(candidate) &&
          candidate.secType === "OPT" &&
          (candidate.right === right || candidate.right?.toUpperCase().startsWith(right) === true) &&
          candidate.expiry !== null &&
          leg.expiryDateIso !== null &&
          expiryKey(candidate.expiry) === expiryKey(leg.expiryDateIso) &&
          strike !== undefined &&
          candidate.strike !== null &&
          Math.abs(candidate.strike - strike) < 0.005 &&
          Math.abs(candidate.quantity) === contracts,
      );
      if (!held) {
        holdingsComparison.push(`❌ ${label}: IBKR holds no matching contract`);
        problems.push(`No IBKR contract matches ${label}.`);
        continue;
      }
      matched.add(held);
      const ibkrMultiplier = Number(held.multiplier);
      const ourMultiplier = newMultiplierOfLeg.get(leg.id) ?? leg.multiplier;
      holdingsComparison.push(`✅ ${label}: IBKR conId ${held.conId}, multiplier ${held.multiplier ?? "?"}`);
      if (ibkrMultiplier > 0 && ibkrMultiplier !== ourMultiplier) notes.push(`${label}: IBKR reports multiplier ${held.multiplier}, ours will be ${ourMultiplier} shares per contract; check how IBKR shows the adjusted deliverable.`);
      if (held.conId !== null) change("position_legs", leg.id, "ibkr_contract_id", leg.ibkrContractId, String(held.conId));
    }

    for (const held of input.ibkrHoldings.filter((candidate) => !matched.has(candidate))) {
      holdingsComparison.push(`❌ IBKR holds ${held.quantity} of ${held.secType} ${held.right ?? ""} ${held.strike ?? ""} ${held.expiry ?? ""} (conId ${held.conId}) with no open record`);
      problems.push(`IBKR holds conId ${held.conId} (${held.secType} ${held.right ?? ""} ${held.strike ?? ""} ${held.expiry ?? ""}, ${held.quantity}) that no open record matches.`);
    }
  }

  return { splitId: input.splitId, symbol: input.symbol, ratio, description: describeSplitRatio(ratio), effectiveDateIso: input.effectiveDateIso, changes, holdingsComparison, problems, notes };
}

/** Loads a split's rows and plans its rewrite. Throws when the split does not exist or is already rewritten. */
export async function loadSplitRecordRewritePlan(splitId: string, connection: Knex = db): Promise<SplitRewritePlan> {
  const split: { id: string; tickerId: string; symbol: string; ratio: string; effectiveDateIso: string; recordsRewrittenAt: Date | null; ibkrHoldings: IbkrHeldSnapshot[] | null } | undefined = await connection("stock_splits as s")
    .join("tickers as t", "t.id", "s.ticker_id")
    .where("s.id", splitId)
    .first("s.id", "s.ticker_id as tickerId", "t.symbol", "s.ratio", connection.raw('s.effective_date::text as "effectiveDateIso"'), "s.records_rewritten_at as recordsRewrittenAt", "s.ibkr_holdings as ibkrHoldings");
  if (!split) throw new Error(`No stock split ${splitId}.`);
  if (split.recordsRewrittenAt) throw new Error(`Split ${splitId} (${split.symbol}) was already rewritten at ${split.recordsRewrittenAt.toISOString()}.`);
  const splitStart = connection.raw("(?::date)::timestamp at time zone 'America/New_York'", [split.effectiveDateIso]);
  const legRows: Record<string, unknown>[] = await connection("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where("p.ticker_id", split.tickerId)
    .where("pl.entry_at", "<", splitStart)
    .orderBy("pl.entry_at")
    .select(
      "pl.id",
      "pl.position_id as positionId",
      "pl.leg_type as legType",
      "pl.side",
      "pl.quantity",
      "pl.option_type as optionType",
      "pl.strike_price as strike",
      connection.raw('pl.expiry_date::text as "expiryDateIso"'),
      "pl.multiplier",
      "pl.ibkr_contract_id as ibkrContractId",
      "pl.entry_price as entryPrice",
      "pl.exit_price as exitPrice",
      connection.raw('(pl.exit_at is not null and pl.exit_at < ?) as "exitedBeforeSplit"', [splitStart]),
      connection.raw('(pl.exit_at is null) as "isOpen"'),
    );
  const legs: SplitLegRow[] = legRows.map((row) => ({
    id: row.id as string,
    positionId: row.positionId as string,
    legType: row.legType as SplitLegRow["legType"],
    side: row.side as string,
    quantity: Number(row.quantity),
    optionType: (row.optionType as SplitLegRow["optionType"]) ?? null,
    strike: row.strike === null ? null : Number(row.strike),
    expiryDateIso: (row.expiryDateIso as string | null) ?? null,
    multiplier: Number(row.multiplier),
    ibkrContractId: (row.ibkrContractId as string | null) ?? null,
    entryPrice: row.entryPrice === null ? null : Number(row.entryPrice),
    exitPrice: row.exitPrice === null ? null : Number(row.exitPrice),
    exitedBeforeSplit: Boolean(row.exitedBeforeSplit),
    isOpen: Boolean(row.isOpen),
  }));
  const tradeRows: { id: string; legId: string; quantity: string; price: string }[] =
    legs.length === 0
      ? []
      : await connection("trades").whereIn("position_leg_id", legs.map((leg) => leg.id)).where("executed_at", "<", splitStart).select("id", "position_leg_id as legId", "quantity", "price");
  return planSplitRecordRewrite({
    splitId: split.id,
    symbol: split.symbol,
    ratio: Number(split.ratio),
    effectiveDateIso: split.effectiveDateIso,
    legs,
    trades: tradeRows.map((row) => ({ id: row.id, legId: row.legId, quantity: Number(row.quantity), price: Number(row.price) })),
    ibkrHoldings: split.ibkrHoldings,
  });
}

/** Applies a plan in one transaction, keeps every replaced value, marks the split rewritten. The ticker stays frozen. */
export async function applySplitRecordRewrite(plan: SplitRewritePlan, options: { acceptProblems: boolean }, connection: Knex = db): Promise<void> {
  if (plan.problems.length > 0 && !options.acceptProblems) throw new Error(`The plan has ${plan.problems.length} problem(s); nothing applied.`);
  await connection.transaction(async (trx) => {
    const split = await trx("stock_splits").where({ id: plan.splitId }).forUpdate().first("records_rewritten_at");
    if (!split || split.records_rewritten_at) throw new Error(`Split ${plan.splitId} is missing or already rewritten; nothing applied.`);
    for (const change of plan.changes) {
      const updated = await trx(change.tableName).where({ id: change.rowId }).update({ [change.columnName]: change.newValue });
      if (updated !== 1) throw new Error(`${change.tableName} ${change.rowId} not found; nothing applied.`);
    }
    for (let start = 0; start < plan.changes.length; start += 500) {
      await trx("stock_split_record_rewrites").insert(
        plan.changes.slice(start, start + 500).map((change) => ({ stock_split_id: plan.splitId, table_name: change.tableName, row_id: change.rowId, column_name: change.columnName, old_value: change.oldValue, new_value: change.newValue })),
      );
    }
    await trx("stock_splits").where({ id: plan.splitId }).update({ records_rewritten_at: trx.fn.now() });
  });
}

/** Puts back every value a split's rewrite replaced and marks the split pending again. Returns how many values it restored. */
export async function undoSplitRecordRewrite(splitId: string, connection: Knex = db): Promise<number> {
  return connection.transaction(async (trx) => {
    const rows: { id: string; table_name: string; row_id: string; column_name: string; old_value: string | null }[] = await trx("stock_split_record_rewrites")
      .where({ stock_split_id: splitId })
      .whereNull("undone_at")
      .orderBy("rewritten_at", "desc")
      .select("id", "table_name", "row_id", "column_name", "old_value");
    for (const row of rows) await trx(row.table_name).where({ id: row.row_id }).update({ [row.column_name]: row.old_value });
    await trx("stock_split_record_rewrites").whereIn("id", rows.map((row) => row.id)).update({ undone_at: trx.fn.now() });
    await trx("stock_splits").where({ id: splitId }).update({ records_rewritten_at: null });
    return rows.length;
  });
}
