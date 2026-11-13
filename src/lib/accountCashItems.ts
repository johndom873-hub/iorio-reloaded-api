import { attributeStatement } from "../books/statementAttribution.js";
import { cashComponentOfKind } from "./pnlAnalysis.js";

// The statement's cash rows that are no strategy's (interest, dividends, fees and their taxes) from before the books'
// ledger began (Marcelo 2026-11-13), for the P&L Analyser's All books figures: without them that stretch's interest and
// fees would sit in Unexplained and hide any real gap. Read with the books' own parser (statementAttribution.ts), every row
// placed in one book so nothing is split; trades, deposits and transfers are not cash items and are left out.

const accountCashItemKinds = new Set(["dividend", "withholding_tax", "interest", "fee", "sales_tax", "commission_adjustment", "corporate_action", "other_statement_row"]);

export interface AccountCashItemDraft {
  sourceRowKey: string;
  kind: string;
  symbol: string | null;
  amount: number;
  effectiveAt: Date;
  description: string;
  statementRow: Record<string, string>;
}

/** Pure: the statement's cash items dated before `before` (the books' start), one per statement row. */
export function accountCashItemsFromStatement(statement: Record<string, unknown>, before: Date): { items: AccountCashItemDraft[]; problems: string[] } {
  const parsed = attributeStatement(statement, {
    bookOfSymbolAt: () => "manual",
    isHedgeOptionContract: () => false,
    bookValueWeightsAt: () => ({ pluto: 0, manual: 1 }),
    dailyCashWeightsBetween: () => ({ pluto: 0, manual: 1 }),
  });
  const items: AccountCashItemDraft[] = [];
  for (const entry of parsed.entries) {
    if (!accountCashItemKinds.has(entry.kind) || entry.bookKey !== "manual" || entry.effectiveAt.getTime() >= before.getTime() || entry.amount === 0) continue;
    items.push({ sourceRowKey: entry.sourceRowKey, kind: entry.kind, symbol: entry.symbol, amount: entry.amount, effectiveAt: entry.effectiveAt, description: entry.description, statementRow: entry.statementRow });
  }
  return { items, problems: parsed.problems };
}

/** Pure: the items' totals by the analyser's components, for the dry run. */
export function accountCashItemTotals(items: readonly AccountCashItemDraft[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of items) {
    const component = cashComponentOfKind(item.kind, item.symbol);
    totals[component] = (totals[component] ?? 0) + item.amount;
  }
  return totals;
}
