// Scheduled job #2 (see PROGRESS.md's Scheduled jobs plan): one row/day of
// account-level P&L (account_pnl_snapshots, via reqAccountSummary +
// reqAccountUpdates — see fetchAccountLedgerPnl.ts for why not reqPnL)
// and one row/day per open position (position_pnl_snapshots). Runs right
// after job #1.
//
// daily_pnl = net_liq[today] - net_liq[yesterday] - net_cash_flow[today]
// (approved 2026-08-20, replacing the old reqPnL-based figure — see
// fetchAccountLedgerPnl.ts for why reqPnL was abandoned). net_cash_flow
// comes from IBKR's Flex Query "Cash Transactions" report via
// reconcileCashFlows() below, which nets out deposits/withdrawals so a
// paper-account cash top-up doesn't get counted as trading P&L. Flex data
// lags up to ~12h behind (IBKR's own docs), so today's net_cash_flow is
// usually 0 the first night — reconcileCashFlows re-checks the last 10
// days on every run and retroactively corrects daily_pnl for any day
// whose cash-flow figure changes once real data arrives.
//
// Per-position unrealized P&L/market value are computed here, not sourced
// from IBKR's reqPnLSingle — that call needs a resolved conId per leg,
// which manually-entered legs don't have (see positions.ts's
// ibkr_contract_id, always null for these). Formula approved 2026-08-20,
// same sign convention as the Trade Blotter's realized-P&L formula:
//   unrealizedPnl = (currentPrice - entryPrice) * qty * multiplier * (short ? -1 : 1)
//   marketValue = sum of (currentPrice * qty * multiplier), signed the same way
// realized_pnl is always 0 here — position_legs only supports closing every
// leg of a position at once (no partial closes), so nothing is "realized"
// while a position is still open; once fully closed it drops out of this
// job's scope (no longer open) and its realized figure lives in the Trade
// Blotter instead.
//
// Usage (dev):
//   npm run job:daily-pnl-snapshot
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-pnl-snapshot-job.js

import { OptionType } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { fetchAccountLedgerPnl } from "../src/ibkr/fetchAccountLedgerPnl.js";
import { fetchAccountSummary } from "../src/ibkr/fetchAccountSummary.js";
import { fetchFlexCashTransactions } from "../src/ibkr/fetchFlexCashTransactions.js";
import { fetchLivePrices, type PriceContract } from "../src/ibkr/fetchLivePrices.js";
import { runJob } from "../src/lib/runJob.js";

interface OpenPositionLegRow {
  positionId: string;
  legId: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  multiplier: number;
  entryPrice: string;
  symbol: string;
}

interface RecentAccountSnapshotRow {
  snapshotDate: string;
  netLiquidationValue: string | null;
  netCashFlow: string | null;
}

/**
 * Re-checks the last 10 days of Flex "Cash Transactions" data and
 * retroactively fixes daily_pnl for any day whose net cash flow changed
 * since it was last computed — see this file's header comment for why.
 * Runs after today's row already has net_liquidation_value written, since
 * that's needed to compute today's own delta too.
 */
async function reconcileCashFlows(snapshotDate: string): Promise<void> {
  const cashFlowByDate = await fetchFlexCashTransactions();

  const recentRows: RecentAccountSnapshotRow[] = await db.raw(
    `
    SELECT
      to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate",
      net_liquidation_value AS "netLiquidationValue",
      net_cash_flow AS "netCashFlow"
    FROM account_pnl_snapshots
    WHERE snapshot_date >= (?::date - interval '10 days')
    ORDER BY snapshot_date ASC
    `,
    [snapshotDate],
  ).then((result) => result.rows);

  for (let i = 1; i < recentRows.length; i++) {
    const row = recentRows[i];
    const previousRow = recentRows[i - 1];
    if (!row || !previousRow) continue;
    const newCashFlow = cashFlowByDate.get(row.snapshotDate) ?? 0;
    const storedCashFlow = row.netCashFlow === null ? null : Number(row.netCashFlow);
    if (storedCashFlow === newCashFlow) continue;
    if (row.netLiquidationValue === null || previousRow.netLiquidationValue === null) continue;

    const dailyPnl = Number(row.netLiquidationValue) - Number(previousRow.netLiquidationValue) - newCashFlow;
    await db("account_pnl_snapshots")
      .where({ snapshot_date: row.snapshotDate })
      .update({ net_cash_flow: newCashFlow, daily_pnl: dailyPnl });
    console.log(`Reconciled cash flow for ${row.snapshotDate}: net_cash_flow=${newCashFlow} daily_pnl=${dailyPnl}`);
  }
}

