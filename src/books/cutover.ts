import { randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { fetchFlexStatements } from "../ibkr/fetchFlexCashTransactions.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { loadOpenLegMarketValues } from "../lib/positionExposure.js";
import { attributeStatement, statementCutOffAt, statementSectionRows } from "./statementAttribution.js";
import { missingStatementSections } from "./statementImport.js";
import { strategiesAlwaysInManualBook } from "./tickerBookPeriods.js";

// The books' start (Marcelo 2026-11-05): Marcelo sets Pluto's starting value; Manual gets the rest of the account's cash.
//
// With IBKR's statement (prod): the books start at the statement's cut-off (the start of the day after its last day,
// New York time), from its ending cash and the positions' closing prices that day:
//   Pluto's opening cash  = Pluto's starting value − Pluto's positions at that close
//   Manual's opening cash = the statement's ending cash − Pluto's opening cash
// Every fill since then is counted from the app's records until the next statement holds it.
// Example: ending cash $370,000, Pluto's positions $380,000 at the close, starting value $600,000 → Pluto $220,000 cash,
// Manual $150,000.
//
// Without a usable statement (staging's paper account): the books start now, from IBKR's live total cash and the live marks.
//
// Pluto's book at the start: every ticker Pluto is switched on for (a ticker_book_periods row from the start).

export interface CutoverPlan {
  mode: "statement" | "live";
  cutOverAt: Date;
  statementToDate: string | null;
  ibkrCash: number;
  plutoStartingValue: number;
  plutoPositionsValue: number;
  manualPositionsValue: number;
  plutoOpeningCash: number;
  manualOpeningCash: number;
  plutoSymbols: string[];
  statementRowKeys: string[];
  /** Legs valued at their entry price for want of a closing price that day. */
  legsWithoutClosingPrice: string[];
}

interface ClosingLegRow {
  symbol: string;
  ticker_id: string;
  strategy_key: string;
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entry_price: string;
  closing_price: string | null;
}

/** The plan, nothing written. `withoutStatement` starts from IBKR's live figures (staging's paper account has no usable statement). */
export async function planBooksCutover(plutoStartingValue: number, options: { withoutStatement: boolean }): Promise<CutoverPlan> {
  if (!(plutoStartingValue >= 0)) throw new Error("Pluto's starting value must be a dollar amount of 0 or more.");
  if (await db("books_cutover").first("id")) throw new Error("The books have already been started.");
  const enabled: { ticker_id: string; symbol: string }[] = await db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").where("se.bot_enabled", true).select("se.ticker_id", "t.symbol");
  const plutoTickerIds = new Set(enabled.map((row) => row.ticker_id));
  const isPlutos = (tickerId: string, strategyKey: string) => plutoTickerIds.has(tickerId) && !strategiesAlwaysInManualBook.includes(strategyKey);

  if (options.withoutStatement) {
    const [summary, legs] = await Promise.all([fetchAccountSummary(), loadOpenLegMarketValues()]);
    if (summary.totalCashValue === null) throw new Error("IBKR reported no total cash.");
    const plutoPositionsValue = legs.filter((leg) => isPlutos(leg.tickerId, leg.strategyKey)).reduce((sum, leg) => sum + leg.marketValue, 0);
    const manualPositionsValue = legs.filter((leg) => !isPlutos(leg.tickerId, leg.strategyKey)).reduce((sum, leg) => sum + leg.marketValue, 0);
    const plutoOpeningCash = plutoStartingValue - plutoPositionsValue;
    return { mode: "live", cutOverAt: new Date(), statementToDate: null, ibkrCash: summary.totalCashValue, plutoStartingValue, plutoPositionsValue, manualPositionsValue, plutoOpeningCash, manualOpeningCash: summary.totalCashValue - plutoOpeningCash, plutoSymbols: enabled.map((row) => row.symbol).sort(), statementRowKeys: [], legsWithoutClosingPrice: [] };
  }

  const statements = await fetchFlexStatements();
  if (statements.length !== 1) throw new Error(`Expected one statement, got ${statements.length}.`);
  const statement = statements[0]! as Record<string, unknown>;
  const missing = missingStatementSections(statement);
  if (missing.length > 0) throw new Error(`IBKR's statement lacks ${missing.join(", ")}; add them to the Flex query, or start with --without-statement.`);
  const toDate = String(statement.toDate);
  const toDateIso = `${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}`;
  const cashReport = statementSectionRows(statement.CashReport).find((row) => row.levelOfDetail === "BaseCurrency");
  const endingCash = Number(cashReport?.endingCash);
  if (!Number.isFinite(endingCash)) throw new Error("IBKR's statement has no ending cash.");
  const cutOverAt = statementCutOffAt(toDate);
  // Legs open at that close: entered before the cut-off, not exited before it, at that day's closing price.
  const legs: ClosingLegRow[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .leftJoin("position_leg_price_snapshots as lps", (join) => join.on("lps.position_leg_id", "pl.id").andOn("lps.snapshot_date", db.raw("?::date", [toDateIso])))
    .where("pl.entry_at", "<", cutOverAt)
    .where((builder) => builder.whereNull("pl.exit_at").orWhere("pl.exit_at", ">=", cutOverAt))
    .select("t.symbol", "p.ticker_id", "p.strategy_key", "pl.side", "pl.quantity", "pl.multiplier", "pl.entry_price", "lps.price as closing_price");
  let plutoPositionsValue = 0;
  let manualPositionsValue = 0;
  const legsWithoutClosingPrice: string[] = [];
  for (const leg of legs) {
    if (leg.closing_price === null) legsWithoutClosingPrice.push(leg.symbol);
    const value = Number(leg.closing_price ?? leg.entry_price) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1);
    if (isPlutos(leg.ticker_id, leg.strategy_key)) plutoPositionsValue += value;
    else manualPositionsValue += value;
  }
  const rowKeys = attributeStatement(statement, { bookOfSymbolAt: () => "manual", isHedgeOptionContract: () => false, bookValueWeightsAt: () => ({ pluto: 1, manual: 1 }), dailyCashWeightsBetween: () => ({ pluto: 1, manual: 1 }) }).rowKeys;
  const plutoOpeningCash = plutoStartingValue - plutoPositionsValue;
  return { mode: "statement", cutOverAt, statementToDate: toDateIso, ibkrCash: endingCash, plutoStartingValue, plutoPositionsValue, manualPositionsValue, plutoOpeningCash, manualOpeningCash: endingCash - plutoOpeningCash, plutoSymbols: enabled.map((row) => row.symbol).sort(), statementRowKeys: rowKeys, legsWithoutClosingPrice: [...new Set(legsWithoutClosingPrice)] };
}

/** Writes the plan in one transaction: the cut-over row, the two opening balances, Pluto's ticker periods and the first snapshots. */
export async function applyBooksCutover(plan: CutoverPlan, createdByUserId: string | null): Promise<void> {
  await db.transaction(async (trx) => {
    if (await trx("books_cutover").first("id")) throw new Error("The books have already been started.");
    await trx("books_cutover").insert({
      id: true,
      cut_over_at: plan.cutOverAt,
      statement_to_date: plan.statementToDate,
      ibkr_cash: plan.ibkrCash,
      pluto_starting_value: plan.plutoStartingValue,
      pluto_positions_value: plan.plutoPositionsValue,
      statement_row_keys: JSON.stringify(plan.statementRowKeys),
      created_by_user_id: createdByUserId,
    });
    const groupId = randomUUID();
    const description = plan.mode === "statement" ? `Opening cash at the close of ${plan.statementToDate}` : "Opening cash at the start of the books";
    await trx("book_cash_entries").insert([
      { book_key: "pluto", amount: plan.plutoOpeningCash, effective_at: plan.cutOverAt, kind: "opening_balance", group_id: groupId, description, created_by_user_id: createdByUserId },
      { book_key: "manual", amount: plan.manualOpeningCash, effective_at: plan.cutOverAt, kind: "opening_balance", group_id: groupId, description, created_by_user_id: createdByUserId },
    ]);
    const tickers: { id: string }[] = await trx("tickers").whereIn("symbol", plan.plutoSymbols).select("id");
    if (tickers.length > 0) await trx("ticker_book_periods").insert(tickers.map((ticker) => ({ ticker_id: ticker.id, book_key: "pluto", started_at: plan.cutOverAt, created_by_user_id: createdByUserId })));
    const snapshotDate = plan.statementToDate ?? easternIsoDate(plan.cutOverAt);
    await trx("book_value_snapshots")
      .insert([
        { snapshot_date: snapshotDate, book_key: "pluto", cash: plan.plutoOpeningCash, positions_value: plan.plutoPositionsValue, book_value: plan.plutoStartingValue },
        { snapshot_date: snapshotDate, book_key: "manual", cash: plan.manualOpeningCash, positions_value: plan.manualPositionsValue, book_value: plan.manualOpeningCash + plan.manualPositionsValue },
        { snapshot_date: snapshotDate, book_key: "unallocated", cash: 0, positions_value: 0, book_value: 0 },
      ])
      .onConflict(["snapshot_date", "book_key"])
      .merge();
  });
}
