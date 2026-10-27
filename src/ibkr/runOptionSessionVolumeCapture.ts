import { EventName, MarketDataType, type IBApi } from "@stoqey/ib";
import { loadStoredOptionChain } from "./fetchOptionChain.js";
import { connectToIbkrGateway, type IbkrConnection } from "./connectIbkr.js";
import { openCaptureQuoteWindow, type CaptureQuoteWindow, type CapturedOptionQuote, type OptionContractRequest } from "./captureOptionQuoteBatch.js";
import { requestLivePrices } from "./fetchLivePrices.js";
import { releaseMarketDataLines, renewMarketDataLineReservation, reserveMarketDataLines } from "./marketDataLineBudget.js";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { loadOpenDaysBetween } from "../lib/marketSessionStatus.js";
import { getRiskFreeRateForJob } from "../lib/riskFreeRate.js";
import { addCalendarDays } from "../lib/calendarDays.js";
import { contractKey } from "../lib/optionContractKey.js";
import { loadLastSeenImpliedVolatilityByContract, saveOptionSessionVolumes, type OptionSessionVolumeRow } from "../lib/optionSessionVolumeStore.js";
import { loadPlutoSettings, type PlutoSettings } from "../pluto/settingsStore.js";
import { loadEnabledPlutoTickerSettings } from "../pluto/tickerSettingsStore.js";
import { ladderRequoteBand, selectLadderRequoteContracts, type LadderRequoteBand } from "../pluto/ladderRequoteBand.js";
import { ladderDteRangeContracts } from "../pluto/ladderBandPlan.js";

// The after-close option volume capture (Marcelo 2026-10-15): for every ticker Pluto is enabled on, whichever strategy is
// active, each contract's full-session volume (IBKR tick 8, read under FROZEN after the close: it holds the whole day
// then and resets overnight, measured 2026-10-14/15) and its IBKR implied volatility, stored as the previous session's
// volume for the next day's ladder (its 20% rule) and as each contract's last-seen IV.
//
// Which contracts: the ladder's universe for the next session (every listed strike, both rights, of the expiries in its
// days-to-expiry range counted from that session) narrowed to the first-look re-quoting band (ladderRequoteBand.ts) at
// today's last price, from each contract's last-seen IV: the Calls inside it, every Put below the price; a Call whose IV
// is unknown is always quoted. The first night
// knows no IV, so it quotes the whole universe (about 21,000 contracts, ~35 min for 20 tickers); later nights quote the
// band (~3,200, ~5 min), and learn the IVs of what they quote.

export const optionSessionVolumeCaptureJobName = "option_session_volume_capture";
const lineHolder = "optionSessionVolumeCapture";
const maximumConcurrency = 40;
const minimumConcurrency = 5;
const lineReservationTtlSeconds = 180;
const lineRenewIntervalMs = 60_000;
/** Per contract, from IBKR's first tick: volume and IV normally arrive within about a second after the close. */
const quoteTimeoutMs = 5_000;
const stockPriceTimeoutMs = 10_000;
/** A same-day expiry at the next session's first look (10:00 ET): six hours to the close. */
const firstLookYearsToClose = 6 / 8760;

/** Settled once the volume and IV are in, or IBKR answered with an error. */
export function isSessionVolumeQuoteSettled(quote: CapturedOptionQuote): boolean {
  return quote.errorCode !== null || (quote.volume !== null && quote.impliedVolatility !== null);
}

export interface SessionVolumePlan {
  universeCount: number;
  unknownIvCount: number;
  contracts: OptionContractRequest[];
}

/** Pure: the contracts to quote for one ticker. Expiries come as YYYYMMDD (the stored chain); each strike is asked for both rights. */
export function planSessionVolumeContracts(input: {
  expirations: readonly string[];
  strikesByExpiry: ReadonlyMap<string, readonly number[]>;
  nextSessionIso: string;
  settings: Pick<PlutoSettings, "ladderMinDte" | "ladderMaxDte">;
  band: LadderRequoteBand;
  /** Null when IBKR gave no price: every contract is quoted. */
  stockPrice: number | null;
  riskFreeRate: number;
  lastSeenImpliedVolatilityByContract: ReadonlyMap<string, number>;
}): SessionVolumePlan {
  // The universe here is the days-to-expiry range only: the volume floor is what this capture measures.
  const universe = ladderDteRangeContracts({ expirations: input.expirations, strikesByExpiry: input.strikesByExpiry, todayIso: input.nextSessionIso, settings: input.settings }).map((contract) => ({ ...contract, lastSeenImpliedVolatility: input.lastSeenImpliedVolatilityByContract.get(contractKey(contract)) ?? null }));
  const unknownIvCount = universe.filter((contract) => contract.lastSeenImpliedVolatility === null).length;
  const stockPrice = input.stockPrice;
  const selected =
    stockPrice === null || !(stockPrice > 0)
      ? universe
      : selectLadderRequoteContracts({ universe, band: input.band, stockPrice, todayIso: input.nextSessionIso, yearsToTodaysClose: firstLookYearsToClose, riskFreeRate: input.riskFreeRate, forwardFor: (_expiry, years) => stockPrice * Math.exp(input.riskFreeRate * years) }).toQuote;
  return { universeCount: universe.length, unknownIvCount, contracts: selected.map((contract) => ({ expiry: contract.expiry.replaceAll("-", ""), strike: contract.strike, right: contract.right })) };
}

