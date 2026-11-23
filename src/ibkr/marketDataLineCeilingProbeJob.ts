import { db } from "../db/connection.js";
import { environment } from "../config/env.js";
import type { JobResult } from "../lib/runJob.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { loadMarketDataLineBudget } from "./marketDataLineBudget.js";
import { lineLimitHitAccountSummaryRequestId, loadLineReservationsForLineLimitHit, requestNetLiquidationInUsd } from "./marketDataLineLimitHits.js";
import { measuredMarketDataLineCeiling, millisecondsUntilProbeWindow, probeMarketDataLineCeiling } from "./probeMarketDataLineCeiling.js";

// The nightly line-ceiling probe's run (scripts/run-market-data-line-ceiling-probe-job.ts): waits for the gap between two
// health checks, skips while priority lines are held, probes, and stores the result in ibkr_market_data_line_ceiling_probes.
export const marketDataLineCeilingProbeJobName = "market_data_line_ceiling_probe";
const netLiquidationTimeoutMs = 10_000;
const jobName = marketDataLineCeilingProbeJobName;

export async function runMarketDataLineCeilingProbe(): Promise<JobResult> {
  const waitMs = millisecondsUntilProbeWindow(Date.now());
  if (waitMs > 0) {
    console.log(`Waiting ${Math.round(waitMs / 1000)} s for the gap between two health checks.`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const ledgerBefore = await loadLineReservationsForLineLimitHit();
  const priorityHolders = ledgerBefore.filter((reservation) => reservation.priority);
  if (priorityHolders.length > 0) {
    const skipped = `skipped: priority lines held by ${priorityHolders.map((reservation) => `${reservation.holder} (${reservation.lines})`).join(", ")}`;
    console.log(`${jobName} ${skipped}`);
    return { details: { skipped } };
  }

  // Its own refusals are the measurement, not a line shortage: the connection does not record them as one.
  const connection = await connectToIbkrGateway({ recordMarketDataLineLimitHits: false });
  try {
    const liveNetLiquidation = await requestNetLiquidationInUsd(connection.ib, lineLimitHitAccountSummaryRequestId, netLiquidationTimeoutMs);
    const probe = await probeMarketDataLineCeiling(connection.ib);
    const ledgerAfter = await loadLineReservationsForLineLimitHit();
    const budget = await loadMarketDataLineBudget();
    const ledgerLines = (ledger: typeof ledgerBefore) => ledger.reduce((sum, reservation) => sum + reservation.lines, 0);
    const measuredCeiling = measuredMarketDataLineCeiling(probe, ledgerBefore, ledgerAfter);

    await db("ibkr_market_data_line_ceiling_probes").insert({
      trading_mode: environment.ibkrTradingMode,
      lines_held_by_probe: probe.linesHeldByProbe,
      hit_the_limit: probe.hitTheLimit,
      ledger_lines_before: ledgerLines(ledgerBefore),
      ledger_lines_after: ledgerLines(ledgerAfter),
      ledger_reservations_before: JSON.stringify(ledgerBefore),
      ledger_reservations_after: JSON.stringify(ledgerAfter),
      measured_ceiling: measuredCeiling,
      live_net_liquidation: liveNetLiquidation,
      budget: budget.budget,
      estimated_ibkr_ceiling: budget.estimatedIbkrCeiling,
      other_failures: JSON.stringify(probe.otherFailures),
    });

    const summary =
      `probe held ${probe.linesHeldByProbe}${probe.hitTheLimit ? " before IBKR refused" : ` without reaching IBKR's limit (${probe.requested} symbols tried)`}, ` +
      `app ${ledgerLines(ledgerBefore)} before / ${ledgerLines(ledgerAfter)} after → measured ceiling ${measuredCeiling ?? "not measurable tonight"}; ` +
      `our estimate ${budget.estimatedIbkrCeiling} (budget ${budget.budget}), live net liquidation ${liveNetLiquidation ?? "unknown"}`;
    console.log(`${jobName}: ${summary}`);
    return { details: { ...probe, ledgerBefore, ledgerAfter, measuredCeiling, liveNetLiquidation, budget } };
  } finally {
    connection.disconnect();
  }
}
