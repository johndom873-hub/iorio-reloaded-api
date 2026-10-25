import { expirySettlementInstant } from "./engine/ledger/ledgerEvents.js";
import type { BacktestCycleTimelineRow } from "./backtestTypes.js";

// The Vol Farmer's hedge marked at every hand-over of the shares (Marcelo 2026-10-23). A Put protects the shares across
// several Calls, so each "Call + shares + Put" period hands it to the next: when the shares are handed to N/S (a Call
// expired) or back to CC (the next Call sold), the Put is marked at that day's close and the period it leaves is credited
// with what it made since its last mark, in the row's net premium, as the shares' hand-over rows book their stock P&L.
//   hand-over row = (the Put's mark at that close − its last mark) × shares-equivalent; the first last mark is its cost
//                   per share with the opening commission
//   purchase row  = no premium (the description keeps its price)
//   closing row   = what it brought (as before) − the last mark × its shares-equivalent; an open Put's mark row the same
//   expired worthless with no row of its own: a row at its expiry, − the last mark × shares-equivalent
// Every cycle's rows add up to the same total as before. Marks and quantities are tracked on the split-adjusted scale
// (× the day's cumulative split factor for quantities, ÷ for prices) and shown as traded on the row's day.

/** The Put's price per share as traded on a day: its closing mid, else its last trade, else its intrinsic value at the stock's close; null when none is known. */
export type HedgePutMarkOf = (tradingDate: string, expiry: string, strikeAsTraded: number, stockCloseAsTraded: number | null) => number | null;

interface HedgeLot {
  expiry: string;
  /** Per share, split-adjusted. */
  strikeAdjusted: number;
  /** Shares-equivalent, split-adjusted. */
  quantityAdjusted: number;
  /** Per share, split-adjusted: the cost with commission, then each mark. */
  lastMarkAdjusted: number;
  boughtAtMs: number;
  /** Still held when the cycle was read (the purchase row says so): its mark row takes the rest. */
  heldAtEnd: boolean;
}

const isHedgePurchase = (row: BacktestCycleTimelineRow) => row.bucket === "hedge" && row.instrument === "option" && /^Bought put @/.test(row.label);
const isHedgeClosing = (row: BacktestCycleTimelineRow) => row.bucket === "hedge" && row.instrument === "option" && /^Sold put @/.test(row.label);
const isHedgeMark = (row: BacktestCycleTimelineRow) => row.bucket === "hedge" && row.at === null && /^Open put marked to market$/.test(row.label);
const handOverDestination = (row: BacktestCycleTimelineRow): "CC" | "Unstructured" | null => {
  const match = /^Shares handed to (CC|Unstructured)$/.exec(row.label);
  return match ? (match[1] as "CC" | "Unstructured") : null;
};
const sameContract = (lot: HedgeLot, expiry: string | null, strikeAdjusted: number) => lot.expiry === expiry && Math.abs(lot.strikeAdjusted - strikeAdjusted) < 1e-6;

/**
 * The timeline with the hedge marked at the hand-overs (above). `sourceIndexes[i]` is the input row the output row i is,
 * or follows (an added row): what the cycle reads per moment (shares held, free cash) comes from there.
 */