export interface SessionVolumeTickerResult {
  symbol: string;
  universe: number;
  requested: number;
  unknownIv: number;
  withVolume: number;
  withImpliedVolatility: number;
  stockPrice: number | null;
  error: string | null;
}

export interface SessionVolumeCaptureResult {
  sessionDateIso: string;
  nextSessionIso: string;
  tickers: SessionVolumeTickerResult[];
  concurrency: number;
  elapsedSeconds: number;
}

export interface SessionVolumeCaptureDependencies {
  connect(): Promise<IbkrConnection>;
  openQuoteWindow(ib: IBApi, concurrency: number): CaptureQuoteWindow;
  fetchStockPrices(ib: IBApi, symbols: string[]): Promise<Record<string, number | null>>;
  reserveLines(wanted: number): Promise<number>;
  renewLines(): Promise<void>;
  releaseLines(): Promise<void>;
  save(rows: OptionSessionVolumeRow[]): Promise<void>;
  now(): Date;
}

let fallbackReqId = 70_000;

export const defaultSessionVolumeCaptureDependencies: SessionVolumeCaptureDependencies = {
  connect: connectToIbkrGateway,
  openQuoteWindow: (ib, concurrency) => openCaptureQuoteWindow(ib, { concurrency, timeoutMs: quoteTimeoutMs, isSettled: isSessionVolumeQuoteSettled }),
  fetchStockPrices: (ib, symbols) => requestLivePrices(ib, () => nextReqIdFor(ib, () => fallbackReqId++), symbols.map((symbol) => ({ key: symbol, legType: "stock" as const, symbol })), stockPriceTimeoutMs),
  // Not a priority holder: after the close nothing priority is running, and the screens' pool keeps its share.
  reserveLines: async (wanted) => {
    const first = await reserveMarketDataLines(lineHolder, wanted, lineReservationTtlSeconds);
    if (first.ok) return wanted;
    const fitting = Math.min(wanted, first.availableLines);
    if (fitting < minimumConcurrency) return 0;
    const second = await reserveMarketDataLines(lineHolder, fitting, lineReservationTtlSeconds);
    return second.ok ? fitting : 0;
  },
  renewLines: () => renewMarketDataLineReservation(lineHolder, lineReservationTtlSeconds),
  releaseLines: () => releaseMarketDataLines(lineHolder),
  save: (rows) => saveOptionSessionVolumes(rows),
  now: () => new Date(),
};

