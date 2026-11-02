import { easternInstant } from "../../lib/easternIsoDate.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import type { BacktestCycle, BacktestCycleGap, BacktestIdleStretch, BacktestNoSaleDays, BacktestOrderShortfall, BacktestStockOnlyStretch } from "../backtestTypes.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import type { LedgerLeg } from "./ledger/simulatedLedger.js";

// Whole trading sessions where nothing was sold that was due (approved by Marcelo 2026-10-20), for the Wheel cycles table:
//
//   gap               = the sessions of a symbol with no cycle open: before its first cycle (from its first session day),
//                       strictly between a cycle's closing day and the next one's opening day, and after its last closed
//                       cycle (to its last session day). A cycle that opens the session after the previous closed makes none.
//   stock only        = sessions of a cycle with shares held at the session's start (its Eastern midnight) and end (the
//                       next midnight) and no option open at any moment between, a put or a call (Marcelo 2026-10-20):
//                       shares handed over at a Friday expiry and covered again on Monday make none, and neither do
//                       shares with a call on some of them or a put sold under them. Consecutive sessions with the same
//                       shares held make one stretch.
//   stock move        = C(last idle day) ÷ C(the session before the first idle day) − 1, on IBKR's split-adjusted closes
//                       (a split inside the stretch is no fall); null when either close is missing.
//   no-sale days      = per reason, the idle days on which any look recorded a shortfall for it (a day counts under every
//                       reason seen); unrecorded = the idle days with none. Gaps read the entry order's shortfalls (cash,
//                       volume, no candidate); stock-only stretches read those of the calls on the free shares. The
//                       Entry filters' and the ladder's reasons, the no-candidate detail and the filters' limits are what
//                       the retired CC + Put Ladder recorded: they stay in the rows' shape, 0 and null.
//
// Example: a cycle closes Fri 9 Apr at expiry (close $63.00); the free cash holds the entry back Mon 12 to Wed 14 Apr;
// the next cycle opens Thu 15 Apr. Gap: 12–14 Apr, 3 idle sessions, Wed's close $60.48: 60.48 ÷ 63.00 − 1 = −4.0%, cash
// 3 days.

type NoSaleReason = Exclude<keyof BacktestNoSaleDays, "unrecorded">;

/** What the looks recorded about sales not made. */
export interface NoSaleRecords {
  shortfalls: readonly BacktestOrderShortfall[];
}

/** A symbol's split-adjusted daily closes, ascending, read by date. */
export interface CloseLookup {
  closeOn(dateIso: string): number | null;
  /** The last close dated before `dateIso`. */
  closeBefore(dateIso: string): number | null;
}

export function closeLookupOf(closesAscending: readonly { date: string; close: number }[]): CloseLookup {
  const closeByDate = new Map(closesAscending.map((bar) => [bar.date, bar.close]));
  return {
    closeOn: (dateIso) => closeByDate.get(dateIso) ?? null,
    closeBefore: (dateIso) => {
      let low = 0;
      let high = closesAscending.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (closesAscending[middle]!.date < dateIso) low = middle + 1;
        else high = middle;
      }
      return low === 0 ? null : closesAscending[low - 1]!.close;
    },
  };
}

const shortfallReason = { cash: "cash", volume: "volume", no_candidate: "noCandidate" } as const satisfies Record<BacktestOrderShortfall["reason"], NoSaleReason>;

/** Per day, the reasons the symbol's looks recorded for the entry order ("entry") or the calls on its free shares ("calls"). */
function reasonsByDay(records: NoSaleRecords, symbol: string, order: "entry" | "calls"): Map<string, Set<NoSaleReason>> {
  const byDay = new Map<string, Set<NoSaleReason>>();
  const add = (dateIso: string, reason: NoSaleReason) => {
    const reasons = byDay.get(dateIso);
    if (reasons) reasons.add(reason);
    else byDay.set(dateIso, new Set([reason]));
  };
  const step = order === "entry" ? "entry" : "held_calls";
  for (const shortfall of records.shortfalls) if (shortfall.symbol === symbol && shortfall.step === step) add(shortfall.tradingDate, shortfallReason[shortfall.reason]);
  return byDay;
}

function countNoSaleDays(idleDays: readonly string[], reasons: Map<string, Set<NoSaleReason>>): BacktestNoSaleDays {
  const counts: BacktestNoSaleDays = { extensionZ: 0, ivRank: 0, ladderPutInstead: 0, cash: 0, volume: 0, noCandidate: 0, unrecorded: 0 };
  for (const dateIso of idleDays) {
    const seen = reasons.get(dateIso);
    if (!seen || seen.size === 0) counts.unrecorded += 1;
    else for (const reason of seen) counts[reason] += 1;
  }
  return counts;
}

