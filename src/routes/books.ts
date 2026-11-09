import { randomUUID } from "node:crypto";
import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAdmin, requireAuth } from "../middleware/requireAuth.js";
import { loadBooksLiveState, loadPlutoBookSymbolsNow } from "../books/bookFigures.js";
import { bookLabels, isBookKey } from "../books/bookKeys.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { applyBooksCutover, booksStartFromStatement, planBooksCutover, type CutoverPlan } from "../books/cutover.js";

// The Pluto and Manual books (Marcelo 2026-11-05). Everyone sees both books; only an admin splits a deposit or moves cash.

export const booksRouter = Router();
booksRouter.use(requireAuth);

/** Deposits and withdrawals in Unallocated that no split has allocated yet. */
async function loadPendingTransfers() {
  const rows: { id: string; amount: string; effective_at: Date; description: string }[] = await db("book_cash_entries as e")
    .where({ "e.book_key": "unallocated", "e.kind": "external_transfer" })
    .whereNotExists(db("book_cash_entries as s").whereRaw("s.allocates_entry_id = e.id"))
    .orderBy("e.effective_at")
    .select("e.id", "e.amount", "e.effective_at", "e.description");
  return rows.map((row) => ({ entryId: row.id, amountDollars: Number(row.amount), at: new Date(row.effective_at).toISOString(), description: row.description }));
}

booksRouter.get("/", async (_request, response) => {
  const [state, pendingTransfers, lastImport, needsReviewCount, lastNight, plutoSymbols] = await Promise.all([
    loadBooksLiveState(),
    loadPendingTransfers(),
    db("book_statement_imports").orderBy("imported_at", "desc").first(db.raw("to_date::text AS to_date"), "ending_cash", "ledger_cash", "gap", "imported_at"),
    db("book_cash_entries").where({ needs_review: true }).countDistinct({ count: "group_id" }).first(),
    db("book_value_snapshots").orderBy("snapshot_date", "desc").first(db.raw("snapshot_date::text AS snapshot_date")),
    loadPlutoBookSymbolsNow(),
  ]);
  if (!state.ready) {
    // What starting the books would read (POST /books/cutover): IBKR's statement on prod, its live figures elsewhere.
    response.json({ ready: false, startsFrom: cutoverFromStatement() ? "statement" : "live" });
    return;
  }
  const lastNightValues = lastNight
    ? Object.fromEntries((await db("book_value_snapshots").where({ snapshot_date: lastNight.snapshot_date }).select("book_key", "book_value")).map((row: { book_key: string; book_value: string }) => [row.book_key, Number(row.book_value)]))
    : null;
  response.json({
    ready: true,
    books: state.books,
    unallocatedCash: state.unallocatedCash,
    ibkrTotalCash: state.ibkrTotalCash,
    ibkrNetLiquidationValue: state.ibkrNetLiquidationValue,
    cashGapAgainstIbkr: state.cashGapAgainstIbkr,
    confirmedThrough: state.confirmedThrough.toISOString(),
    minCashReservePctByBook: state.minCashReservePctByBook,
    /** The tickers in Pluto's book now: an order or position on any other is Manual's (hedges always are). */
    plutoSymbols: [...plutoSymbols].sort(),
    pendingTransfers,
    lastNightBookValues: lastNight ? { snapshotDate: lastNight.snapshot_date, pluto: lastNightValues?.pluto ?? null, manual: lastNightValues?.manual ?? null } : null,
    lastStatement: lastImport
      ? { toDate: lastImport.to_date, endingCash: lastImport.ending_cash === null ? null : Number(lastImport.ending_cash), ledgerCash: Number(lastImport.ledger_cash), gap: lastImport.gap === null ? null : Number(lastImport.gap), importedAt: new Date(lastImport.imported_at).toISOString() }
      : null,
    needsReviewCount: Number(needsReviewCount?.count ?? 0),
  });
});

const toCents = (dollars: number) => Math.round(dollars * 100);

/**
 * Splits a deposit or withdrawal waiting in Unallocated between the books (Marcelo 2026-11-05). The two parts must add up
 * to the amount exactly and share its sign; the split is final (a later change is a move between books).
 */
booksRouter.post("/pending-transfers/:entryId/split", requireAdmin, async (request, response) => {
  const plutoDollars = Number(request.body?.plutoDollars);
  const manualDollars = Number(request.body?.manualDollars);
  if (!Number.isFinite(plutoDollars) || !Number.isFinite(manualDollars)) {
    response.status(400).json({ error: "plutoDollars and manualDollars must be dollar amounts." });
    return;
  }
  const userId = request.session.userId as string;
  const outcome = await db.transaction(async (trx) => {
    const entry = await trx("book_cash_entries").where({ id: request.params.entryId, book_key: "unallocated", kind: "external_transfer" }).forUpdate().first("id", "amount", "description");
    if (!entry) return { status: 404, error: "No such deposit or withdrawal." };
    if (await trx("book_cash_entries").where({ allocates_entry_id: entry.id }).first("id")) return { status: 409, error: "This deposit or withdrawal is already split." };
    const amount = Number(entry.amount);
    if (toCents(plutoDollars + manualDollars) !== toCents(amount)) return { status: 400, error: `The two parts must add up to ${formatWholeDollars(amount)}.` };
    if (plutoDollars * amount < 0 || manualDollars * amount < 0) return { status: 400, error: amount > 0 ? "A deposit's parts cannot be negative." : "A withdrawal's parts cannot be positive." };
    const groupId = randomUUID();
    const now = new Date();
    const description = `Split of ${entry.description}`;
    await trx("book_cash_entries").insert([
      { book_key: "unallocated", amount: -amount, effective_at: now, kind: "deposit_split", group_id: groupId, allocates_entry_id: entry.id, description, created_by_user_id: userId },
      { book_key: "pluto", amount: amount - manualDollars, effective_at: now, kind: "deposit_split", group_id: groupId, allocates_entry_id: entry.id, description, created_by_user_id: userId },
      { book_key: "manual", amount: manualDollars, effective_at: now, kind: "deposit_split", group_id: groupId, allocates_entry_id: entry.id, description, created_by_user_id: userId },
    ]);
    return { status: 200, error: null };
  });
  if (outcome.status !== 200) {
    response.status(outcome.status).json({ error: outcome.error });
    return;
  }
  response.json({ split: true });
});

