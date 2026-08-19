// Scheduled job #2 (see PROGRESS.md's Scheduled jobs plan): one row/day of
// account-level P&L (account_pnl_snapshots, via IBKR's own reqPnL/reqAccountSummary)
// and one row/day per open position (position_pnl_snapshots). Runs right
// after job #1.
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
import { fetchAccountPnl } from "../src/ibkr/fetchAccountPnl.js";
import { fetchAccountSummary } from "../src/ibkr/fetchAccountSummary.js";
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

async function main(): Promise<void> {
  await runJob("daily_pnl_snapshot", async () => {
    const snapshotDate = new Date().toISOString().slice(0, 10);

    const [accountPnl, accountSummary] = await Promise.all([fetchAccountPnl(), fetchAccountSummary()]);
    await db("account_pnl_snapshots")
      .insert({
        snapshot_date: snapshotDate,
        daily_pnl: accountPnl.dailyPnl,
        realized_pnl: accountPnl.realizedPnl,
        unrealized_pnl: accountPnl.unrealizedPnl,
        net_liquidation_value: accountSummary.netLiquidationValue,
      })
      .onConflict(["snapshot_date"])
      .merge();
    console.log(
      `Account PnL: daily=${accountPnl.dailyPnl} realized=${accountPnl.realizedPnl} unrealized=${accountPnl.unrealizedPnl} netLiq=${accountSummary.netLiquidationValue}`,
    );

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
        details: { accountSnapshot: true, openPositionCount: 0 },
        notify: undefined,
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
      details: { accountSnapshot: true, openPositionCount: legsByPositionId.size, snapshotted, skipped },
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