export function withHedgeMarkedAtHandOvers(timeline: readonly BacktestCycleTimelineRow[], markOf: HedgePutMarkOf, splitFactorOf: (tradingDate: string) => number): { rows: BacktestCycleTimelineRow[]; sourceIndexes: number[] } {
  const rows: BacktestCycleTimelineRow[] = [];
  const sourceIndexes: number[] = [];
  const lots: HedgeLot[] = [];
  const push = (row: BacktestCycleTimelineRow, sourceIndex: number) => {
    rows.push(row);
    sourceIndexes.push(sourceIndex);
  };
  /** Lots that ran out with no row of their own before `beforeMs` (all of the not-held ones when null): a row at their expiry. */
  const expire = (beforeMs: number | null, sourceIndex: number) => {
    for (const lot of lots) {
      if (lot.quantityAdjusted <= 1e-9 || lot.heldAtEnd) continue;
      const expiryMs = expirySettlementInstant(lot.expiry).getTime();
      if (beforeMs !== null && expiryMs >= beforeMs) continue;
      const factor = splitFactorOf(lot.expiry);
      push(
        { at: new Date(expiryMs).toISOString(), tradingDate: lot.expiry, label: "Put expired worthless", bucket: "hedge", instrument: "option", quantity: lot.quantityAdjusted / factor, strike: lot.strikeAdjusted * factor, expiryDate: lot.expiry, stockPrice: null, stockPriceSource: null, commissionDollars: null, premiumDollars: -lot.lastMarkAdjusted * lot.quantityAdjusted, stockDollars: 0, unrealized: false },
        sourceIndex,
      );
      lot.quantityAdjusted = 0;
    }
  };

  /** Once a moment's last row is in: every Put held from before it is marked at that day's close if the shares were handed over in it. */
  const markAtHandOver = (index: number) => {
    const row = timeline[index]!;
    const next = timeline[index + 1];
    if (row.at === null || (next !== undefined && next.at === row.at)) return;
    const destination = lastHandOverOfMoment(timeline, index);
    if (destination === null) return;
    const atMs = Date.parse(row.at);
    const factor = splitFactorOf(row.tradingDate);
    for (const lot of lots) {
      if (lot.quantityAdjusted <= 1e-9 || lot.boughtAtMs >= atMs || expirySettlementInstant(lot.expiry).getTime() <= atMs) continue;
      const strikeAsTraded = lot.strikeAdjusted * factor;
      const markAsTraded = markOf(row.tradingDate, lot.expiry, strikeAsTraded, row.stockPrice);
      if (markAsTraded === null) continue;
      const markAdjusted = markAsTraded / factor;
      push(
        {
          at: row.at,
          tradingDate: row.tradingDate,
          label: `Put handed to ${destination} @ ${markAsTraded.toFixed(2)}`,
          bucket: "hedge",
          instrument: "option",
          quantity: lot.quantityAdjusted / factor,
          strike: strikeAsTraded,
          expiryDate: lot.expiry,
          stockPrice: row.stockPrice,
          stockPriceSource: "close",
          commissionDollars: null,
          premiumDollars: (markAdjusted - lot.lastMarkAdjusted) * lot.quantityAdjusted,
          stockDollars: 0,
          unrealized: false,
        },
        index,
      );
      lot.lastMarkAdjusted = markAdjusted;
    }
  };

  timeline.forEach((row, index) => {
    const factor = splitFactorOf(row.tradingDate);
    const atMs = row.at === null ? null : Date.parse(row.at);
    expire(atMs, Math.max(0, index - 1));

    if (isHedgePurchase(row) && row.strike !== null && row.expiryDate !== null && row.quantity > 0) {
      const quantityAdjusted = row.quantity * factor;
      const costAdjusted = -row.premiumDollars / quantityAdjusted;
      const strikeAdjusted = row.strike / factor;
      const held = lots.find((lot) => lot.quantityAdjusted > 1e-9 && sameContract(lot, row.expiryDate, strikeAdjusted));
      if (held) {
        held.lastMarkAdjusted = (held.lastMarkAdjusted * held.quantityAdjusted + costAdjusted * quantityAdjusted) / (held.quantityAdjusted + quantityAdjusted);
        held.quantityAdjusted += quantityAdjusted;
        held.heldAtEnd = held.heldAtEnd || row.unrealized === true;
      } else lots.push({ expiry: row.expiryDate, strikeAdjusted, quantityAdjusted, lastMarkAdjusted: costAdjusted, boughtAtMs: atMs ?? 0, heldAtEnd: row.unrealized === true });
      push({ ...row, premiumDollars: 0 }, index);
    } else if (isHedgeClosing(row) && row.strike !== null && row.quantity > 0) {
      const quantityAdjusted = row.quantity * factor;
      const lot = lots.find((candidate) => candidate.quantityAdjusted > 1e-9 && sameContract(candidate, row.expiryDate, row.strike! / factor));
      if (lot) {
        push({ ...row, premiumDollars: row.premiumDollars - lot.lastMarkAdjusted * quantityAdjusted }, index);
        lot.quantityAdjusted = Math.max(0, lot.quantityAdjusted - quantityAdjusted);
      } else push(row, index);
    } else if (isHedgeMark(row)) {
      const held = lots.filter((lot) => lot.quantityAdjusted > 1e-9 && lot.heldAtEnd && (row.strike === null || sameContract(lot, row.expiryDate, row.strike / factor)));
      const marked = held.reduce((sum, lot) => sum + lot.lastMarkAdjusted * lot.quantityAdjusted, 0);
      push({ ...row, premiumDollars: row.premiumDollars - marked }, index);
      for (const lot of held) lot.quantityAdjusted = 0;
    } else push(row, index);
    markAtHandOver(index);
  });
  expire(null, timeline.length - 1);
  return { rows, sourceIndexes };
}

/** The destination of the moment's hand-over that ends at `index` (the last hand-over row at that instant), or null. */
function lastHandOverOfMoment(timeline: readonly BacktestCycleTimelineRow[], index: number): "CC" | "Unstructured" | null {
  const at = timeline[index]!.at;
  for (let position = index; position >= 0 && timeline[position]!.at === at; position -= 1) {
    const destination = handOverDestination(timeline[position]!);
    if (destination) return destination;
  }
  return null;
}
