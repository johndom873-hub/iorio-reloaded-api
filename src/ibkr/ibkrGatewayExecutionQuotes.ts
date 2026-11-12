import type { Contract, Execution } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { fetchContractQuoteSnapshots, type LegQuoteSnapshotResult } from "./ibkrGatewayLegQuotes.js";
import { parseIbkrExecutionTime } from "./ibkrGatewayParseExecutionTime.js";

// Runs on the VPS worker (hence the ibkrGateway* name): the bid and ask of the executed contract right after each fill,
// stored in execution_quotes, so the share of the half-spread a mid-limit order really gives up can be measured (the
// Risk & Limits spread cost), and an option fill's stock price from the same snapshot (Marcelo 2026-11-11: the Wheel cycle's
// Stock price on option rows). Best-effort: the caller does not wait on it, and it never touches the trade itself.

/** An execution older than this when it arrives is a replay after a reconnect: a quote taken now says nothing about it. */
export const executionQuoteMaxAgeMs = 60_000;

/** Single option and stock fills only: a combo's BAG summary execution has no quote of its own, its legs arrive separately. */
export function shouldCaptureExecutionQuote(secType: string | undefined, executedAt: Date | null, now: Date): boolean {
  if (secType !== "OPT" && secType !== "STK") return false;
  if (!executedAt) return false;
  return now.getTime() - executedAt.getTime() <= executionQuoteMaxAgeMs;
}

export interface ExecutionQuoteDependencies {
  fetchQuotes(contracts: Contract[], options: { waitForUnderlyingPrice: boolean }): Promise<LegQuoteSnapshotResult>;
  now(): Date;
}

export async function captureExecutionQuote(
  ib: Parameters<typeof fetchContractQuoteSnapshots>[0],
  contract: Contract,
  execution: Execution,
  dependencies: ExecutionQuoteDependencies = { fetchQuotes: (contracts, options) => fetchContractQuoteSnapshots(ib, contracts, options), now: () => new Date() },
): Promise<void> {
  if (!execution.execId || !contract.conId) return;
  const executedAt = parseIbkrExecutionTime(execution.time);
  if (!shouldCaptureExecutionQuote(contract.secType, executedAt, dependencies.now())) return;
  if (await db("execution_quotes").where({ ibkr_exec_id: execution.execId }).first()) return;

  const snapshot = await dependencies.fetchQuotes([{ conId: contract.conId, exchange: "SMART" }], { waitForUnderlyingPrice: contract.secType === "OPT" });
  const quote = snapshot.quotes[0];
  await db("execution_quotes")
    .insert({
      ibkr_exec_id: execution.execId,
      ibkr_contract_id: String(contract.conId),
      sec_type: contract.secType,
      executed_at: executedAt,
      execution_price: execution.price ?? 0,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      underlying_price: contract.secType === "OPT" ? (quote?.underlyingPrice ?? null) : null,
      quoted_at: dependencies.now(),
      note: snapshot.notes.length > 0 ? snapshot.notes.join("; ") : null,
    })
    .onConflict("ibkr_exec_id")
    .ignore();
}
