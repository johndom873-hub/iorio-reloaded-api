import { SecType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { IbkrHeldPosition } from "./ibkrGatewayFetchHeldPositions.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { describeSplitRatio, recordStockSplit } from "../lib/stockSplits.js";
import { loadFrozenTickers, type FrozenTicker } from "../lib/tickerFreeze.js";
import { notifyDownThrottled } from "../lib/throttledAlert.js";
import { describeFrozenTickerAlert, expiringSoonDays, frozenTickerAlertKey, frozenTickerReminderIntervalMs } from "../lib/frozenTickerAlert.js";

// Runs on the VPS worker, at the start of each position sync (ibkrGatewayReconcilePositions.ts). A frozen ticker's holdings
// are left out of the sync, so a split IBKR has already applied cannot turn into closes, opens or partial sales that never
// happened (a 1-for-10 reverse split would otherwise look like a sale of 90% of the shares). While frozen, IBKR's holdings of
// the ticker are kept on its pending split for the split:rewrite script, and the alert goes out once a day.

/** The split ratios a position change is read as, and their reverse (the same list as the price guard in stockSplits.ts). */
const splitRatios = [2, 3, 4, 5, 10, 1.5].flatMap((ratio) => [ratio, 1 / ratio]);
/** How close our cost ÷ IBKR's average cost must be to the share ratio. */
const costRatioTolerance = 0.01;

interface OpenStockHolding {
  tickerId: string;
  symbol: string;
  shares: number;
  averageCost: number;
}

/**
 * A split seen in the positions themselves: IBKR's shares of a stock are ours times a split ratio, and its average cost is ours
 * divided by it. A trade cannot do both at once, so the pair is the split. Returns the ratio, or null.
 *
 * Example: we hold 300 at $100.00; IBKR reports 600 at $50.02 → shares ×2, cost ÷1.9992 (within 1%) → a 2-for-1 split.
 */
export function splitSeenInHoldings(ours: { shares: number; averageCost: number }, ibkr: { shares: number; averageCost: number }): number | null {
  if (!(ours.shares > 0) || !(ibkr.shares > 0) || !(ours.averageCost > 0) || !(ibkr.averageCost > 0) || ours.shares === ibkr.shares) return null;
  const shareRatio = ibkr.shares / ours.shares;
  const ratio = splitRatios.find((candidate) => Math.abs(shareRatio / candidate - 1) < 1e-9);
  if (ratio === undefined) return null;
  return Math.abs(ours.averageCost / ibkr.averageCost / ratio - 1) <= costRatioTolerance ? ratio : null;
}

async function loadOpenStockHoldings(): Promise<OpenStockHolding[]> {
  const rows: { tickerId: string; symbol: string; shares: string; cost: string }[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where("pl.leg_type", "stock")
    .where("pl.side", "long")
    .whereNull("pl.exit_at")
    .groupBy("t.id", "t.symbol")
    .select("t.id as tickerId", "t.symbol", db.raw("sum(pl.quantity) as shares"), db.raw("sum(pl.quantity * pl.entry_price) as cost"));
  return rows.map((row) => ({ tickerId: row.tickerId, symbol: row.symbol, shares: Number(row.shares), averageCost: Number(row.shares) > 0 ? Number(row.cost) / Number(row.shares) : 0 }));
}

/** Records (and so freezes) every split the holdings show; returns how many it recorded. */
async function recordSplitsSeenInHoldings(held: IbkrHeldPosition[], passId: number): Promise<number> {
  const ibkrStockBySymbol = new Map(held.filter((p) => p.contract.secType === SecType.STK && p.quantity > 0).map((p) => [p.contract.symbol ?? "", { shares: p.quantity, averageCost: p.avgCost }]));
  let recorded = 0;
  for (const holding of await loadOpenStockHoldings()) {
    const ibkr = ibkrStockBySymbol.get(holding.symbol);
    if (!ibkr) continue;
    const ratio = splitSeenInHoldings(holding, ibkr);
    if (ratio === null) continue;
    console.log(`Reconciliation #${passId}: ${holding.symbol} holdings show a ${describeSplitRatio(ratio)} (ours ${holding.shares} @ ${holding.averageCost.toFixed(4)}, IBKR ${ibkr.shares} @ ${ibkr.averageCost.toFixed(4)}): recording it and freezing the ticker.`);
    await recordStockSplit({ tickerId: holding.tickerId, ratio, effectiveDateIso: easternIsoDate() });
    recorded += 1;
  }
  return recorded;
}

function heldPositionSnapshot(position: IbkrHeldPosition) {
  const contract = position.contract;
  return {
    conId: contract.conId ?? null,
    secType: contract.secType ?? null,
    symbol: contract.symbol ?? null,
    right: contract.right ?? null,
    strike: contract.strike ?? null,
    expiry: contract.lastTradeDateOrContractMonth ?? null,
    multiplier: contract.multiplier ?? null,
    localSymbol: contract.localSymbol ?? null,
    tradingClass: contract.tradingClass ?? null,
    quantity: position.quantity,
    avgCost: position.avgCost,
  };
}

async function keepHoldingsOnPendingSplit(ticker: FrozenTicker, held: IbkrHeldPosition[]): Promise<{ id: string; ratio: number; effectiveDateIso: string } | null> {
  const split: { id: string; ratio: string; effectiveDateIso: string } | undefined = await db("stock_splits")
    .where({ ticker_id: ticker.tickerId })
    .whereNull("records_rewritten_at")
    .orderBy("effective_date", "desc")
    .first("id", "ratio", db.raw('effective_date::text as "effectiveDateIso"'));
  if (!split) return null;
  const holdings = held.filter((position) => position.contract.symbol === ticker.symbol).map(heldPositionSnapshot);
  await db("stock_splits").where({ id: split.id }).update({ ibkr_holdings: JSON.stringify(holdings), ibkr_holdings_at: db.fn.now() });
  return { id: split.id, ratio: Number(split.ratio), effectiveDateIso: split.effectiveDateIso };
}

async function sendFrozenTickerAlert(ticker: FrozenTicker, split: { id: string; ratio: number; effectiveDateIso: string } | null, send: (message: string) => Promise<boolean>): Promise<void> {
  const todayIso = easternIsoDate();
  const legs: { optionType: "call" | "put"; strike: string; expiryDateIso: string; contracts: number }[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where("p.ticker_id", ticker.tickerId)
    .where("pl.leg_type", "option")
    .whereNull("pl.exit_at")
    .whereRaw("pl.expiry_date <= ?::date + ?::int", [todayIso, expiringSoonDays])
    .orderBy("pl.expiry_date")
    .select("pl.option_type as optionType", "pl.strike_price as strike", db.raw('pl.expiry_date::text as "expiryDateIso"'), "pl.quantity as contracts");
  const message = describeFrozenTickerAlert({
    environment: readAppEnvironment(),
    symbol: ticker.symbol,
    reason: ticker.reason,
    split: split ? { id: split.id, description: describeSplitRatio(split.ratio), effectiveDateIso: split.effectiveDateIso } : null,
    expiringSoon: legs.map((leg) => ({ ...leg, strike: Number(leg.strike), daysToExpiry: daysToExpiry(leg.expiryDateIso, todayIso) })),
  });
  await notifyDownThrottled(frozenTickerAlertKey(ticker.tickerId), message, frozenTickerReminderIntervalMs, { send, reminderText: (text) => text });
}

/**
 * Before the sync: records any split the holdings show, then takes every frozen ticker out of the sync (its holdings kept on
 * its pending split, its alert sent). Returns the holdings to sync and the frozen tickers whose open legs the sync must not close.
 */
export async function setAsideFrozenTickers(held: IbkrHeldPosition[], passId: number, send: (message: string) => Promise<boolean>): Promise<{ held: IbkrHeldPosition[]; frozenTickerIds: string[] }> {
  await recordSplitsSeenInHoldings(held, passId);
  const frozen = await loadFrozenTickers();
  if (frozen.length === 0) return { held, frozenTickerIds: [] };
  for (const ticker of frozen) {
    try {
      const split = await keepHoldingsOnPendingSplit(ticker, held);
      await sendFrozenTickerAlert(ticker, split, send);
    } catch (error) {
      console.error(`Reconciliation #${passId}: frozen ticker ${ticker.symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const frozenSymbols = new Set(frozen.map((ticker) => ticker.symbol));
  console.log(`Reconciliation #${passId}: frozen, left out of the sync: ${[...frozenSymbols].join(", ")}.`);
  return { held: held.filter((position) => !frozenSymbols.has(position.contract.symbol ?? "")), frozenTickerIds: frozen.map((ticker) => ticker.tickerId) };
}
