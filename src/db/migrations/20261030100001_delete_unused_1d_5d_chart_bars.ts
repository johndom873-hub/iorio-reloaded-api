import type { Knex } from "knex";

// The chart's 1D and 5D ranges now include extended hours and are fetched live, never stored (extendedHoursChartBars.ts),
// so their regular-hours 1 min and 5 min rows in intraday_price_bars are no longer read by anything.
export async function up(knex: Knex): Promise<void> {
  await knex("intraday_price_bars").whereIn("bar_size", ["1 min", "5 mins"]).del();
}

// The rows were a cache of IBKR data: nothing to restore.
export async function down(): Promise<void> {}
