import { db } from "../db/connection.js";
import { deriveCycles, type Cycle, type CycleOptionLeg, type CycleStockLeg, type CycleStockTrade } from "./cycles.js";

export interface SymbolCycles {
  symbol: string;
  tickerId: string;
  cycles: Cycle[];
}

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Cycles per symbol (open and closed), from every option leg, stock leg and stock fill of the given tickers. */
export async function fetchCyclesForTickers(tickerIds: string[] | "all"): Promise<SymbolCycles[]> {
  const filter = tickerIds === "all" ? "" : "AND p.ticker_id = ANY(?)";
  const params = tickerIds === "all" ? [] : [tickerIds];
  const idFilterForBars = tickerIds === "all" ? "" : "WHERE b.ticker_id = ANY(?)";

  const [optionRows, stockLegRows, stockTradeRows, barRows, snapshotRows, tickerRows] = await Promise.all([
    db.raw(
      `SELECT pl.id, pl.position_id AS "positionId", p.ticker_id AS "tickerId", pl.side, pl.option_type AS "optionType",
              pl.strike_price::float AS strike, pl.quantity, pl.multiplier, pl.entry_price::float AS "entryPrice", pl.entry_at AS "entryAt",
              pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.expiry_date::text AS "expiryDate",
              COALESCE((SELECT SUM(tr.commission) FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade), 0)::float AS "closingCommission",
              EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade) AS "hasClosingTrade",
              b.close_price::float AS "expiryClose"
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       LEFT JOIN daily_price_bars b ON b.ticker_id = p.ticker_id AND b.trading_date = pl.expiry_date
       WHERE pl.leg_type = 'option' ${filter}`,
      params,
    ),
    db.raw(
      `SELECT p.ticker_id AS "tickerId", pl.quantity, pl.entry_at AS "entryAt", pl.exit_at AS "exitAt"
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       WHERE pl.leg_type = 'stock' AND pl.side = 'long' ${filter}`,
      params,
    ),
    db.raw(
      `SELECT p.ticker_id AS "tickerId", tr.executed_at AS at, tr.side, tr.quantity, tr.price::float AS price, COALESCE(tr.commission, 0)::float AS commission
       FROM trades tr JOIN position_legs pl ON pl.id = tr.position_leg_id JOIN positions p ON p.id = pl.position_id
       WHERE pl.leg_type = 'stock' ${filter}`,
      params,
    ),
    db.raw(
      `SELECT b.ticker_id AS "tickerId", b.trading_date::text AS date, b.close_price::float AS close
       FROM daily_price_bars b ${idFilterForBars} ORDER BY b.trading_date`,
      tickerIds === "all" ? [] : [tickerIds],
    ),
    db.raw(
      `SELECT DISTINCT ON (s.position_id) s.position_id AS "positionId", s.premium_pnl::float AS "premiumPnl"
       FROM position_pnl_snapshots s JOIN positions p ON p.id = s.position_id
       WHERE p.status = 'open' AND s.premium_pnl IS NOT NULL ${filter}
       ORDER BY s.position_id, s.snapshot_date DESC`,
      params,
    ),
    db.raw(`SELECT DISTINCT p.ticker_id AS "tickerId", t.symbol FROM positions p JOIN tickers t ON t.id = p.ticker_id ${tickerIds === "all" ? "" : "WHERE p.ticker_id = ANY(?)"}`, tickerIds === "all" ? [] : [tickerIds]),
  ]);

  const openPositionPremiumPnl = new Map<string, number>(snapshotRows.rows.map((row: any) => [row.positionId, Number(row.premiumPnl)]));
  const result: SymbolCycles[] = [];
  for (const { tickerId, symbol } of tickerRows.rows as { tickerId: string; symbol: string }[]) {
    const dailyCloses = new Map<string, number>();
    let lastPrice: { date: string; price: number } | null = null;
    for (const bar of barRows.rows.filter((row: any) => row.tickerId === tickerId)) {
      dailyCloses.set(bar.date, bar.close);
      lastPrice = { date: bar.date, price: bar.close };
    }
    const optionLegs: CycleOptionLeg[] = optionRows.rows
      .filter((row: any) => row.tickerId === tickerId)
      .map((row: any) => ({ ...row, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt) }));
    const stockLegs: CycleStockLeg[] = stockLegRows.rows
      .filter((row: any) => row.tickerId === tickerId)
      .map((row: any) => ({ quantity: row.quantity, entryAt: new Date(row.entryAt), exitAt: row.exitAt === null ? null : new Date(row.exitAt) }));
    const stockTrades: CycleStockTrade[] = stockTradeRows.rows
      .filter((row: any) => row.tickerId === tickerId)
      .map((row: any) => ({ at: new Date(row.at), side: row.side, quantity: row.quantity, price: row.price, commission: row.commission }));
    const cycles = deriveCycles({ optionLegs, stockLegs, stockTrades, dailyCloses, lastPrice, openPositionPremiumPnl });
    if (cycles.length > 0) result.push({ symbol, tickerId, cycles });
  }
  void easternDateFormatter;
  return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
