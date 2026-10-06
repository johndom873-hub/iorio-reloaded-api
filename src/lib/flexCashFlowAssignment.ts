// Turns IBKR Flex cash movements into per-snapshot net cash flows for account_pnl_snapshots.net_cash_flow
// (approved 2026-10-02).
//
// A flow belongs to the first nightly snapshot captured at or after the moment it happened, not to the calendar date in
// its timestamp: the snapshot is taken at about 22:30 UTC (18:30 ET), so a transfer stamped 22:38 on the 23rd is not in
// the 23rd's NAV and changes the 24th's. Filing it under the 23rd would subtract it from the wrong day's change.
// Flex timestamps are read as US Eastern (moderate confidence: IBKR statements show Eastern; not confirmed for Flex).

import { easternInstant } from "./marketSessionStatus.js";

export interface FlexCashFlow {
  /** The calendar date in the Flex timestamp, YYYY-MM-DD. */
  isoDate: string;
  /** The moment of the flow; null when the timestamp carried no time of day. */
  occurredAt: Date | null;
  /** Deposits and transfers in are positive, withdrawals and transfers out negative, in the account's base currency. */
  amount: number;
}

export interface SnapshotCaptureTime {
  snapshotDate: string;
  capturedAt: Date;
}

/** Parses a Flex timestamp such as "20260923;223815" (date and time) or "20260923" (date only). */
export function parseFlexDateTime(dateTime: string): { isoDate: string; occurredAt: Date | null } {
  const dateDigits = dateTime.slice(0, 8);
  const isoDate = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  const timeDigits = dateTime.slice(8).replace(/\D/g, "");
  if (timeDigits.length < 4) return { isoDate, occurredAt: null };
  const hour = Number(timeDigits.slice(0, 2));
  const minute = Number(timeDigits.slice(2, 4));
  const second = timeDigits.length >= 6 ? Number(timeDigits.slice(4, 6)) : 0;
  return { isoDate, occurredAt: new Date(easternInstant(isoDate, hour, minute).getTime() + second * 1000) };
}

export interface FlexTransferRow {
  assetCategory?: string;
  direction?: string;
  cashTransfer?: string;
  fxRateToBase?: string;
  date?: string;
  dateTime?: string;
}

/**
 * A cash row of the Flex "Transfers" section (including transfers between linked accounts) as a flow. Rows that move
 * securities rather than cash are not handled yet and return null, as do rows missing a usable amount or timestamp.
 */
export function cashFlowFromTransferRow(row: FlexTransferRow): FlexCashFlow | null {
  if (row.assetCategory !== "CASH") return null;
  const cashAmount = Number(row.cashTransfer);
  const rateToBase = row.fxRateToBase === undefined || row.fxRateToBase === "" ? 1 : Number(row.fxRateToBase);
  const timestamp = row.dateTime ?? row.date;
  if (Number.isNaN(cashAmount) || Number.isNaN(rateToBase) || !timestamp) return null;
  const direction = row.direction?.toUpperCase();
  if (direction !== "IN" && direction !== "OUT") return null;
  const { isoDate, occurredAt } = parseFlexDateTime(timestamp);
  return { isoDate, occurredAt, amount: (direction === "IN" ? 1 : -1) * Math.abs(cashAmount) * rateToBase };
}

/**
 * Net flow per snapshot date. A flow with a time goes to the first snapshot captured at or after it; one after the latest
 * snapshot is left out (the next night's run assigns it). A flow with no time of day goes to the snapshot of its own date.
 */
export function assignFlowsToSnapshots(flows: FlexCashFlow[], snapshots: SnapshotCaptureTime[]): Map<string, number> {
  const orderedSnapshots = [...snapshots].sort((first, second) => first.capturedAt.getTime() - second.capturedAt.getTime());
  const netFlowBySnapshotDate = new Map<string, number>();
  for (const flow of flows) {
    const snapshot = flow.occurredAt
      ? orderedSnapshots.find((candidate) => candidate.capturedAt.getTime() >= flow.occurredAt!.getTime())
      : orderedSnapshots.find((candidate) => candidate.snapshotDate === flow.isoDate);
    if (!snapshot) continue;
    netFlowBySnapshotDate.set(snapshot.snapshotDate, (netFlowBySnapshotDate.get(snapshot.snapshotDate) ?? 0) + flow.amount);
  }
  return netFlowBySnapshotDate;
}

export interface FlexStatementCashSections {
  CashTransactions?: { CashTransaction?: { type: string; amount: string; dateTime: string } | { type: string; amount: string; dateTime: string }[] };
  Transfers?: { Transfer?: FlexTransferRow | FlexTransferRow[] };
}

// Both spellings are accepted: the Flex XML spelling has not been confirmed against live data, and a missed deposit would
// be counted as trading P&L.
const depositWithdrawalTypes = new Set(["deposits & withdrawals", "deposits/withdrawals"]);

/**
 * Every external cash movement in a parsed Flex report: Deposits/Withdrawals rows of the Cash Transactions section and
 * cash rows of the Transfers section. Dividends, interest and fees are trading-adjacent P&L, not external flow.
 */
export function extractExternalCashFlows(statements: FlexStatementCashSections[]): FlexCashFlow[] {
  const cashFlows: FlexCashFlow[] = [];
  for (const statement of statements) {
    const transactions = [statement.CashTransactions?.CashTransaction ?? []].flat();
    for (const transaction of transactions) {
      if (!depositWithdrawalTypes.has(String(transaction.type).trim().toLowerCase())) continue;
      const amount = Number(transaction.amount);
      if (Number.isNaN(amount)) continue;
      cashFlows.push({ ...parseFlexDateTime(transaction.dateTime), amount });
    }
    const transfers = [statement.Transfers?.Transfer ?? []].flat();
    for (const transfer of transfers) {
      const cashFlow = cashFlowFromTransferRow(transfer);
      if (cashFlow) cashFlows.push(cashFlow);
    }
  }
  return cashFlows;
}