function idleStretch(idleDays: readonly string[], closes: CloseLookup, reasons: Map<string, Set<NoSaleReason>>): BacktestIdleStretch {
  const firstIdleDay = idleDays[0]!;
  const lastIdleDay = idleDays.at(-1)!;
  const reference = closes.closeBefore(firstIdleDay);
  const last = closes.closeOn(lastIdleDay);
  return {
    firstIdleDay,
    lastIdleDay,
    idleSessions: idleDays.length,
    stockMove: reference === null || last === null || !(reference > 0) ? null : last / reference - 1,
    noSaleDays: countNoSaleDays(idleDays, reasons),
    noCandidate: null,
  };
}

/** A symbol's gaps, oldest first. `cycles` are the symbol's, in order; `firstDay`/`lastDay` its first and last session days. */
export function buildCycleGaps(input: {
  symbol: string;
  cycles: readonly Pick<BacktestCycle, "cycleNumber" | "openedOn" | "closedOn">[];
  firstDay: string;
  lastDay: string;
  calendar: Pick<BacktestTradingCalendar, "openDaysBetween">;
  closes: CloseLookup;
  records: NoSaleRecords;
}): BacktestCycleGap[] {
  const { symbol, cycles, firstDay, lastDay } = input;
  const reasons = reasonsByDay(input.records, symbol, "entry");
  const gaps: BacktestCycleGap[] = [];
  const addGap = (fromIso: string, throughIso: string, afterCycleNumber: number | null, beforeCycleNumber: number | null) => {
    const idleDays = input.calendar.openDaysBetween(fromIso < firstDay ? firstDay : fromIso, throughIso > lastDay ? lastDay : throughIso);
    if (idleDays.length === 0) return;
    gaps.push({ symbol, afterCycleNumber, beforeCycleNumber, ...idleStretch(idleDays, input.closes, reasons), entryFilterLimits: { extensionZ: null, ivRank: null } });
  };
  if (cycles.length === 0) {
    addGap(firstDay, lastDay, null, null);
    return gaps;
  }
  addGap(firstDay, addCalendarDays(cycles[0]!.openedOn, -1), null, cycles[0]!.cycleNumber);
  cycles.forEach((cycle, index) => {
    if (cycle.closedOn === null) return;
    const next = cycles[index + 1];
    addGap(addCalendarDays(cycle.closedOn, 1), next ? addCalendarDays(next.openedOn, -1) : lastDay, cycle.cycleNumber, next?.cycleNumber ?? null);
  });
  return gaps;
}

/**
 * A cycle's stock-only stretches, oldest first. `legs` are its symbol's (their options tell the days with one open);
 * `sharesHeldAt` gives the cycle's shares at an instant from its own trades, on the cycle's scale (a stock leg's quantity
 * is its last: shares an assignment added to a lot held are on that lot's leg from its start); `sharesAsTradedOn` turns
 * them into those traded on a day (× the cycle's split factor ÷ the day's).
 */
export function buildStockOnlyStretches(input: {
  symbol: string;
  cycle: Pick<BacktestCycle, "openedOn" | "closedOn">;
  lastDay: string;
  legs: readonly LedgerLeg[];
  calendar: Pick<BacktestTradingCalendar, "openDaysBetween">;
  closes: CloseLookup;
  records: NoSaleRecords;
  sharesHeldAt(atMs: number): number;
  sharesAsTradedOn(dateIso: string): number;
}): BacktestStockOnlyStretch[] {
  const cycleDays = input.calendar.openDaysBetween(input.cycle.openedOn, input.cycle.closedOn ?? input.lastDay);
  if (cycleDays.length === 0) return [];
  const windowStartMs = easternInstant(cycleDays[0]!, 0, 0).getTime();
  const windowEndMs = easternInstant(addCalendarDays(cycleDays.at(-1)!, 1), 0, 0).getTime();
  const legs = input.legs.filter((leg) => leg.entryAt.getTime() < windowEndMs && (leg.exitAt === null || leg.exitAt.getTime() > windowStartMs));
  const optionLegs = legs.filter((leg) => leg.legType === "option");
  const reasons = reasonsByDay(input.records, input.symbol, "calls");
  const stretches: BacktestStockOnlyStretch[] = [];
  let run: { days: string[]; held: number } | null = null;
  const closeRun = () => {
    if (run === null) return;
    stretches.push({ ...idleStretch(run.days, input.closes, reasons), sharesHeld: run.held * input.sharesAsTradedOn(run.days[0]!) });
    run = null;
  };
  for (const dateIso of cycleDays) {
    const dayStartMs = easternInstant(dateIso, 0, 0).getTime();
    const dayEndMs = easternInstant(addCalendarDays(dateIso, 1), 0, 0).getTime();
    const held = Math.min(input.sharesHeldAt(dayStartMs), input.sharesHeldAt(dayEndMs - 1));
    const optionOpen = optionLegs.some((leg) => leg.entryAt.getTime() < dayEndMs && (leg.exitAt === null || leg.exitAt.getTime() > dayStartMs));
    if (!(held > 0) || optionOpen) {
      closeRun();
      continue;
    }
    if (run !== null && run.held === held) run.days.push(dateIso);
    else {
      closeRun();
      run = { days: [dateIso], held };
    }
  }
  closeRun();
  return stretches;
}
