import { EventName, SecType, type IBApi } from "@stoqey/ib";
import { ibkrMaxTickersReachedCode } from "./constants.js";

// The nightly probe (scripts/run-market-data-line-ceiling-probe-job.ts, Marcelo 2026-11-23): subscribes to stock quotes 10
// at a time until IBKR refuses one as over the login's allocation (error 101), so the allocation that night is the lines
// the probe held plus the lines the app held. Market data only, no orders; every subscription is cancelled at the end.
// A symbol IBKR rejects (no security definition, a delisting) holds no line, so the probe moves on to the next one.
export const probeTickerSymbols = (
  "SPY QQQ IWM DIA TLT GLD SLV XLF XLE XLK XLV XLI XLY XLP XLU XLB XLRE SMH SOXX HYG LQD EEM EFA FXI KWEB GDX USO UNG " +
  "AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO JPM V UNH XOM MA JNJ PG HD COST ABBV MRK CVX KO PEP BAC WMT CRM ORCL NFLX AMD " +
  "ADBE TMO LIN ACN MCD CSCO ABT WFC DIS INTC QCOM TXN VZ INTU CMCSA PFE AMGN IBM NOW CAT GE UBER HON SPGI AMAT LOW PM BKNG " +
  "UNP RTX NEE T BA GS MS ISRG ELV DE LMT BLK SYK MDT PLD TJX VRTX ADP C SCHW CB PANW REGN BMY CI ADI MU LRCX KLAC SO MDLZ " +
  "ZTS DUK SHW CME EOG SLB ETN APH ICE CDNS SNPS USB PNC MO AON ITW WM MCK TGT GM F BX NKE SBUX PYPL ABNB SHOP COIN PLTR " +
  "SNOW DDOG CRWD ZS NET MDB ROKU DKNG RBLX HOOD SOFI AFRM UPST RIVN LCID NIO XPEV LI BABA JD PDD BIDU TSM ASML ARM SMCI " +
  "MRVL ON NXPI MCHP WDC STX NTAP HPQ DELL ANET FTNT TEAM WDAY ADSK PAYX FIS GPN KMB CL GIS KHC HSY MNST KDP STZ EL MAR " +
  "HLT CMG YUM DPZ ORLY AZO ROST DG DLTR BBY KR SYY ADM CTVA DOW DD LYB NEM FCX AA X CLF NUE STLD VLO MPC PSX OXY DVN HAL " +
  "BKR KMI WMB OKE ET EPD CVS HUM CNC MRNA BIIB ILMN DXCM IDXX EW BSX ZBH BAX BDX HCA AXP COF DFS SYF ALLY MET PRU AIG TRV " +
  "ALL PGR"
).split(" ");

const batchSize = 10;
const millisecondsBetweenRequests = 40;
const millisecondsToWaitForErrorsAfterEachBatch = 1_500;
// IBKR substituting delayed data still holds the line; every other error on a request means it holds none.
const codesThatStillHoldTheLine: ReadonlySet<number> = new Set([10089, 10091, 10167, 354]);

export interface MarketDataLineCeilingProbeResult {
  requested: number;
  linesHeldByProbe: number;
  hitTheLimit: boolean;
  limitRefusals: number;
  /** Requests refused for another reason (a symbol IBKR does not know), "SYMBOL code: message", at most 10. */
  otherFailures: string[];
}

type ProbeIb = Pick<IBApi, "on" | "removeListener" | "reqMktData" | "cancelMktData">;

export async function probeMarketDataLineCeiling(ib: ProbeIb, options: { wait?: (milliseconds: number) => Promise<void> } = {}): Promise<MarketDataLineCeilingProbeResult> {
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const holdingRequestIds = new Set<number>();
  const allSubscribedRequestIds: number[] = [];
  const otherFailures: string[] = [];
  let limitRefusals = 0;
  let hitTheLimit = false;

  const onError = (error: Error, code: number, requestId: number) => {
    if (!holdingRequestIds.has(requestId) || codesThatStillHoldTheLine.has(Number(code))) return;
    holdingRequestIds.delete(requestId);
    if (Number(code) === ibkrMaxTickersReachedCode) {
      limitRefusals += 1;
      hitTheLimit = true;
    } else if (otherFailures.length < 10) {
      otherFailures.push(`${probeTickerSymbols[requestId - 1]} ${code}: ${error.message}`);
    }
  };
  ib.on(EventName.error, onError);

  let nextIndex = 0;
  try {
    while (nextIndex < probeTickerSymbols.length && !hitTheLimit) {
      const batchEnd = Math.min(nextIndex + batchSize, probeTickerSymbols.length);
      for (; nextIndex < batchEnd; nextIndex++) {
        const requestId = nextIndex + 1;
        holdingRequestIds.add(requestId);
        allSubscribedRequestIds.push(requestId);
        ib.reqMktData(requestId, { symbol: probeTickerSymbols[nextIndex], secType: SecType.STK, exchange: "SMART", currency: "USD" }, "", false, false);
        await wait(millisecondsBetweenRequests);
      }
      await wait(millisecondsToWaitForErrorsAfterEachBatch);
      console.log(`Line ceiling probe: requested ${nextIndex}, holding ${holdingRequestIds.size}, refused as over the limit ${limitRefusals}.`);
    }
    return { requested: nextIndex, linesHeldByProbe: holdingRequestIds.size, hitTheLimit, limitRefusals, otherFailures };
  } finally {
    for (const requestId of allSubscribedRequestIds) {
      try {
        ib.cancelMktData(requestId);
      } catch {
        // The connection may have gone; IBKR drops its subscriptions with it.
      }
    }
    ib.removeListener(EventName.error, onError);
  }
}

/** The 10-minute health check runs at about :x0:30 for ~10 s and takes one line: the probe starts only between x1:30 and x8:00. */
export const probeWindowStartSecondOfCycle = 90;
export const probeWindowEndSecondOfCycle = 480;

/** Pure: how long to wait from `nowMs` until the probe window of the 10-minute cycle opens (0 inside it). */
export function millisecondsUntilProbeWindow(nowMs: number): number {
  const cycleMs = 600_000;
  const positionMs = nowMs % cycleMs;
  if (positionMs >= probeWindowStartSecondOfCycle * 1000 && positionMs <= probeWindowEndSecondOfCycle * 1000) return 0;
  return (probeWindowStartSecondOfCycle * 1000 - positionMs + cycleMs) % cycleMs;
}

export interface LedgerReservation {
  holder: string;
  lines: number;
  priority: boolean;
}

/**
 * Pure: the allocation the probe measured — its own lines plus the app's — only when it was refused and the app's
 * ledger was the same before and after (a holder coming or going during the probe makes the sum unreliable).
 */
export function measuredMarketDataLineCeiling(probe: Pick<MarketDataLineCeilingProbeResult, "linesHeldByProbe" | "hitTheLimit">, ledgerBefore: LedgerReservation[], ledgerAfter: LedgerReservation[]): number | null {
  if (!probe.hitTheLimit) return null;
  const describe = (ledger: LedgerReservation[]) => JSON.stringify([...ledger].sort((left, right) => left.holder.localeCompare(right.holder)).map(({ holder, lines }) => [holder, lines]));
  if (describe(ledgerBefore) !== describe(ledgerAfter)) return null;
  return probe.linesHeldByProbe + ledgerBefore.reduce((sum, reservation) => sum + reservation.lines, 0);
}