/** The whole capture: plans every enabled ticker, quotes them on one FROZEN connection, stores every requested contract's row. */
export async function runOptionSessionVolumeCapture(dependencies: SessionVolumeCaptureDependencies = defaultSessionVolumeCaptureDependencies): Promise<SessionVolumeCaptureResult> {
  const startedAtMs = dependencies.now().getTime();
  const sessionDateIso = easternIsoDate(dependencies.now());
  const [nextSessionIso] = await loadOpenDaysBetween(addCalendarDays(sessionDateIso, 1), addCalendarDays(sessionDateIso, 14));
  if (!nextSessionIso) throw new Error(`no open session in the market calendar within 14 days after ${sessionDateIso}`);
  const [settings, enabledTickers, riskFreeRate] = await Promise.all([loadPlutoSettings(), loadEnabledPlutoTickerSettings(), getRiskFreeRateForJob()]);
  if (riskFreeRate === null) throw new Error("no risk-free rate available (FRED)");
  const results: SessionVolumeTickerResult[] = [];
  if (enabledTickers.length === 0) return { sessionDateIso, nextSessionIso, tickers: results, concurrency: 0, elapsedSeconds: 0 };

  const concurrency = await dependencies.reserveLines(maximumConcurrency);
  if (concurrency === 0) throw new Error(`fewer than ${minimumConcurrency} IBKR market-data lines free`);
  const renewTimer = setInterval(() => void dependencies.renewLines().catch(() => {}), lineRenewIntervalMs);
  renewTimer.unref?.();
  let connection: IbkrConnection | null = null;
  let window: CaptureQuoteWindow | null = null;
  let disconnected = false;
  const onDisconnected = () => {
    disconnected = true;
    window?.close();
  };
  try {
    connection = await dependencies.connect();
    const { ib } = connection;
    ib.reqMarketDataType(MarketDataType.FROZEN);
    ib.once(EventName.disconnected, onDisconnected);
    const stockPriceBySymbol = await dependencies.fetchStockPrices(ib, enabledTickers.map((ticker) => ticker.symbol));
    window = dependencies.openQuoteWindow(ib, concurrency);
    const quoteWindow = window;
    await Promise.all(
      enabledTickers.map(async (ticker) => {
        const stockPrice = stockPriceBySymbol[ticker.symbol] ?? null;
        const result: SessionVolumeTickerResult = { symbol: ticker.symbol, universe: 0, requested: 0, unknownIv: 0, withVolume: 0, withImpliedVolatility: 0, stockPrice, error: null };
        results.push(result);
        try {
          const chain = await loadStoredOptionChain(ticker.tickerId);
          if (!chain || chain.expirations.length === 0) throw new Error("no stored option chain");
          const lastSeen = await loadLastSeenImpliedVolatilityByContract(ticker.tickerId, nextSessionIso);
          const band = ladderRequoteBand({ ladderMinAbsDelta: ticker.ladderMinAbsDelta ?? settings.ladderMinAbsDelta, ladderMaxAbsDelta: ticker.ladderMaxAbsDelta ?? settings.ladderMaxAbsDelta }, true);
          const plan = planSessionVolumeContracts({ expirations: chain.expirations, strikesByExpiry: chain.strikesByExpiry, nextSessionIso, settings, band, stockPrice, riskFreeRate, lastSeenImpliedVolatilityByContract: lastSeen });
          Object.assign(result, { universe: plan.universeCount, requested: plan.contracts.length, unknownIv: plan.unknownIvCount });
          if (plan.contracts.length === 0) return;
          const quotes = await quoteWindow.capture(ticker.symbol, plan.contracts);
          if (disconnected) throw new Error("the IBKR connection dropped during the capture");
          const rows: OptionSessionVolumeRow[] = quotes.map((quote) => ({
            tickerId: ticker.tickerId,
            sessionDateIso,
            expiry: `${quote.expiry.slice(0, 4)}-${quote.expiry.slice(4, 6)}-${quote.expiry.slice(6, 8)}`,
            strike: quote.strike,
            right: quote.right,
            volume: quote.volume,
            bid: quote.bid !== null && quote.bid > 0 ? quote.bid : null,
            ask: quote.ask !== null && quote.ask > 0 ? quote.ask : null,
            impliedVolatility: quote.impliedVolatility !== null && quote.impliedVolatility > 0 ? quote.impliedVolatility : null,
            stockPrice,
          }));
          await dependencies.save(rows);
          result.withVolume = rows.filter((row) => row.volume !== null).length;
          result.withImpliedVolatility = rows.filter((row) => row.impliedVolatility !== null).length;
          console.log(`${ticker.symbol}: ${result.requested} of ${result.universe} contracts quoted (${result.unknownIv} without a known IV), ${result.withVolume} with volume, ${result.withImpliedVolatility} with IV.`);
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          console.warn(`${ticker.symbol}: volume capture failed — ${result.error}`);
        }
      }),
    );
  } finally {
    clearInterval(renewTimer);
    connection?.ib.removeListener(EventName.disconnected, onDisconnected);
    window?.close();
    connection?.disconnect();
    await dependencies.releaseLines().catch(() => {});
  }
  results.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { sessionDateIso, nextSessionIso, tickers: results, concurrency, elapsedSeconds: Math.round((dependencies.now().getTime() - startedAtMs) / 1000) };
}

/** The job's outcome: a failure when no ticker was captured, completed with errors when some were not. */
export function describeSessionVolumeCaptureOutcome(result: SessionVolumeCaptureResult): { failureMessage?: string; completedWithErrors?: { errorCount: number; message: string } } {
  const failed = result.tickers.filter((ticker) => ticker.error !== null);
  if (result.tickers.length === 0) return {};
  if (failed.length === result.tickers.length) return { failureMessage: `no ticker's option volume was captured: ${failed.map((ticker) => `${ticker.symbol} (${ticker.error})`).join(", ")}` };
  if (failed.length > 0) return { completedWithErrors: { errorCount: failed.length, message: `no option volume for ${failed.map((ticker) => `${ticker.symbol} (${ticker.error})`).join(", ")}: the ladder sells nothing on them tomorrow` } };
  return {};
}

