import { workerHeartbeatAlertAfterMs } from "./workerHeartbeatLiveness.js";

// The Flex Query is created in the IBKR Client Portal of ONE account, and the token is tied to it, so
// nothing in the request says which account the report is about. A query/token carried over from another
// environment (paper vs live) reads that other account's cash flows, and the reconcile would then treat
// real deposits and withdrawals as trading P&L without any error. This compares the account the report
// names with the account the worker is bound to (worker_health, see accountBinding.ts), and refuses to
// trust a report it cannot check.
//
// Pure (no I/O) so every rule is unit tested. Messages carry no changing numbers: the job's alert is
// re-sent whenever its text changes.

export interface FlexAccountGuardInput {
  /** The accountId attribute of every FlexStatement in the report (undefined when the attribute is missing). */
  statementAccountIds: Array<string | undefined>;
  /** worker_health.ibkr_account_ids of the Gateway worker, or null when there is no worker_health row. */
  workerAccountIds: string[] | null;
  workerHeartbeatAt: Date | null;
  now: Date;
}

/** The problem that makes the report untrustworthy, or null when the report is for the worker's account. */
export function findFlexAccountProblem(input: FlexAccountGuardInput): string | null {
  if (input.statementAccountIds.length !== 1) {
    return `the Flex report contains ${input.statementAccountIds.length} statements; the query must cover exactly one account`;
  }
  const statementAccountId = input.statementAccountIds[0];
  if (!statementAccountId) {
    return "the Flex report does not say which account it is for";
  }

  if (input.workerHeartbeatAt === null) {
    return "the Flex report's account cannot be checked because the worker has never reported its account";
  }
  if (input.now.getTime() - input.workerHeartbeatAt.getTime() > workerHeartbeatAlertAfterMs) {
    return "the Flex report's account cannot be checked because the worker's last report is stale";
  }
  if (input.workerAccountIds === null || input.workerAccountIds.length === 0) {
    return "the Flex report's account cannot be checked because the worker reports no account";
  }

  if (!input.workerAccountIds.includes(statementAccountId)) {
    return `the Flex report is for account ${statementAccountId} but this environment's worker is bound to ${input.workerAccountIds.join(", ")}; the Flex token and query belong to a different account`;
  }
  return null;
}
