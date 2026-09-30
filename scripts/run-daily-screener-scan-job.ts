// Scheduled job (redesigned 2026-09-25, see PROGRESS.md "Screener revamp"):
// builds/maintains screener_universe, an ACCUMULATING candidate list —
// unlike the table this replaces (screener_scan_results, purged daily),
// a symbol is never removed just because it didn't match tonight's scans.
// Every symbol already in the table gets re-enriched every night regardless
// of whether it matched, so the data never goes stale for a ticker that's
// stopped qualifying; best_rank/matched_scan_codes reflect ONLY tonight's
// outcome (999/'{}' sentinel when unmatched, sorts to the bottom).
//
// Query phase: 6 scan codes spanning both "rich" (high/changing IV) and
// "liquid" (option volume/open interest) signals, all with a $10B market
// cap floor (research-backed choice, 2026-09-25 — $1B was found to admit
// thin/speculative names with poor option liquidity despite clearing the
// old floor). HIGH_OPT_VOLUME_PUT_CALL_RATIO deliberately excluded — it's a
// skew/sentiment signal, not a richness or liquidity one.
//
// Usage (dev):
//   npm run job:daily-screener-scan
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-screener-scan-job.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { ScanCode, Stock } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { runScannerSubscription, type ScannerCandidate } from "../src/ibkr/fetchScannerCandidates.js";
import { enrichCandidate } from "../src/ibkr/enrichScannerCandidates.js";
import { lookupContractDetails } from "../src/ibkr/fetchNewTickerData.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { buildScreenerFailureMessage, isEmptyEnrichment } from "../src/lib/screenerScanOutcome.js";
import { runJob } from "../src/lib/runJob.js";

const scanCodes = [
  ScanCode.HIGH_OPT_IMP_VOLAT,
  ScanCode.HIGH_OPT_IMP_VOLAT_OVER_HIST,
  ScanCode.TOP_OPT_IMP_VOLAT_GAIN,
  ScanCode.HOT_BY_OPT_VOLUME,
  ScanCode.OPT_VOLUME_MOST_ACTIVE,
  ScanCode.OPT_OPEN_INTEREST_MOST_ACTIVE,
];
const rowsPerScan = 50;
const marketCapAboveUsd = 10_000_000_000;
const unmatchedRankSentinel = 999;

let nextReqId = 1;

interface PooledMatch {
  symbol: string;
  conId: number | null;
  scanCodes: Set<string>;
  bestRank: number;
}

function poolMatches(scanResults: ScannerCandidate[][]): Map<string, PooledMatch> {
  const bySymbol = new Map<string, PooledMatch>();
  for (const candidates of scanResults) {
    for (const candidate of candidates) {
      const existing = bySymbol.get(candidate.symbol);
      const scanCodeName = ScanCode[candidate.scanCode] ?? String(candidate.scanCode);
      if (!existing) {
        bySymbol.set(candidate.symbol, { symbol: candidate.symbol, conId: candidate.conId, scanCodes: new Set([scanCodeName]), bestRank: candidate.rank });
        continue;
      }
      existing.scanCodes.add(scanCodeName);
      existing.bestRank = Math.min(existing.bestRank, candidate.rank);
      existing.conId ??= candidate.conId;
    }
  }
  return bySymbol;
}

interface ExistingUniverseRow {
  symbol: string;
  ibkrContractId: number | null;
  companyName: string | null;
  sector: string | null;
  primaryExchange: string | null;
}

