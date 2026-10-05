import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Confirming an order reads what is already committed (positions, orders in flight) to judge the limits, then commits its own
// confirmation. Two different orders confirmed at the same instant would both read the state before either committed, and could
// both pass a limit only one fits under. One Postgres advisory lock around "judge, then commit" makes confirms take turns, across
// every web dyno. The lock is transaction-scoped: it is released by the commit or rollback, so a crash can never leave it held.
const orderConfirmationLockKey = 5_100_001;

/** Runs `work` while holding the order-confirmation lock; `work` should do its confirming writes on the transaction it is given. */
export async function withOrderConfirmationLock<T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.raw("SELECT pg_advisory_xact_lock(?)", [orderConfirmationLockKey]);
    return work(transaction);
  });
}
