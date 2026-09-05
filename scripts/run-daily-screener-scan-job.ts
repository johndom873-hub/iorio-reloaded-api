// Scheduled job (see PROGRESS.md's "Screener discovery tool" decision,
// 2026-09-05): runs IBKR's market scanner (reqScannerSubscription) across
// three scan codes to find covered-call/CSP candidates, enriches each with
// price/liquidity/IV data, and upserts the result into
// screener_scan_results — the Screener tab reads this cached table, no
// live IBKR call on page load. Deliberately independent of `tickers`/
// `shortlist_entries`: most candidates are never added to the shortlist,
// and creating `tickers` rows for all of them would expand the "we
// actually monitor this" universe relied on by run-daily-market-data-job.ts
// and runTradeAlertGeneration.ts. Runs once nightly, offset ~30min after
// job:daily-market-data to avoid two jobs holding concurrent IBKR Gateway
// connections back-to-back.
//
// Usage (dev):
//   npm run job:daily-screener-scan
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-screener-scan-job.js

import { ScanCode } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { runScannerSubscription, type ScannerCandidate } from "../src/ibkr/fetchScannerCandidates.js";
import { enrichCandidate } from "../src/ibkr/enrichScannerCandidates.js";
import { isWeekend } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";

const scanCodes = [ScanCode.HIGH_OPT_IMP_VOLAT_OVER_HIST, ScanCode.HOT_BY_OPT_VOLUME, ScanCode.HIGH_OPT_IMP_VOLAT];
const rowsPerScan = 50;
const marketCapAboveUsd = 1_000_000_000;

let nextReqId = 1;

interface PooledCandidate {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  conId: number | null;
  scanCodes: Set<ScanCode>;
  bestRank: number;
  ivVsHistRatio: number | null;
}

function poolCandidates(scanResults: ScannerCandidate[][]): PooledCandidate[] {
  const bySymbol = new Map<string, PooledCandidate>();

  for (const candidates of scanResults) {
    for (const candidate of candidates) {
      const existing = bySymbol.get(candidate.symbol);
      if (!existing) {
        bySymbol.set(candidate.symbol, {
          symbol: candidate.symbol,
          companyName: candidate.companyName,
          sector: candidate.sector,
          conId: candidate.conId,
          scanCodes: new Set([candidate.scanCode]),
          bestRank: candidate.rank,
          ivVsHistRatio: candidate.ivVsHistRatio,
        });
        continue;
      }
      existing.scanCodes.add(candidate.scanCode);
      existing.bestRank = Math.min(existing.bestRank, candidate.rank);
      existing.ivVsHistRatio = existing.ivVsHistRatio ?? candidate.ivVsHistRatio;
    }
  }

  return [...bySymbol.values()];
}

async function main(): Promise<void> {
  if (isWeekend()) {
    console.log("Skipping daily_screener_scan — weekend, US market closed.");
    return;
  }

  await runJob("daily_screener_scan", async () => {
    console.log("Connecting to IBKR Gateway for the screener scan...");
    const connection = await connectToIbkrGateway();

    const scanResults: ScannerCandidate[][] = [];
    let enriched = 0;
    let failed = 0;
    const scanCounts: Record<string, number> = {};

    try {
      // Sequential, not Promise.all — three concurrent scanner subscriptions
      // plus later concurrent enrichment would stack IBKR-side load; this
      // matches the sequential-per-ticker precedent in
      // run-daily-market-data-job.ts.
      for (const scanCode of scanCodes) {
        const candidates = await runScannerSubscription(connection, scanCode, nextReqId++, {
          numberOfRows: rowsPerScan,
          marketCapAboveUsd,
        });
        scanCounts[ScanCode[scanCode] ?? String(scanCode)] = candidates.length;
        scanResults.push(candidates);
      }

      const pooled = poolCandidates(scanResults);
      console.log(`Pooled ${pooled.length} unique candidate(s) across ${scanCodes.length} scan(s).`);

      const today = new Date().toISOString().slice(0, 10);
      const rows: Record<string, unknown>[] = [];

      for (const candidate of pooled) {
        try {
          const enrichment = await enrichCandidate(connection, nextReqId++, candidate.symbol);
          const existing = await db("screener_scan_results").where({ symbol: candidate.symbol }).first();

          rows.push({
            symbol: candidate.symbol,
            company_name: candidate.companyName,
            sector: candidate.sector,
            ibkr_contract_id: candidate.conId,
            scan_codes: [...candidate.scanCodes].map((code) => ScanCode[code] ?? String(code)),
            best_rank: candidate.bestRank,
            last_price: enrichment.lastPrice,
            avg_share_volume: enrichment.avgShareVolume,
            avg_option_volume: enrichment.avgOptionVolume,
            call_open_interest: enrichment.callOpenInterest,
            put_open_interest: enrichment.putOpenInterest,
            bid_ask_spread_pct: enrichment.bidAskSpreadPct,
            iv_vs_hist_ratio: candidate.ivVsHistRatio,
            implied_volatility: enrichment.impliedVolatility,
            scan_date: today,
            first_seen_date: existing?.first_seen_date ?? today,
            captured_at: db.fn.now(),
          });
          enriched++;
        } catch (error) {
          failed++;
          console.warn(`${candidate.symbol}: enrichment failed — ${error instanceof Error ? error.message : error}`);
        }
      }

      // Anything not refreshed by this run has dropped out of every scan —
      // purge before upserting so the table stays an honest "today's
      // candidates" list rather than accumulating stale rows forever.
      await db("screener_scan_results").where("scan_date", "<", today).del();

      if (rows.length > 0) {
        await db("screener_scan_results")
          .insert(rows)
          .onConflict(["symbol"])
          .merge();
      }

      console.log(`Screener scan complete: ${enriched} enriched, ${failed} failed, ${rows.length} row(s) upserted.`);
      return {
        details: { scanCounts, pooled: pooled.length, enriched, failed },
        notify: failed > pooled.length / 2 ? `⚠️ Screener scan: ${failed}/${pooled.length} candidate(s) failed enrichment.` : undefined,
      };
    } finally {
      connection.disconnect();
    }
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