interface EnrichedRow {
  symbol: string;
  ibkr_contract_id: number | null;
  company_name: string | null;
  sector: string | null;
  primary_exchange: string | null;
  last_price: number | null;
  avg_share_volume: number | null;
  avg_option_volume: number | null;
  call_open_interest: number | null;
  put_open_interest: number | null;
  bid_ask_spread_pct: number | null;
  implied_volatility: number | null;
}

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log("Skipping daily_screener_scan — market closed today.");
    return;
  }

  await runJob("daily_screener_scan", async () => {
    console.log("Connecting to IBKR Gateway for the screener scan...");
    const connection = await connectToIbkrGateway();

    const scanCounts: Record<string, number> = {};
    let enriched = 0;
    let failed = 0;
    const failedSymbols: string[] = [];

    try {
      // Sequential, not Promise.all — matches the existing precedent
      // (daily-market-data job, and this job's own prior version) that
      // concurrent IBKR requests on one connection cause pacing/contention
      // issues.
      const scanResults: ScannerCandidate[][] = [];
      for (const scanCode of scanCodes) {
        const candidates = await runScannerSubscription(connection, scanCode, nextReqId++, { numberOfRows: rowsPerScan, marketCapAboveUsd });
        scanCounts[ScanCode[scanCode] ?? String(scanCode)] = candidates.length;
        scanResults.push(candidates);
      }

      const matches = poolMatches(scanResults);
      console.log(`Pooled ${matches.size} unique candidate(s) across ${scanCodes.length} scan(s).`);

      const existingRows: { symbol: string; ibkr_contract_id: number | null; company_name: string | null; sector: string | null; primary_exchange: string | null }[] = await db(
        "screener_universe",
      ).select("symbol", "ibkr_contract_id", "company_name", "sector", "primary_exchange");
      const existingBySymbol = new Map<string, ExistingUniverseRow>(
        existingRows.map((row) => [row.symbol, { symbol: row.symbol, ibkrContractId: row.ibkr_contract_id, companyName: row.company_name, sector: row.sector, primaryExchange: row.primary_exchange }]),
      );

      // The full nightly re-enrichment set: tonight's matches (new or
      // already-known) UNION every symbol already accumulated, whether or
      // not it matched tonight — the "keep it, re-enrich anyway" decision.
      const fullSymbolSet = new Set<string>([...matches.keys(), ...existingBySymbol.keys()]);
      console.log(`Enriching ${fullSymbolSet.size} symbol(s) (${fullSymbolSet.size - matches.size} carried over from the existing universe, not matched tonight).`);

      const matchedRows: (EnrichedRow & { best_rank: number; matched_scan_codes: string[] })[] = [];
      const carriedOverRows: EnrichedRow[] = [];

      for (const symbol of fullSymbolSet) {
        try {
          const existing = existingBySymbol.get(symbol);
          const match = matches.get(symbol);

          // Identity (name/sector/exchange/conId) rarely changes — only
          // pay for a live reqContractDetails lookup for a symbol this
          // table has never seen before.
          let identity = { companyName: existing?.companyName ?? null, sector: existing?.sector ?? null, primaryExchange: existing?.primaryExchange ?? null, conId: existing?.ibkrContractId ?? match?.conId ?? null };
          if (!existing) {
            const detailsReqId = nextReqId++;
            const detailsPromise = lookupContractDetails(connection, detailsReqId);
            connection.ib.reqContractDetails(detailsReqId, new Stock(symbol, "SMART", "USD"));
            const details = await detailsPromise;
            identity = { companyName: details.companyName, sector: details.sector, primaryExchange: details.primaryExchange, conId: details.conId ?? identity.conId };
          }

          const quote = await enrichCandidate(connection, nextReqId++, symbol);
          // enrichCandidate resolves with every field null on a timeout: writing that would wipe the symbol's stored
          // data and stamp last_refreshed_at, so it counts as a failure and the stored row is left alone.
          if (isEmptyEnrichment(quote)) throw new Error("enrichment returned no data (timeout or IBKR error)");

          const enrichedRow: EnrichedRow = {
            symbol,
            ibkr_contract_id: identity.conId,
            company_name: identity.companyName,
            sector: identity.sector,
            primary_exchange: identity.primaryExchange,
            last_price: quote.lastPrice,
            avg_share_volume: quote.avgShareVolume,
            avg_option_volume: quote.avgOptionVolume,
            call_open_interest: quote.callOpenInterest,
            put_open_interest: quote.putOpenInterest,
            bid_ask_spread_pct: quote.bidAskSpreadPct,
            implied_volatility: quote.impliedVolatility,
          };

          if (match) {
            matchedRows.push({ ...enrichedRow, best_rank: match.bestRank, matched_scan_codes: [...match.scanCodes] });
          } else {
            carriedOverRows.push(enrichedRow);
          }
          enriched++;
        } catch (error) {
          failed++;
          failedSymbols.push(symbol);
          console.warn(`${symbol}: enrichment failed — ${error instanceof Error ? error.message : error}`);
        }
      }

      // Two batches: matched rows update best_rank/matched_scan_codes/last_matched_at;
      // carried-over (unmatched tonight) rows reset best_rank to the sentinel and
      // clear matched_scan_codes, but leave last_matched_at untouched (excluded from
      // the merge list) so it still reflects the last time this symbol actually matched.
      // first_seen_at is excluded from both merge lists — set once, by the column
      // default, only on a genuine first insert.
      if (matchedRows.length > 0) {
        await db("screener_universe")
          .insert(
            matchedRows.map((row) => ({
              ...row,
              matched_scan_codes: row.matched_scan_codes,
              last_matched_at: db.fn.now(),
              last_refreshed_at: db.fn.now(),
            })),
          )
          .onConflict("symbol")
          .merge([
            "ibkr_contract_id",
            "company_name",
            "sector",
            "primary_exchange",
            "last_price",
            "avg_share_volume",
            "avg_option_volume",
            "call_open_interest",
            "put_open_interest",
            "bid_ask_spread_pct",
            "implied_volatility",
            "best_rank",
            "matched_scan_codes",
            "last_matched_at",
            "last_refreshed_at",
          ]);
      }

      if (carriedOverRows.length > 0) {
        await db("screener_universe")
          .insert(
            carriedOverRows.map((row) => ({
              ...row,
              best_rank: unmatchedRankSentinel,
              matched_scan_codes: [],
              last_refreshed_at: db.fn.now(),
            })),
          )
          .onConflict("symbol")
          .merge([
            "ibkr_contract_id",
            "company_name",
            "sector",
            "primary_exchange",
            "last_price",
            "avg_share_volume",
            "avg_option_volume",
            "call_open_interest",
            "put_open_interest",
            "bid_ask_spread_pct",
            "implied_volatility",
            "best_rank",
            "matched_scan_codes",
            "last_refreshed_at",
          ]);
      }

      console.log(`Screener scan complete: ${enriched} enriched, ${failed} failed, ${matchedRows.length} matched, ${carriedOverRows.length} carried over.`);
      return {
        details: { scanCounts, matched: matches.size, universeSize: fullSymbolSet.size, enriched, failed, failedSymbols },
        failureMessage: buildScreenerFailureMessage({ scanCounts, failedSymbols, universeSize: fullSymbolSet.size }),
      };
    } finally {
      connection.disconnect();
    }
  });
}

runScript("run-daily-screener-scan-job", main, () => db.destroy());
