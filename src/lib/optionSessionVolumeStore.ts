import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { contractKey } from "./signalsLiveScoring.js";

// option_session_volumes (migration 20261015300004): each contract's full-session volume and last-seen IV, from the
// after-close capture (src/ibkr/runOptionSessionVolumeCapture.ts).

export interface OptionSessionVolumeRow {
  tickerId: string;
  sessionDateIso: string;
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
  right: "C" | "P";
  volume: number | null;
  bid: number | null;
  ask: number | null;
  impliedVolatility: number | null;
  stockPrice: number | null;
}

const insertChunkSize = 1_000;

/** Writes one capture's rows; a re-run on the same session replaces the same contracts' rows. */
export async function saveOptionSessionVolumes(rows: readonly OptionSessionVolumeRow[], connection: Knex = db): Promise<void> {
  for (let start = 0; start < rows.length; start += insertChunkSize) {
    const chunk = rows.slice(start, start + insertChunkSize).map((row) => ({
      ticker_id: row.tickerId,
      session_date: row.sessionDateIso,
      expiry: row.expiry,
      strike: row.strike,
      option_right: row.right,
      volume: row.volume,
      bid: row.bid,
      ask: row.ask,
      implied_volatility: row.impliedVolatility,
      stock_price: row.stockPrice,
      captured_at: connection.fn.now(),
    }));
    await connection("option_session_volumes").insert(chunk).onConflict(["ticker_id", "session_date", "expiry", "strike", "option_right"]).merge();
  }
}

/**
 * The volume of `sessionDateIso` per contract (contractKey: "YYYY-MM-DD|strike|C"), or null when the capture holds no row
 * for the ticker and session at all (it did not run, or failed for the ticker): every volume is then unknown. A contract
 * absent from the map, or captured without a volume, is unknown too; the 20% rule sells none of an unknown volume.
 */
export async function loadSessionVolumeByContract(tickerId: string, sessionDateIso: string, connection: Knex = db): Promise<Map<string, number> | null> {
  const rows: { expiry: string; strike: string; option_right: "C" | "P"; volume: number | null }[] = await connection("option_session_volumes")
    .where({ ticker_id: tickerId, session_date: sessionDateIso })
    .select(connection.raw("expiry::text as expiry"), "strike", "option_right", "volume");
  if (rows.length === 0) return null;
  const volumeByContract = new Map<string, number>();
  for (const row of rows) if (row.volume !== null) volumeByContract.set(contractKey({ expiry: row.expiry, strike: Number(row.strike), right: row.option_right }), Number(row.volume));
  return volumeByContract;
}

/** Each contract's latest captured implied volatility (from any session), by contractKey; contracts of expiries before `fromExpiryIso` are left out. */
export async function loadLastSeenImpliedVolatilityByContract(tickerId: string, fromExpiryIso: string, connection: Knex = db): Promise<Map<string, number>> {
  const rows: { expiry: string; strike: string; option_right: "C" | "P"; implied_volatility: string }[] = await connection.raw(
    `SELECT DISTINCT ON (expiry, strike, option_right) expiry::text AS expiry, strike, option_right, implied_volatility
       FROM option_session_volumes
      WHERE ticker_id = ? AND expiry >= ? AND implied_volatility IS NOT NULL
      ORDER BY expiry, strike, option_right, session_date DESC`,
    [tickerId, fromExpiryIso],
  ).then((result: { rows: { expiry: string; strike: string; option_right: "C" | "P"; implied_volatility: string }[] }) => result.rows);
  return new Map(rows.map((row) => [contractKey({ expiry: row.expiry, strike: Number(row.strike), right: row.option_right }), Number(row.implied_volatility)]));
}
