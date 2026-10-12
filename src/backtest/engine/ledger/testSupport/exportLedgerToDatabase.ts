import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { SimulatedLedger } from "../simulatedLedger.js";

// Writes a simulated ledger into the platform's own tables (positions, position_legs, trades, position_share_sources),
// row for row, so the platform's SQL can be run over a simulated book and compared with the ledger's selectors. For
// tests only: every row gets a new UUID, returned by its ledger id. The tickers must already exist.

export interface ExportedLedgerIds {
  positionIdByLedgerId: Map<string, string>;
  legIdByLedgerId: Map<string, string>;
}

export async function exportLedgerToDatabase(database: Knex, ledger: SimulatedLedger, tickerIdBySymbol: ReadonlyMap<string, string>): Promise<ExportedLedgerIds> {
  const positionIdByLedgerId = new Map<string, string>(ledger.positions.map((position) => [position.id, randomUUID()]));
  const legIdByLedgerId = new Map<string, string>(ledger.legs.map((leg) => [leg.id, randomUUID()]));
  const tickerIdOf = (symbol: string): string => {
    const tickerId = tickerIdBySymbol.get(symbol);
    if (!tickerId) throw new Error(`No ticker id given for ${symbol}.`);
    return tickerId;
  };

  if (ledger.positions.length > 0) {
    await database("positions").insert(
      ledger.positions.map((position) => ({
        id: positionIdByLedgerId.get(position.id)!,
        strategy_key: position.strategyKey,
        ticker_id: tickerIdOf(position.symbol),
        status: position.status,
        opened_at: position.openedAt,
        closed_at: position.closedAt,
        close_reason: position.closeReason,
        unstructured_reason: position.unstructuredReason,
      })),
    );
  }
  if (ledger.legs.length > 0) {
    await database("position_legs").insert(
      ledger.legs.map((leg) => ({
        id: legIdByLedgerId.get(leg.id)!,
        position_id: positionIdByLedgerId.get(leg.positionId)!,
        leg_type: leg.legType,
        side: leg.side,
        quantity: leg.quantity,
        option_type: leg.optionType,
        strike_price: leg.strikePrice,
        expiry_date: leg.expiryDate,
        multiplier: leg.multiplier,
        entry_price: leg.entryPrice,
        entry_at: leg.entryAt,
        exit_price: leg.exitPrice,
        exit_at: leg.exitAt,
        parent_leg_id: leg.parentLegId === null ? null : legIdByLedgerId.get(leg.parentLegId)!,
      })),
    );
  }
  if (ledger.trades.length > 0) {
    await database("trades").insert(
      ledger.trades.map((trade) => ({
        position_leg_id: legIdByLedgerId.get(trade.legId)!,
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        commission: trade.commission,
        executed_at: trade.executedAt,
        is_closing_trade: trade.isClosingTrade,
      })),
    );
  }
  if (ledger.shareSources.length > 0) {
    await database("position_share_sources").insert(ledger.shareSources.map((source) => ({ position_id: positionIdByLedgerId.get(source.positionId)!, source_position_id: positionIdByLedgerId.get(source.sourcePositionId)! })));
  }
  return { positionIdByLedgerId, legIdByLedgerId };
}
