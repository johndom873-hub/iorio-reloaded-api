import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { PortfolioRequestError, parsePortfolioBookRequest } from "./portfolioSimulatorStore.js";

// The portfolio simulator's saved portfolios (Marcelo 2026-11-04): created, saved, saved under another name and deleted
// from the screen. Each holds a name (unique whatever its case), its tickers with their allocations (null: an equal share
// of what the set ones leave) and its account; horizon, drift and paths are the browser's view settings.

export interface SavedPortfolio {
  id: string;
  name: string;
  tickers: { symbol: string; allocationPct: number | null }[];
  accountDollars: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedPortfolioInput {
  name: string;
  tickers: SavedPortfolio["tickers"];
  accountDollars: number;
}

const maxNameLength = 60;

interface SavedPortfolioRow {
  id: string;
  name: string;
  tickers: SavedPortfolio["tickers"];
  account_dollars: string;
  created_at: Date;
  updated_at: Date;
}

const portfolioOf = (row: SavedPortfolioRow): SavedPortfolio => ({
  id: row.id,
  name: row.name,
  tickers: row.tickers,
  accountDollars: Number(row.account_dollars),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** The request's portfolio, checked: a name of 1–60 characters (trimmed) and a book as the simulator takes it, or no tickers yet. */
export function parseSavedPortfolioInput(body: unknown): SavedPortfolioInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (name.length === 0) throw new PortfolioRequestError("name must not be empty.");
  if (name.length > maxNameLength) throw new PortfolioRequestError(`name may be at most ${maxNameLength} characters.`);
  if (Array.isArray(value.tickers) && value.tickers.length === 0) {
    const accountDollars = value.accountDollars;
    if (typeof accountDollars !== "number" || !Number.isFinite(accountDollars) || accountDollars <= 0 || accountDollars > 1e10) throw new PortfolioRequestError("accountDollars must be a number above 0.");
    return { name, tickers: [], accountDollars };
  }
  const book = parsePortfolioBookRequest({ tickers: value.tickers, accountDollars: value.accountDollars });
  return { name, tickers: book.tickers, accountDollars: book.accountDollars };
}

const duplicateNameError = (name: string) => new BacktestRequestError(`A portfolio named "${name}" already exists. Choose another name.`, 409);
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "23505";

/** Every saved portfolio, by name. */
export async function listSavedPortfolios(connection: Knex = db): Promise<SavedPortfolio[]> {
  const rows: SavedPortfolioRow[] = await connection("backtest_portfolios").select("*").orderByRaw("lower(name)");
  return rows.map(portfolioOf);
}

/** A new portfolio; a 409 when its name is taken. */
export async function createSavedPortfolio(input: SavedPortfolioInput, connection: Knex = db): Promise<SavedPortfolio> {
  try {
    const [row] = await connection("backtest_portfolios")
      .insert({ name: input.name, tickers: JSON.stringify(input.tickers), account_dollars: input.accountDollars })
      .returning("*");
    return portfolioOf(row as SavedPortfolioRow);
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateNameError(input.name);
    throw error;
  }
}

/** Saves over portfolio `id` (its name may change); a 404 when it is gone, a 409 when the name is another's. */
export async function updateSavedPortfolio(id: string, input: SavedPortfolioInput, connection: Knex = db): Promise<SavedPortfolio> {
  try {
    const [row] = await connection("backtest_portfolios")
      .where({ id })
      .update({ name: input.name, tickers: JSON.stringify(input.tickers), account_dollars: input.accountDollars, updated_at: connection.fn.now() })
      .returning("*");
    if (!row) throw new BacktestRequestError("No such portfolio.", 404);
    return portfolioOf(row as SavedPortfolioRow);
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateNameError(input.name);
    throw error;
  }
}

/** Deletes portfolio `id`; a 404 when it is gone. */
export async function deleteSavedPortfolio(id: string, connection: Knex = db): Promise<void> {
  const deleted = await connection("backtest_portfolios").where({ id }).delete();
  if (deleted === 0) throw new BacktestRequestError("No such portfolio.", 404);
}
