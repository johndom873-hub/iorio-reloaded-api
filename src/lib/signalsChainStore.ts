import { OptionType } from "@stoqey/ib";
import { ibkrMarketDataLinesEnabled } from "../config/env.js";
import { db } from "../db/connection.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { streamPooledOptionQuotes } from "../ibkr/pooledOptionQuotes.js";
import { computeMarketSessionStatus } from "./marketSessionStatus.js";
import { formatIsoDateAsExpiry } from "./optionChainSnapshotStore.js";
import { assembleSignalsChain, scoreSignalContract, scoreTickerWithExclusions, type SignalContractLiveQuote, type SignalContractScore, type SignalsChain } from "./signalsChain.js";
import { contractKey, type ContractRef } from "./signalsLiveScoring.js";
import { loadAccountContext, loadSignalsUniverseTicker, loadTickerSignalsInputs, type SignalsTickerRow } from "./signalsStore.js";
import { loadTradingSettings } from "./tradingSettingsStore.js";
import type { SignalsPriceSource } from "./signalsTypes.js";

// DB/IBKR side of the Signals chain grid and the any-contract scorer (signalsChain.ts holds the pure logic).

/** Any known ticker, in or out of the Signals universe (a stock-only position off the shortlist still needs a covered call). */
export async function loadTickerBySymbol(symbol: string): Promise<SignalsTickerRow | null> {
  const row = await db("tickers")
    .where("symbol", symbol.toUpperCase())
    .select("id as tickerId", "symbol", "company_name as companyName", db.raw("NULLIF(sector, '') as sector"))
    .first();
  return row ?? null;
}

/** IBKR's own delta per contract from one capture, keyed by contractKey; optionally one expiry only. */
export async function loadCapturedDeltas(snapshotId: string, expiryIso: string | null): Promise<Map<string, number>> {
  const query = db("option_quote_snapshots").where({ snapshot_id: snapshotId }).whereNotNull("delta");
  if (expiryIso) query.where({ expiry: expiryIso });
  const rows: { expiry: string; strike: string; right: "C" | "P"; delta: string }[] = await query.select(db.raw("expiry::text as expiry"), "strike", db.raw('option_right as "right"'), "delta");
  return new Map(rows.map((row) => [contractKey({ expiry: row.expiry, strike: Number(row.strike), right: row.right }), Number(row.delta)]));
}

export type LiveSpot = { spotPrice: number; priceSource: SignalsPriceSource } | null;

/**
 * The chain grid for one expiry. Scored at the snapshot spot unless the modal passes its live spot. Free cash only feeds
 * candidate flags (insufficient_cash), which the grid does not show, so no IBKR account request is made here.
 */
export async function loadSignalsChain(ticker: SignalsTickerRow, requestedExpiry: string | null, liveSpot: LiveSpot): Promise<SignalsChain> {
  const [universeTicker, storedChain, inputs, settings] = await Promise.all([loadSignalsUniverseTicker(ticker.symbol), loadStoredOptionChain(ticker.tickerId), loadTickerSignalsInputs(ticker), loadTradingSettings()]);
  const capturedDeltaByContract = inputs.header ? await loadCapturedDeltas(inputs.header.snapshotId, null) : new Map<string, number>();
  const scoring = { inputs, ...scoreTickerWithExclusions(inputs, { freeCash: 0 }, settings, liveSpot ?? undefined) };
  return assembleSignalsChain({ symbol: ticker.symbol, inSignalsUniverse: universeTicker !== null, strikesByExpiry: storedChain.strikesByExpiry, todayEasternIso: inputs.todayEasternIso, requestedExpiry, scoring, capturedDeltaByContract });
}

/**
 * One pooled reading of one contract: subscribes through marketDataPool (budgeted, shared with any screen already
 * streaming it), waits for the first reading (at most the pool's settle grace), then unsubscribes, and the pool cancels
 * the line after its short unsubscribe grace. Skipped outright when this environment has lines disabled or the regular
 * session is not open (no option quotes to wait for).
 */
export async function fetchSignalContractLiveQuote(symbol: string, contract: ContractRef, now: Date = new Date()): Promise<SignalContractLiveQuote | null> {
  if (!ibkrMarketDataLinesEnabled()) return null;
  if ((await computeMarketSessionStatus(now)).state !== "open") return null;
  const release = new AbortController();
  try {
    const [quote] = await streamPooledOptionQuotes(
      [{ symbol, expiry: formatIsoDateAsExpiry(contract.expiry), strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }],
      () => {},
      release.signal,
    );
    if (!quote || (quote.bid === null && quote.ask === null && quote.delta === null)) return null;
    return { bid: quote.bid, ask: quote.ask, delta: quote.delta, quotedAt: new Date().toISOString() };
  } finally {
    release.abort();
  }
}

export async function loadSignalContractScore(ticker: SignalsTickerRow, contract: ContractRef, liveSpot: LiveSpot): Promise<SignalContractScore> {
  const [inputs, settings, account, liveQuote] = await Promise.all([loadTickerSignalsInputs(ticker), loadTradingSettings(), loadAccountContext(), fetchSignalContractLiveQuote(ticker.symbol, contract)]);
  const capturedDelta = inputs.header ? ((await loadCapturedDeltas(inputs.header.snapshotId, contract.expiry)).get(contractKey(contract)) ?? null) : null;
  return scoreSignalContract({ inputs, account, settings, contract, liveQuote, liveSpot, capturedDelta });
}
