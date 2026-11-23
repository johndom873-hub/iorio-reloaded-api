import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { VolFarmerV4LegStatus, VolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import { formatEasternTime } from "../lib/easternIsoDate.js";
import type { PositionLegFigures } from "../lib/positionSelectors.js";

// Pluto's memory against the ledger (Marcelo 2026-11-23). A fill that adds to a leg already open writes its trade at once but
// the leg's quantity only at the next position reconciliation, seconds later: in between, the ledger shows fewer shares than
// were bought and Pluto's book value reads low by them. Before a round sizes anything, each ticker's memory (its ended orders
// settled, its holdings adopted) is compared with its open positions:
//   - they agree, or the memory holds an option leg the ledger has closed or assigned (the look settles it first): the round goes on;
//   - they disagree for under ledgerMismatchHoldSeconds: the ledger is catching up, the whole round waits and another runs
//     ledgerCatchUpRetrySeconds later;
//   - they disagree for longer: the ticker is held, with a notice, until they agree again; the other tickers go on.
// Example: IBIT's memory holds 1,600 shares after a 200-share purchase filled at 10:00:47, the ledger still 1,400 at 10:00:53:
// the round waits; at 10:01:08 the ledger shows 1,600 and the round sells the Calls.

export const ledgerMismatchHoldSeconds = 120;
export const ledgerCatchUpRetrySeconds = 15;

/** What a ticker holds, as the memory or the ledger counts it: shares, the shares its short Calls and Puts cover, its long option legs (LEAPS). */
export interface TickerHoldings {
  shares: number;
  callShares: number;
  putShares: number;
  longOptionLegIds: string[];
}

/** Pure: the holdings the memory counts. */
export function memoryHoldingsOf(state: VolFarmerV4SymbolState): TickerHoldings {
  const positions = [state.first, state.second].filter((position) => position !== null);
  const sum = (entries: readonly { shares: number }[]) => entries.reduce((total, entry) => total + entry.shares, 0);
  return {
    shares: positions.reduce((total, position) => total + position.shares, 0),
    callShares: positions.reduce((total, position) => total + sum(position.calls), 0),
    putShares: positions.reduce((total, position) => total + sum(position.puts), 0),
    longOptionLegIds: [...(state.leaps?.legIds ?? [])].sort(),
  };
}

/** Pure: the holdings the ledger shows on the ticker's open legs. */
export function ledgerHoldingsOf(openLegs: readonly Pick<PositionLegFigures, "id" | "legType" | "side" | "optionType" | "quantity" | "multiplier" | "exitAt">[]): TickerHoldings {
  const open = openLegs.filter((leg) => leg.exitAt === null);
  const shortOptionShares = (optionType: "call" | "put") => open.filter((leg) => leg.legType === "option" && leg.side === "short" && leg.optionType === optionType).reduce((total, leg) => total + leg.quantity * leg.multiplier, 0);
  return {
    shares: open.filter((leg) => leg.legType === "stock" && leg.side === "long").reduce((total, leg) => total + leg.quantity, 0),
    callShares: shortOptionShares("call"),
    putShares: shortOptionShares("put"),
    longOptionLegIds: open.filter((leg) => leg.legType === "option" && leg.side === "long").map((leg) => leg.id).sort(),
  };
}

/** Pure: how the memory and the ledger disagree, or null. Example: "shares: Pluto's memory 1600, the ledger 1400". */
export function describeHoldingsMismatch(memory: TickerHoldings, ledger: TickerHoldings): string | null {
  const parts: string[] = [];
  if (memory.shares !== ledger.shares) parts.push(`shares: Pluto's memory ${memory.shares}, the ledger ${ledger.shares}`);
  if (memory.callShares !== ledger.callShares) parts.push(`shares under short Calls: Pluto's memory ${memory.callShares}, the ledger ${ledger.callShares}`);
  if (memory.putShares !== ledger.putShares) parts.push(`shares under short Puts: Pluto's memory ${memory.putShares}, the ledger ${ledger.putShares}`);
  if (memory.longOptionLegIds.join(",") !== ledger.longOptionLegIds.join(",")) parts.push(`LEAPS legs: Pluto's memory ${memory.longOptionLegIds.length}, the ledger ${ledger.longOptionLegIds.length}`);
  return parts.length === 0 ? null : parts.join("; ");
}

/** The option legs the memory refers to (orders still to settle, "action:…", are not legs yet). */
export function memoryOptionLegIds(state: VolFarmerV4SymbolState): string[] {
  const ids = [state.first, state.second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((entry) => entry.legId)));
  return [...new Set([...ids, ...(state.leaps?.legIds ?? [])])].filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:") && !legId.startsWith("unsent-"));
}