async function main(): Promise<void> {
  await runJob("daily_pnl_snapshot", async () => {
    const snapshotDate = new Date().toISOString().slice(0, 10);

    // Account-level PnL/net-liq is intentionally decoupled from the
    // per-position snapshots below: even though reqAccountSummary and
    // reqAccountUpdates have both proven reliable in testing, a failure
    // here (network blip, Gateway restart mid-job) must never cost us the
    // day's per-position data, which comes from the separate
    // fetchLivePrices/reqMktData path.
    let accountSnapshotWritten = false;
    let accountSnapshotError: string | undefined;
    try {
      const [accountSummary, ledgerPnl] = await Promise.all([fetchAccountSummary(), fetchAccountLedgerPnl()]);

      // Best-effort daily_pnl assuming zero cash flow today — right most
      // nights, since deposits/withdrawals are rare. reconcileCashFlows
      // below corrects this (and past days) once real Flex data confirms
      // otherwise; see this file's header comment.
      const previousRow: { netLiquidationValue: string | null } | undefined = await db.raw(
        `SELECT net_liquidation_value AS "netLiquidationValue" FROM account_pnl_snapshots WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1`,
        [snapshotDate],
      ).then((result) => result.rows[0]);
      const dailyPnl =
        previousRow?.netLiquidationValue != null && accountSummary.netLiquidationValue != null
          ? accountSummary.netLiquidationValue - Number(previousRow.netLiquidationValue)
          : null;

      await db("account_pnl_snapshots")
        .insert({
          snapshot_date: snapshotDate,
          daily_pnl: dailyPnl,
          net_cash_flow: 0,
          realized_pnl: ledgerPnl.realizedPnl,
          unrealized_pnl: ledgerPnl.unrealizedPnl,
          net_liquidation_value: accountSummary.netLiquidationValue,
        })
        .onConflict(["snapshot_date"])
        .merge();
      accountSnapshotWritten = true;
      console.log(
        `Account PnL: realized=${ledgerPnl.realizedPnl} unrealized=${ledgerPnl.unrealizedPnl} netLiq=${accountSummary.netLiquidationValue}`,
      );
    } catch (error) {
      accountSnapshotError = error instanceof Error ? error.message : String(error);
      console.error(`Account-level PnL snapshot failed, skipping it for ${snapshotDate}: ${accountSnapshotError}`);
    }

    // Independent of the write above succeeding — even a day the Gateway
    // fetch fails, we still want to catch up on any newly-arrived Flex
    // cash-flow data for recent days. Its own failure (Flex API down,
    // report still generating) must not fail the whole job either.
    try {
      await reconcileCashFlows(snapshotDate);
    } catch (error) {
      console.error(`Cash-flow reconciliation failed: ${error instanceof Error ? error.message : error}`);
    }

    const legRows: OpenPositionLegRow[] = await db.raw(
      `
      SELECT
        p.id AS "positionId",
        pl.id AS "legId",
        pl.leg_type AS "legType",
        pl.side,
        pl.quantity,
        pl.option_type AS "optionType",
        pl.strike_price AS "strikePrice",
        to_char(pl.expiry_date, 'YYYYMMDD') AS "expiryDate",
        pl.multiplier,
        pl.entry_price AS "entryPrice",
        t.symbol
      FROM positions p
      JOIN position_legs pl ON pl.position_id = p.id
      JOIN tickers t ON t.id = p.ticker_id
      WHERE p.status = 'open'
      `,
    ).then((result) => result.rows);

    if (legRows.length === 0) {
      console.log("No open positions — nothing to snapshot at the position level.");
      return {
        details: { accountSnapshot: accountSnapshotWritten, accountSnapshotError, openPositionCount: 0 },
        notify: accountSnapshotWritten
          ? undefined
          : `⚠️ daily_pnl_snapshot: account-level PnL failed for ${snapshotDate} (${accountSnapshotError}). No open positions, so nothing else to snapshot today.`,
      };
    }

    const priceContracts: PriceContract[] = legRows.map((leg) => ({
      key: leg.legId,
      legType: leg.legType,
      symbol: leg.symbol,
      expiry: leg.expiryDate ?? undefined,
      strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
      right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
    }));
    const pricesByLegId = await fetchLivePrices(priceContracts);

    const legsByPositionId = new Map<string, OpenPositionLegRow[]>();
    for (const leg of legRows) {
      const existing = legsByPositionId.get(leg.positionId) ?? [];
      existing.push(leg);
      legsByPositionId.set(leg.positionId, existing);
    }

    let snapshotted = 0;
    let skipped = 0;
    for (const [positionId, legs] of legsByPositionId) {
      let unrealizedPnl = 0;
      let marketValue = 0;
      let hasAllPrices = true;

      for (const leg of legs) {
        const currentPrice = pricesByLegId[leg.legId];
        if (currentPrice === null || currentPrice === undefined) {
          hasAllPrices = false;
          break;
        }
        const sign = leg.side === "short" ? -1 : 1;
        const entryPrice = Number(leg.entryPrice);
        unrealizedPnl += (currentPrice - entryPrice) * leg.quantity * leg.multiplier * sign;
        marketValue += currentPrice * leg.quantity * leg.multiplier * sign;
      }

      if (!hasAllPrices) {
        console.warn(`Skipping position ${positionId} — missing live price for at least one leg.`);
        skipped++;
        continue;
      }

      await db("position_pnl_snapshots")
        .insert({
          position_id: positionId,
          snapshot_date: snapshotDate,
          realized_pnl: 0,
          unrealized_pnl: unrealizedPnl,
          market_value: marketValue,
        })
        .onConflict(["position_id", "snapshot_date"])
        .merge();
      snapshotted++;
    }

    console.log(`Snapshotted ${snapshotted}/${legsByPositionId.size} open position(s) for ${snapshotDate} (${skipped} skipped).`);
    return {
      details: {
        accountSnapshot: accountSnapshotWritten,
        accountSnapshotError,
        openPositionCount: legsByPositionId.size,
        snapshotted,
        skipped,
      },
      notify: accountSnapshotWritten
        ? undefined
        : `⚠️ daily_pnl_snapshot: account-level PnL failed for ${snapshotDate} (${accountSnapshotError}). Position-level snapshots (${snapshotted}/${legsByPositionId.size}) were still written.`,
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
