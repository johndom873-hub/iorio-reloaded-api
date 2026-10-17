import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { strategiesOutsidePlutoBook } from "../pluto/book.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { computeInFlightOrderNotional, inFlightOrderRequestsQuery, type TraderCapitalFigures } from "./orderLimits.js";
import { positionSelect } from "./positionQueries.js";

// The traders' capital cap (Marcelo 2026-10-17): Pluto's capital budget stays reserved for Pluto whether it runs or not, and a
// trader's opening or rolling order may not take what people use outside Pluto's book above the rest of the account:
//   available = net liquidation value × (100 − Pluto's capital budget %) / 100
//   in use    = EXP $ (capitalAtRisk) of every open position outside Pluto's book + the notional of orders still working outside it
// The book's boundary is book.ts's, so the two halves are measured alike: Pluto's book is every open position on a ticker Pluto
// is enabled on except hedges, and an order belongs to it when it is Pluto's or on an enabled ticker. The check itself is
// evaluateOrderLimitFigures's (orderLimits.ts).

async function loadPlutoEnabledSymbols(): Promise<Set<string>> {
  const rows: { symbol: string }[] = await db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").where("se.bot_enabled", true).select("t.symbol");
  return new Set(rows.map((row) => row.symbol));
}

export interface OpenPositionCapital {
  symbol: string;
  strategyKey: string;
  capitalAtRisk: string | number | null;
}

export interface WorkingOrderForCapital {
  request_type: string;
  payload: OrderRequestPayload;
  pluto_action_id: string | null;
}

/** Pure: the capital in use outside Pluto's book, split at the book's boundary (see the header). */
export function sumCapitalInUseOutsidePluto(openPositions: OpenPositionCapital[], workingOrders: WorkingOrderForCapital[], plutoEnabledSymbols: Set<string>): number {
  let total = 0;
  for (const position of openPositions) {
    const inPlutoBook = plutoEnabledSymbols.has(position.symbol) && !strategiesOutsidePlutoBook.includes(position.strategyKey);
    if (!inPlutoBook) total += Number(position.capitalAtRisk ?? 0);
  }
  for (const order of workingOrders) {
    const inPlutoBook = order.pluto_action_id !== null || plutoEnabledSymbols.has(order.payload.symbol);
    if (!inPlutoBook) total += computeInFlightOrderNotional(order.request_type, order.payload);
  }
  return total;
}

/** EXP $ of the open positions outside Pluto's book, plus the orders still working outside it (excluding `excludeOrderRequestId`). */
export async function loadCapitalInUseOutsidePluto(excludeOrderRequestId?: string): Promise<number> {
  let workingOrdersQuery = inFlightOrderRequestsQuery().select("orq.request_type", "orq.payload", "orq.pluto_action_id");
  if (excludeOrderRequestId) workingOrdersQuery = workingOrdersQuery.whereNot("orq.id", excludeOrderRequestId);
  const [plutoEnabledSymbols, positionsResult, workingOrders] = await Promise.all([
    loadPlutoEnabledSymbols(),
    db.raw(`SELECT x.symbol, x."strategyKey", x."capitalAtRisk" FROM (${positionSelect}) x WHERE x.status = 'open'`),
    workingOrdersQuery as Promise<WorkingOrderForCapital[]>,
  ]);
  return sumCapitalInUseOutsidePluto(positionsResult.rows as OpenPositionCapital[], workingOrders, plutoEnabledSymbols);
}

/** The capital cap's figures for a trader's order; the net liquidation value and the order's notional come from the limit check itself. */
export async function loadTraderCapitalFigures(excludeOrderRequestId?: string): Promise<TraderCapitalFigures> {
  const [capitalInUseOutsidePluto, plutoSettings] = await Promise.all([loadCapitalInUseOutsidePluto(excludeOrderRequestId), loadPlutoSettings()]);
  return { capitalInUseOutsidePluto, plutoCapitalBudgetPct: plutoSettings.capitalBudgetPct };
}