export type LedgerCheckVerdict =
  | { kind: "matches" }
  /** Not compared this round: the memory holds an option leg the ledger has closed or assigned, which the look settles first. */
  | { kind: "settling" }
  | { kind: "catching_up"; detail: string; sinceMs: number }
  | { kind: "held"; detail: string; sinceMs: number };

/**
 * Pure: the verdict on one ticker. `mismatchSinceMs` is when a disagreement was first seen (null: none was); the caller stores
 * the returned since time, or clears it on "matches". Example: memory 1,600 shares, ledger 1,400, first seen 40 s ago:
 * catching up; seen 130 s ago: held.
 */
export function judgeTickerLedger(input: { state: VolFarmerV4SymbolState; openLegs: Parameters<typeof ledgerHoldingsOf>[0]; legStatusById: ReadonlyMap<string, Pick<VolFarmerV4LegStatus, "closed" | "assigned">>; nowMs: number; mismatchSinceMs: number | null }): LedgerCheckVerdict {
  const settling = memoryOptionLegIds(input.state).some((legId) => {
    const status = input.legStatusById.get(legId);
    return status === undefined || status.closed || status.assigned;
  });
  if (settling) return { kind: "settling" };
  const detail = describeHoldingsMismatch(memoryHoldingsOf(input.state), ledgerHoldingsOf(input.openLegs));
  if (detail === null) return { kind: "matches" };
  const sinceMs = input.mismatchSinceMs ?? input.nowMs;
  return input.nowMs - sinceMs >= ledgerMismatchHoldSeconds * 1000 ? { kind: "held", detail, sinceMs } : { kind: "catching_up", detail, sinceMs };
}

/**
 * Pure: the round's note on a disagreement. Example: "the ledger is catching up on a fill (shares: Pluto's memory 1600, the
 * ledger 1400), since 10:00 ET"; held: "held: Pluto's memory and the ledger disagree since 10:00 ET (…); a person needs to look".
 */
export function describeLedgerVerdict(verdict: Extract<LedgerCheckVerdict, { kind: "catching_up" | "held" }>): string {
  const since = formatEasternTime(new Date(verdict.sinceMs));
  return verdict.kind === "catching_up"
    ? `the ledger is catching up on a fill (${verdict.detail}), since ${since}`
    : `held: Pluto's memory and the ledger disagree since ${since} (${verdict.detail}); a person needs to look`;
}

/** When the ticker's disagreement was first seen; null when none is recorded. */
export async function loadLedgerMismatchSince(tickerId: string, connection: Knex = db): Promise<Date | null> {
  const row: { ledger_mismatch_since: Date | null } | undefined = await connection("pluto_vol_farmer_v4_cycles").where({ ticker_id: tickerId }).first("ledger_mismatch_since");
  return row?.ledger_mismatch_since ?? null;
}

/** Records the verdict: the first time a disagreement was seen and how, or clears both once they agree. "settling" leaves them as they are. */
export async function saveLedgerMismatch(tickerId: string, verdict: LedgerCheckVerdict, connection: Knex = db): Promise<void> {
  if (verdict.kind === "settling") return;
  const columns = verdict.kind === "matches" ? { ledger_mismatch_since: null, ledger_mismatch_detail: null } : { ledger_mismatch_since: new Date(verdict.sinceMs), ledger_mismatch_detail: verdict.detail };
  await connection("pluto_vol_farmer_v4_cycles").where({ ticker_id: tickerId }).update(columns);
}
