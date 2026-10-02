import { XMLParser } from "fast-xml-parser";
import { db } from "../db/connection.js";
import { findFlexAccountProblem } from "../lib/flexStatementAccountGuard.js";
import { workerProcessName } from "../lib/workerHeartbeatLiveness.js";
import { FlexRateLimitError, isFlexRateLimitResponse, retryOnFlexRateLimit } from "../lib/retryOnFlexRateLimit.js";

const flexWebServiceBaseUrl = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const depositWithdrawalType = "Deposits & Withdrawals";
const statementPollIntervalMs = 5_000;
const statementPollTimeoutMs = 120_000;

function requireEnvironmentVariable(variableName: string): string {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

interface SendRequestResponse {
  FlexStatementResponse?: {
    Status?: string;
    ReferenceCode?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
  };
}

interface FlexStatementXml {
  accountId?: string;
  CashTransactions?: {
    CashTransaction?: CashTransactionXml | CashTransactionXml[];
  };
}

interface GetStatementResponse {
  FlexQueryResponse?: {
    FlexStatements?: {
      FlexStatement?: FlexStatementXml | FlexStatementXml[];
    };
  };
  FlexStatementResponse?: {
    Status?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
  };
}

interface CashTransactionXml {
  type: string;
  amount: string;
  dateTime: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendFlexRequest(token: string, queryId: string): Promise<string> {
  const url = `${flexWebServiceBaseUrl}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
  const response = await fetch(url);
  const body = xmlParser.parse(await response.text()) as SendRequestResponse;
  const status = body.FlexStatementResponse?.Status;
  const referenceCode = body.FlexStatementResponse?.ReferenceCode;
  if (status !== "Success" || !referenceCode) {
    const failureMessage = `Flex SendRequest failed: ${body.FlexStatementResponse?.ErrorMessage ?? status ?? "unknown error"}`;
    if (isFlexRateLimitResponse(body.FlexStatementResponse?.ErrorCode, body.FlexStatementResponse?.ErrorMessage)) {
      throw new FlexRateLimitError(failureMessage);
    }
    throw new Error(failureMessage);
  }
  return referenceCode;
}

function sendFlexRequestRetryingRateLimit(token: string, queryId: string): Promise<string> {
  return retryOnFlexRateLimit(() => sendFlexRequest(token, queryId), {
    onRetry: ({ attempt, maxAttempts, delayMs }) =>
      console.warn(`Flex SendRequest was rate limited (attempt ${attempt} of ${maxAttempts}); retrying in ${delayMs / 1000}s.`),
  });
}

async function pollFlexStatement(token: string, referenceCode: string): Promise<FlexStatementXml[]> {
  const deadline = Date.now() + statementPollTimeoutMs;

  while (Date.now() < deadline) {
    const url = `${flexWebServiceBaseUrl}/GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`;
    const response = await fetch(url);
    const body = xmlParser.parse(await response.text()) as GetStatementResponse;

    if (body.FlexStatementResponse) {
      // Statement generation still in progress (code 1019) is expected —
      // retry. Anything else is a real error.
      if (body.FlexStatementResponse.ErrorCode === "1019") {
        await sleep(statementPollIntervalMs);
        continue;
      }
      throw new Error(`Flex GetStatement failed: ${body.FlexStatementResponse.ErrorMessage ?? "unknown error"}`);
    }

    const statements = body.FlexQueryResponse?.FlexStatements?.FlexStatement ?? [];
    return Array.isArray(statements) ? statements : [statements];
  }

  throw new Error("Flex GetStatement timed out waiting for report generation.");
}

/** Throws when the report is not provably for the account this environment's worker is bound to (see flexStatementAccountGuard.ts). */
async function assertStatementsAreForWorkerAccount(statements: FlexStatementXml[]): Promise<void> {
  const workerRow = await db("worker_health").where({ process_name: workerProcessName }).first("ibkr_account_ids", "updated_at");
  const problem = findFlexAccountProblem({
    statementAccountIds: statements.map((statement) => statement.accountId),
    workerAccountIds: workerRow ? (workerRow.ibkr_account_ids ?? []) : null,
    workerHeartbeatAt: workerRow ? new Date(workerRow.updated_at) : null,
    now: new Date(),
  });
  if (problem) throw new Error(`Flex report refused: ${problem}`);
}

/**
 * IBKR has no live API for deposits/withdrawals — that data only exists in
 * Flex Query reports, which run on IBKR's end-of-day statement pipeline
 * and lag up to ~12 hours behind (confirmed via IBKR's own docs, 2026-08-20).
 * So "today" often won't have data yet; the Flex Query itself is configured
 * with a several-day lookback window (set on IBKR's side, not here) so this
 * naturally returns recent days too — see run-daily-pnl-snapshot-job.ts's
 * reconcileCashFlows, which re-checks and retroactively corrects recent
 * days' daily_pnl as their Flex data arrives.
 *
 * Returns net deposit/withdrawal amount per date (YYYY-MM-DD), summing
 * only "Deposits & Withdrawals"-type transactions — dividends, interest,
 * and fees are real trading-adjacent P&L, not external cash flow, and are
 * deliberately excluded.
 */
export async function fetchFlexCashTransactions(): Promise<Map<string, number>> {
  const token = requireEnvironmentVariable("IBKR_FLEX_TOKEN");
  const queryId = requireEnvironmentVariable("IBKR_FLEX_QUERY_ID");

  const referenceCode = await sendFlexRequestRetryingRateLimit(token, queryId);
  const statements = await pollFlexStatement(token, referenceCode);
  await assertStatementsAreForWorkerAccount(statements);

  const transactions = statements.flatMap((statement) => {
    const statementTransactions = statement.CashTransactions?.CashTransaction ?? [];
    return Array.isArray(statementTransactions) ? statementTransactions : [statementTransactions];
  });

  const netFlowByDate = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.type !== depositWithdrawalType) continue;
    const amount = Number(transaction.amount);
    if (Number.isNaN(amount)) continue;
    const dateKey = transaction.dateTime.slice(0, 8); // YYYYMMDD
    const isoDate = `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
    netFlowByDate.set(isoDate, (netFlowByDate.get(isoDate) ?? 0) + amount);
  }
  return netFlowByDate;
}