/** Moves cash from one book to the other (Marcelo 2026-11-05): at most the source's available cash; what its Puts hold stays. */
booksRouter.post("/moves", requireAdmin, async (request, response) => {
  const fromBook = request.body?.fromBook;
  const toBook = request.body?.toBook;
  const amountDollars = Number(request.body?.amountDollars);
  if (!isBookKey(fromBook) || !isBookKey(toBook) || fromBook === toBook) {
    response.status(400).json({ error: "fromBook and toBook must be pluto and manual, one each." });
    return;
  }
  if (!Number.isFinite(amountDollars) || toCents(amountDollars) <= 0) {
    response.status(400).json({ error: "amountDollars must be a positive dollar amount." });
    return;
  }
  const state = await loadBooksLiveState();
  if (!state.ready) {
    response.status(409).json({ error: "The books have not been started yet." });
    return;
  }
  const available = state.books[fromBook].availableCash;
  if (available === null) {
    response.status(503).json({ error: "IBKR's cash is unavailable right now, so the move cannot be checked. Try again shortly." });
    return;
  }
  if (toCents(amountDollars) > toCents(available)) {
    response.status(409).json({ error: `${bookLabels[fromBook]} can move up to ${formatWholeDollars(Math.max(0, available))}, its available cash.` });
    return;
  }
  const userId = request.session.userId as string;
  const groupId = randomUUID();
  const now = new Date();
  const description = `Moved from ${bookLabels[fromBook]} to ${bookLabels[toBook]}`;
  await db("book_cash_entries").insert([
    { book_key: fromBook, amount: -amountDollars, effective_at: now, kind: "book_move", group_id: groupId, description, created_by_user_id: userId },
    { book_key: toBook, amount: amountDollars, effective_at: now, kind: "book_move", group_id: groupId, description, created_by_user_id: userId },
  ]);
  response.json({ moved: true });
});

// Starting the books from the screen (Marcelo 2026-11-05; once per environment, admins only): prod starts from IBKR's
// statement and never from live figures; staging and development from IBKR's live figures (the paper account's statement
// has no sections). Preview writes nothing; start recomputes the plan at the moment it is applied.
const cutoverFromStatement = booksStartFromStatement;

function describeCutoverPlan(plan: CutoverPlan) {
  return {
    mode: plan.mode,
    cutOverAt: plan.cutOverAt.toISOString(),
    statementToDate: plan.statementToDate,
    ibkrCash: plan.ibkrCash,
    pluto: { cash: plan.plutoOpeningCash, positionsValue: plan.plutoPositionsValue, bookValue: plan.plutoStartingValue },
    manual: { cash: plan.manualOpeningCash, positionsValue: plan.manualPositionsValue, bookValue: plan.manualOpeningCash + plan.manualPositionsValue },
    plutoSymbols: plan.plutoSymbols,
    legsWithoutClosingPrice: plan.legsWithoutClosingPrice,
  };
}

function readPlutoStartingValue(body: unknown): number | null {
  const value = Number((body as { plutoStartingValue?: unknown } | undefined)?.plutoStartingValue);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

booksRouter.post("/cutover/preview", requireAdmin, async (request, response) => {
  const plutoStartingValue = readPlutoStartingValue(request.body);
  if (plutoStartingValue === null) {
    response.status(400).json({ error: "Pluto's starting value must be a dollar amount of 0 or more." });
    return;
  }
  try {
    response.json(describeCutoverPlan(await planBooksCutover(plutoStartingValue, { withoutStatement: !cutoverFromStatement() })));
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

booksRouter.post("/cutover", requireAdmin, async (request, response) => {
  const plutoStartingValue = readPlutoStartingValue(request.body);
  if (plutoStartingValue === null) {
    response.status(400).json({ error: "Pluto's starting value must be a dollar amount of 0 or more." });
    return;
  }
  try {
    const plan = await planBooksCutover(plutoStartingValue, { withoutStatement: !cutoverFromStatement() });
    if (plan.plutoOpeningCash < 0 || plan.manualOpeningCash < 0) {
      response.status(409).json({ error: `A book would start with negative cash (Pluto ${formatWholeDollars(plan.plutoOpeningCash)}, Manual ${formatWholeDollars(plan.manualOpeningCash)}): Pluto's starting value must be between ${formatWholeDollars(plan.plutoPositionsValue)} and ${formatWholeDollars(plan.ibkrCash + plan.plutoPositionsValue)}.` });
      return;
    }
    await applyBooksCutover(plan, request.session.userId as string);
    response.json(describeCutoverPlan(plan));
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
