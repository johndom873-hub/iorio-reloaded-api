import type { Knex } from "knex";

/**
 * daily_pnl is now net-liq-delta based (net_liq[today] - net_liq[yesterday]
 * - net_cash_flow[today]) rather than IBKR's reqPnL, which proved
 * unreliable (see fetchAccountLedgerPnl.ts). net_cash_flow is sourced from
 * the Flex Query "Cash Transactions" report and nulls out deposits/
 * withdrawals so they don't get counted as trading P&L — see
 * fetchFlexCashTransactions.ts and run-daily-pnl-snapshot-job.ts's
 * reconcileCashFlows for why this column exists and gets retroactively
 * updated on recent rows (Flex data lags up to ~12h/a day behind).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("account_pnl_snapshots", (table) => {
    table.decimal("net_cash_flow", 14, 4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("account_pnl_snapshots", (table) => {
    table.dropColumn("net_cash_flow");
  });
}
