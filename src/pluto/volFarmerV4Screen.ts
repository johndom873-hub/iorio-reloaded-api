import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { volFarmerV4BreakEven, type VolFarmerV4Position } from "../backtest/engine/volFarmerV4Steps.js";
import { volFarmerV4MemoryFromStored, type VolFarmerV4Memory, type VolFarmerV4OrderKind } from "./volFarmerV4LiveBook.js";
import type { VolFarmerV4RoundFigures } from "./volFarmerV4LookLoader.js";
import { loadEnabledPlutoTickerSettings, type PlutoTickerSettings } from "./tickerSettingsStore.js";
import { loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { loadLiveTradingSessions } from "../lib/liveTradingSessions.js";
import { daysToExpiry, describeOptionContract } from "../lib/optionContractLabel.js";
import { loadPreviousClose } from "../lib/tickerCalendarQueries.js";
import { formatTradePrice, toIsoExpiry } from "../lib/tradeMessageFormatting.js";
import { resolvePlutoSession } from "./sessionSchedule.js";
import { loadPlutoSettings } from "./settingsStore.js";
import { plutoOrdersSentToday, loadPlutoOrdersSentToday } from "./safetyLimits.js";
import { describePlutoBlock, loadPlutoState } from "./stateStore.js";
import { describeVolFarmerV4NextActions, type VolFarmerV4ActionLine, type VolFarmerV4NextAction } from "./volFarmerV4NextActions.js";
import { loadVolFarmerV4StepImpliedVolatility } from "./volFarmerV4LookLoader.js";
import { volFarmerV4RulesOf } from "./volFarmerV4LiveBook.js";

// The Pluto screen's Vol Farmer v4 card: each enabled ticker running v4, its two positions and LEAPS as v4's memory
// counts them (pluto_vol_farmer_v4_cycles), the orders still working and what its last round said.

/** An option a position holds: a leg of the book, or an order still working (its leg not known yet). */
export interface VolFarmerV4ScreenOption {
  strike: number;
  expiry: string;
  contracts: number;
  working: boolean;
}

export interface VolFarmerV4ScreenPosition {
  shares: number;
  /** What each share cost: the first position's at the cycle's break-even when adopted, the second's its assigned Put's strike. */
  costPerShare: number;
  /** B-E¹ / B-E²: what each share cost less the premiums kept per share; null while the second position holds no shares. */
  breakEvenPerShare: number | null;
  calls: VolFarmerV4ScreenOption[];
  puts: VolFarmerV4ScreenOption[];
}

/** The last order Pluto sent on a ticker, from its activity: when, what, its limit and how it ended. */
export interface VolFarmerV4ScreenLastOrder {
  at: string;
  text: string;
}

export interface VolFarmerV4ScreenTicker {
  symbol: string;
  /** When v4 (or v2 before it) adopted the ticker's holdings; null for a cycle it opened itself. */
  adoptedAt: string | null;
  /** v4 has no memory of the ticker yet: it waits to adopt its holdings (the last round's notes say why), or has not looked yet. */
  waiting: boolean;
  first: VolFarmerV4ScreenPosition | null;
  second: VolFarmerV4ScreenPosition | null;
  leaps: { strike: number; expiry: string; heldContracts: number; intendedContracts: number } | null;
  /** The orders still working: an option order's contract and contracts, a share order's shares (its strike 0 and expiry ""). */
  workingOrders: { kind: VolFarmerV4OrderKind; strike: number; expiry: string; contracts: number; shares: number | null }[];
  lastRoundAt: string | null;
  lastRoundNotes: string[];
  lastRoundFigures: VolFarmerV4RoundFigures | null;
  /** What v4 does next on the ticker, when, and what stops it (volFarmerV4NextActions.ts). */
  nextAction: VolFarmerV4NextAction;
  /** The six actions v4 can take, each with its state and why. */
  actions: VolFarmerV4ActionLine[];
  lastOrder: VolFarmerV4ScreenLastOrder | null;
  /** Orders Pluto sent on the ticker today that were cancelled unfilled (in whole or in part). */
  cancelledToday: number;
}

type VolFarmerV4ScreenTickerBase = Omit<VolFarmerV4ScreenTicker, "nextAction" | "actions" | "lastOrder" | "cancelledToday">;

interface CycleRow {
  ticker_id: string;
  memory: VolFarmerV4Memory | null;
  adopted_at: Date | null;
  last_round_at: Date | null;
  last_round_notes: string[] | null;
  last_round_figures: VolFarmerV4RoundFigures | null;
}

export async function loadVolFarmerV4Screen(connection: Knex = db): Promise<VolFarmerV4ScreenTicker[]> {
  const tickers = (await loadEnabledPlutoTickerSettings(connection));
  if (tickers.length === 0) return [];
  const rows: CycleRow[] = await connection("pluto_vol_farmer_v4_cycles").whereIn("ticker_id", tickers.map((ticker) => ticker.tickerId)).select("ticker_id", "memory", "adopted_at", "last_round_at", "last_round_notes", "last_round_figures");
  const rowByTickerId = new Map(rows.map((row) => [row.ticker_id, row]));
  const legIds = rows.flatMap((row) => (row.memory === null ? [] : memoryLegIds(row.memory))).filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:"));
  const legs: { id: string; strike_price: string | null; expiry_date: string | null; quantity: number; exit_at: Date | null }[] =
    legIds.length === 0 ? [] : await connection("position_legs").whereIn("id", [...new Set(legIds)]).select("id", "strike_price", connection.raw("expiry_date::text as expiry_date"), "quantity", "exit_at");
  const legById = new Map(legs.map((leg) => [leg.id, leg]));
  const base: VolFarmerV4ScreenTickerBase[] = tickers.map((ticker) => {
    const row = rowByTickerId.get(ticker.tickerId);
    const memory = row?.memory ? volFarmerV4MemoryFromStored(row.memory) : null;
    const optionOf = (legId: string, shares: number): VolFarmerV4ScreenOption | null => {
      const contracts = Math.round(shares / sharesPerContract);
      const pending = memory?.pending.find((order) => order.ref === legId);
      if (pending) return { strike: pending.strike, expiry: pending.expiry, contracts, working: true };
      const leg = legById.get(legId);
      if (!leg || leg.strike_price === null || leg.expiry_date === null) return null;
      return { strike: Number(leg.strike_price), expiry: leg.expiry_date, contracts, working: false };
    };
    const positionOf = (position: VolFarmerV4Position | null): VolFarmerV4ScreenPosition | null =>
      position === null
        ? null
        : {
            shares: position.shares,
            costPerShare: position.costPerShare,
            breakEvenPerShare: volFarmerV4BreakEven(position),
            calls: position.calls.flatMap((call) => optionOf(call.legId, call.shares) ?? []),
            puts: position.puts.flatMap((put) => optionOf(put.legId, put.shares) ?? []),
          };
    const leaps = memory?.state.leaps ?? null;
    return {
      symbol: ticker.symbol,
      adoptedAt: row?.adopted_at?.toISOString() ?? null,
      waiting: memory === null,
      first: positionOf(memory?.state.first ?? null),
      second: positionOf(memory?.state.second ?? null),
      leaps:
        leaps === null
          ? null
          : {
              strike: leaps.strike,
              expiry: leaps.expiry,
              heldContracts: leaps.legIds.reduce((sum, legId) => {
                const leg = legById.get(legId);
                return sum + (leg && leg.exit_at === null ? leg.quantity : 0);
              }, 0),
              intendedContracts: leaps.intendedContracts,
            },
      workingOrders: (memory?.pending ?? []).map((order) => ({ kind: order.kind, strike: order.strike, expiry: order.expiry, contracts: order.contracts, shares: order.shares ?? null })),
      lastRoundAt: row?.last_round_at?.toISOString() ?? null,
      lastRoundNotes: row?.last_round_notes ?? [],
      lastRoundFigures: row?.last_round_figures ?? null,
    };
  });
  return withNextActions(base, tickers, rowByTickerId, connection);
}

const unavailableNextAction: VolFarmerV4NextAction = { state: "not_due", text: "Next action unavailable", sub: null, alert: null };

/** Each ticker's Next action, its six actions and its last order. A failure to read an input leaves the card as it was, without them. */
async function withNextActions(base: VolFarmerV4ScreenTickerBase[], tickers: PlutoTickerSettings[], rowByTickerId: Map<string, CycleRow>, connection: Knex): Promise<VolFarmerV4ScreenTicker[]> {
  const withoutActions = (): VolFarmerV4ScreenTicker[] => base.map((ticker) => ({ ...ticker, nextAction: unavailableNextAction, actions: [], lastOrder: null, cancelledToday: 0 }));
  try {
    const now = new Date();
    const todayIso = easternIsoDate(now);
    const ids = tickers.map((ticker) => ticker.tickerId);
    const settings = await loadPlutoSettings(connection);
    const [plutoState, session, liveSessions, stockCommissions, chainRows, quoteRows, bookOrdersToday, orderRows, cancelledRows] = await Promise.all([
      loadPlutoState(connection),
      resolvePlutoSession(now, settings),
      loadLiveTradingSessions(now),
      loadStockCommissionEstimator(),
      connection("option_chain_params").whereIn("ticker_id", ids).select("ticker_id", "expirations") as Promise<{ ticker_id: string; expirations: string[] }[]>,
      connection("option_quote_band_quotes").whereIn("ticker_id", ids).whereRaw("trading_date::text = ?", [todayIso]).whereNotNull("stock_price").orderBy("quoted_at", "desc").select("ticker_id", "stock_price") as Promise<{ ticker_id: string; stock_price: string }[]>,
      loadPlutoOrdersSentToday(now, connection),
      connection("pluto_actions")
        .whereIn("symbol", base.map((ticker) => ticker.symbol))
        .whereNotNull("order_request_id")
        .whereNotIn("outcome", ["blocked", "error", "validated"])
        .distinctOn("symbol")
        .orderBy([{ column: "symbol" }, { column: "created_at", order: "desc" }])
        .select("symbol", "created_at", "kind", "quantity", "limit_price", "fill_price", "outcome", "contract") as Promise<ActionRow[]>,
      connection("pluto_actions")
        .whereIn("symbol", base.map((ticker) => ticker.symbol))
        .whereIn("outcome", ["cancelled", "cancelled_partially_filled"])
        .whereRaw("(created_at at time zone 'America/New_York')::date = ?::date", [todayIso])
        .groupBy("symbol")
        .select("symbol", connection.raw("count(*)::int as count")) as Promise<{ symbol: string; count: number }[]>,
    ]);
    const blockReason = describePlutoBlock(plutoState);
    const windowOpenToday = session.isOpen && now.getTime() < session.windowEndAtMs;
    const expirationsByTickerId = new Map(chainRows.map((row) => [row.ticker_id, row.expirations]));
    const bandPriceByTickerId = new Map<string, number>();
    for (const row of quoteRows) if (!bandPriceByTickerId.has(row.ticker_id)) bandPriceByTickerId.set(row.ticker_id, Number(row.stock_price));
    const lastOrderBySymbol = new Map(orderRows.map((row) => [row.symbol, row]));
    const cancelledBySymbol = new Map(cancelledRows.map((row) => [row.symbol, row.count]));
    return await Promise.all(
      base.map(async (ticker, index): Promise<VolFarmerV4ScreenTicker> => {
        const settingsOfTicker = tickers[index]!;
        const row = rowByTickerId.get(settingsOfTicker.tickerId);
        const memory = row?.memory ? volFarmerV4MemoryFromStored(row.memory) : null;
        const [ordersTodayTicker, previousClose, stepImpliedVolatility] = await Promise.all([
          plutoOrdersSentToday(now, ticker.symbol, connection).then((result) => Number((result as { count?: string | number } | undefined)?.count ?? 0)),
          bandPriceByTickerId.has(settingsOfTicker.tickerId) ? Promise.resolve(null) : loadPreviousClose(settingsOfTicker.tickerId, todayIso),
          memory?.state.second && memory.state.second.shares > 0 ? loadVolFarmerV4StepImpliedVolatility(settingsOfTicker.tickerId, todayIso, connection) : Promise.resolve(null),
        ]);
        const { nextAction, actions } = describeVolFarmerV4NextActions({
          ticker,
          state: memory?.state ?? null,
          rules: volFarmerV4RulesOf(settings, settingsOfTicker),
          todayIso,
          windowOpenToday,
          blockReason,
          expirations: expirationsByTickerId.get(settingsOfTicker.tickerId) ?? [],
          openDays: liveSessions.openDays.filter((day) => day >= todayIso),
          caps: { ordersTodayTicker, ordersTodayBook: bookOrdersToday, maxPerTicker: settings.safetyMaxOrdersPerTickerPerDay, maxPerDay: settings.safetyMaxOrdersPerDay },
          stockPrice: bandPriceByTickerId.get(settingsOfTicker.tickerId) ?? previousClose?.close ?? null,
          stockCommissionDollars: (shares: number) => stockCommissions.perShareDollars("buy") * shares,
          stepImpliedVolatility,
        });
        const lastOrder = lastOrderBySymbol.get(ticker.symbol);
        return { ...ticker, nextAction, actions, lastOrder: lastOrder === undefined ? null : { at: lastOrder.created_at.toISOString(), text: describeLastOrder(lastOrder) }, cancelledToday: cancelledBySymbol.get(ticker.symbol) ?? 0 };
      }),
    );
  } catch (error) {
    console.warn(`Pluto's Vol Farmer v4 card could not read its next actions: ${error instanceof Error ? error.message : String(error)}`);
    return withoutActions();
  }
}

interface ActionRow {
  symbol: string;
  created_at: Date;
  kind: string;
  quantity: number | null;
  limit_price: string | null;
  fill_price: string | null;
  outcome: string;
  contract: { strike?: number; expiry?: string; right?: "C" | "P" } | null;
}

/** "Sell 10 × $46 Call · 4 Nov (0DTE), limit $0.27, filled at $0.37": an order as the activity recorded it, its DTE as of the day it was sent. */
export function describeLastOrder(row: ActionRow): string {
  const quantity = row.quantity ?? 0;
  const sentOn = easternIsoDate(row.created_at);
  const contract = row.contract?.strike === undefined || row.contract.expiry === undefined ? null : describeOptionContract({ strike: row.contract.strike, right: row.contract.right ?? "C", expiry: row.contract.expiry, dte: daysToExpiry(toIsoExpiry(row.contract.expiry), sentOn) });
  const what =
    row.kind === "open_covered_call" || row.kind === "open_cash_secured_put" ? `Sell ${quantity} × ${contract}`
    : row.kind === "buy_leaps" ? `Buy ${quantity} × ${contract} (LEAPS)`
    : row.kind === "sell_leaps" ? `Sell ${quantity} × ${contract} (LEAPS)`
    : row.kind === "close_leg" ? `Buy back ${quantity} × ${contract}`
    : row.kind === "buy_shares" ? `Buy ${quantity} shares`
    : row.kind === "close_shares" ? `Sell ${quantity} shares`
    : row.kind;
  const limit = row.limit_price === null ? "" : `, limit $${formatTradePrice(Number(row.limit_price))}`;
  const ended =
    row.outcome === "filled" ? (row.fill_price === null ? "filled" : `filled at $${formatTradePrice(Number(row.fill_price))}`)
    : row.outcome === "partially_filled" ? "partly filled"
    : row.outcome === "cancelled" ? "cancelled unfilled"
    : row.outcome === "cancelled_partially_filled" ? "cancelled, partly filled"
    : row.outcome === "rejected" ? "rejected"
    : "working";
  return `${what}${limit}, ${ended}`;
}

function memoryLegIds(memory: VolFarmerV4Memory): string[] {
  const { first, second, leaps } = memory.state;
  return [...[first, second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((option) => option.legId))), ...(leaps?.legIds ?? [])];
}
