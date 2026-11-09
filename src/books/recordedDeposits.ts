import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { easternIsoDate, weekdaysAfterUntil } from "../lib/easternIsoDate.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import type { StatementEntryDraft } from "./statementAttribution.js";

// A deposit recorded before IBKR's statement holds it (Marcelo 2026-11-09). Cash sent into the account shows in IBKR's
// live cash at once, but the books only learn of it from the nightly statement, a day or two later; until then it can
// be neither split nor spent, and the books' cash looks short of IBKR's. An admin records it instead: a deposit waiting
// in Unallocated (kind external_transfer, no statement row yet), split on the Dashboard like any other. When the
// statement brings the transfer, the import gives the recorded entry IBKR's row key and time instead of posting the row
// again, so it is counted once. Until then the nightly check against IBKR's ending cash leaves it out (the statement
// cannot hold it yet). Matched to the cent and by sign; a transfer that matches no recorded deposit while one is waiting
// is held back for a person rather than risk counting the deposit twice.
// Example: $1,050,003.70 recorded on 9 Nov and split $800,000 Pluto / $250,003.70 Manual; the 10 Nov statement's
// transfer of 1,050,003.70 takes its place, and the books' cash matches IBKR's from the moment it was recorded.

export const recordedDepositDescriptionPrefix = "Recorded before IBKR's statement:";

/** Weekdays a recorded deposit may wait for the statement before each import reports it. */
export const recordedDepositReportAfterWeekdays = 3;

const cents = (dollars: number) => Math.round(dollars * 100);

/** The ledger entries that are recorded deposits no statement row has matched yet. */
export function whereUnmatchedRecordedDeposit(query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query.where({ book_key: "unallocated", kind: "external_transfer" }).whereNull("source_row_key");
}

/** Leaves out the recorded deposits no statement row has matched yet (the check against IBKR's ending cash). */
export function whereNotUnmatchedRecordedDeposit(query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query.whereNot((inner) => inner.where({ kind: "external_transfer" }).whereNull("source_row_key"));
}

export interface UnmatchedRecordedDeposit {
  id: string;
  amount: number;
  effectiveAt: Date;
  description: string;
}

export async function loadUnmatchedRecordedDeposits(connection: Knex | Knex.Transaction): Promise<UnmatchedRecordedDeposit[]> {
  const rows: { id: string; amount: string; effective_at: Date; description: string }[] = await whereUnmatchedRecordedDeposit(connection("book_cash_entries"))
    .orderBy("effective_at")
    .select("id", "amount", "effective_at", "description");
  return rows.map((row) => ({ id: row.id, amount: Number(row.amount), effectiveAt: new Date(row.effective_at), description: row.description }));
}

/** Records a deposit (positive) or withdrawal (negative) ahead of the statement, waiting in Unallocated to be split. */
export async function recordDepositBeforeStatement(
  connection: Knex,
  input: { amountDollars: number; description: string; at: Date; createdByUserId: string | null },
): Promise<{ entryId: string }> {
  if (!Number.isFinite(input.amountDollars) || cents(input.amountDollars) === 0) throw new Error("The amount must be a non-zero dollar amount.");
  return connection.transaction(async (trx) => {
    if (!(await trx("books_cutover").first("id"))) throw new Error("The books have not been started.");
    const waiting = (await loadUnmatchedRecordedDeposits(trx)).find((deposit) => cents(deposit.amount) === cents(input.amountDollars));
    if (waiting) throw new Error(`A recorded deposit of ${formatWholeDollars(waiting.amount)} is already waiting for the statement (${waiting.id}).`);
    const [row] = await trx("book_cash_entries")
      .insert({
        book_key: "unallocated",
        amount: input.amountDollars,
        effective_at: input.at,
        kind: "external_transfer",
        source_row_key: null,
        group_id: randomUUID(),
        description: `${recordedDepositDescriptionPrefix} ${input.description}`.trim(),
        needs_review: false,
        created_by_user_id: input.createdByUserId,
      })
      .returning("id");
    return { entryId: String(row.id ?? row) };
  });
}

export type StatementTransferOutcome = { kind: "matched"; entryId: string } | { kind: "held_back"; problem: string } | { kind: "post" };

/**
 * Inside the import's transaction: a statement transfer that matches a waiting recorded deposit (same cents) takes its
 * place; one that matches none while a deposit of the same sign waits is held back for a person; otherwise it is posted.
 */
export async function settleStatementTransferAgainstRecordedDeposits(trx: Knex.Transaction, draft: StatementEntryDraft, effectiveAt: Date): Promise<StatementTransferOutcome> {
  if (draft.kind !== "external_transfer" || draft.bookKey !== "unallocated") return { kind: "post" };
  const waiting: { id: string; amount: string; description: string }[] = await whereUnmatchedRecordedDeposit(trx("book_cash_entries")).orderBy("effective_at").forUpdate().select("id", "amount", "description");
  const match = waiting.find((entry) => cents(Number(entry.amount)) === cents(draft.amount));
  if (match) {
    await trx("book_cash_entries").where({ id: match.id }).update({
      source_row_key: draft.sourceRowKey,
      statement_row: draft.statementRow,
      effective_at: effectiveAt,
      description: `${draft.description} (recorded ${match.description.replace(recordedDepositDescriptionPrefix, "").trim() || "before the statement"})`,
    });
    return { kind: "matched", entryId: match.id };
  }
  const sameSign = waiting.filter((entry) => Math.sign(Number(entry.amount)) === Math.sign(draft.amount));
  if (sameSign.length > 0) {
    return {
      kind: "held_back",
      problem: `IBKR's statement has a transfer of ${draft.amount.toFixed(2)} (${draft.description}) that matches no recorded deposit while ${sameSign.map((entry) => Number(entry.amount).toFixed(2)).join(", ")} waits: not posted, so it is not counted twice; a person must check the amounts`,
    };
  }
  return { kind: "post" };
}

/** Recorded deposits still unmatched after the statement's last day, once they have waited too long. */
export function staleRecordedDepositProblems(deposits: UnmatchedRecordedDeposit[], statementToDateIso: string): string[] {
  return deposits
    .filter((deposit) => weekdaysAfterUntil(easternIsoDate(deposit.effectiveAt), statementToDateIso) >= recordedDepositReportAfterWeekdays)
    .map((deposit) => `the deposit of ${deposit.amount.toFixed(2)} recorded on ${easternIsoDate(deposit.effectiveAt)} is still not in IBKR's statement (through ${statementToDateIso})`);
}
