import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { optionExpiryCloseHourEastern } from "../lib/optionExpiryClock.js";
import type { BacktestCycle, BacktestNoCallReason, BacktestNoSaleDays, BacktestPositionLeg, BacktestStockOnlyStretch } from "./backtestTypes.js";

// A cycle's days with shares and no Call (approved by Marcelo 2026-10-27), for the Wheel cycles' No-Call days column and
// its No Call rows, read from the cycle's legs when the session is read:
//
//   share day   = a session day of the cycle with shares held while the market was open: a stock leg covers the days
//                 from its entry's Eastern date to its exit's, both included (an open one to the session's last day);
//                 shares that arrive at or after the 16:00 close (a put's assignment) count from the next session.
//   Call day    = a session day with a Call sold open at any time: from its sale's date to its expiry's, assignment's or
//                 buy-back's, both included, as the Covered Calls tile counts them.
//   no-Call day = a share day that is not a Call day; a run is consecutive session days of them.
//
// Example: AAPL #6 of the R5 30% session bought 200 shares on session 34 and sold them on 91 (58 share days); its Calls
// covered 34–40, 45–50, 83–84 and 89–91 (18 days), leaving 40 no-Call days in three runs: 41→44, 51→82 and 85→88.
//
// Why no Call was sold: a Vol Farmer session reads the 10:00 look's note on the symbol in the day's summary ("no Call
// passes the hedge rule …"); any other reads what the looks recorded about the calls on the free shares (their
// shortfalls, the ladder put sold instead of them), with the counts its stock-only stretches stored for their days.

type CoverageLeg = Pick<BacktestPositionLeg, "legType" | "optionType" | "side" | "entryAt" | "exitAt">;

/** The reasons the stock-only stretches count (BacktestNoSaleDays), as the Wheel cycles word them. */
const noSaleReasonLabels: Record<keyof BacktestNoSaleDays, string> = {
  extensionZ: "the extension z filter",
  ivRank: "the IV Rank filter",
  ladderPutInstead: "a ladder put sold instead",
  cash: "not enough cash",
  volume: "the volume limit",
  noCandidate: "no candidate",
  unrecorded: "no reason recorded",
};

/** Most days first, the order found among equals. */
const mostDaysFirst = (reasons: BacktestNoCallReason[]) => reasons.sort((a, b) => b.days - a.days);

/** The index of the first of the ascending `days` on or after `day` (its length when none is). */
function firstIndexFrom(days: readonly string[], day: string): number {
  let low = 0;
  let high = days.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (days[middle]! < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The index of the first of the ascending `days` after `day` (its length when none is). */
const firstIndexAfter = (days: readonly string[], day: string) => {
  const index = firstIndexFrom(days, day);
  return days[index] === day ? index + 1 : index;
};

export interface CycleNoCallDays {
  /** The cycle's session days with shares held. */
  shareDays: number;
  /** Its no-Call days in runs of consecutive session days, oldest first. */
  runs: string[][];
  /** The cycle's session days with a hedge Put held at any time. */
  hedgePutDays: ReadonlySet<string>;
}

/** `sessionDays` ascending (the cycle's and any others); `positions` the cycle's. */
export function cycleNoCallDays(input: { sessionDays: readonly string[]; cycle: Pick<BacktestCycle, "openedOn" | "closedOn">; positions: readonly { strategyKey: string; legs: readonly CoverageLeg[] }[] }): CycleNoCallDays {
  const { openedOn, closedOn } = input.cycle;
  const cycleDays = input.sessionDays.slice(firstIndexFrom(input.sessionDays, openedOn), closedOn === null ? undefined : firstIndexAfter(input.sessionDays, closedOn));
  const legsWhere = (keep: (strategyKey: string, leg: CoverageLeg) => boolean) => input.positions.flatMap((position) => position.legs.filter((leg) => keep(position.strategyKey, leg)));
  const daysCoveredBy = (legs: readonly CoverageLeg[]): Set<string> => {
    const covered = new Set<string>();
    for (const leg of legs) {
      const entryAt = new Date(leg.entryAt);
      const entryDay = easternIsoDate(entryAt);
      const fromTheNextSession = leg.legType === "stock" && easternMinutesOfDay(entryAt) >= optionExpiryCloseHourEastern * 60;
      const exitDay = leg.exitAt === null ? null : easternIsoDate(new Date(leg.exitAt));
      for (let index = fromTheNextSession ? firstIndexAfter(cycleDays, entryDay) : firstIndexFrom(cycleDays, entryDay); index < cycleDays.length && (exitDay === null || cycleDays[index]! <= exitDay); index++) covered.add(cycleDays[index]!);
    }
    return covered;
  };
  const shareDays = daysCoveredBy(legsWhere((_, leg) => leg.legType === "stock"));
  const callDays = daysCoveredBy(legsWhere((_, leg) => leg.legType === "option" && leg.optionType === "call" && leg.side === "short"));
  const runs: string[][] = [];
  let run: string[] | null = null;
  for (const day of cycleDays) {
    if (!shareDays.has(day) || callDays.has(day)) {
      run = null;
      continue;
    }
    if (run === null) runs.push((run = []));
    run.push(day);
  }
  return { shareDays: shareDays.size, runs, hedgePutDays: daysCoveredBy(legsWhere((strategyKey, leg) => strategyKey === "hedge" && leg.legType === "option" && leg.optionType === "put")) };
}

/**
 * The note on a symbol in a Vol Farmer day's summary: the first part (parts are joined by " · ") that starts with
 * "SYMBOL: ", after the look's time when the day names it ("10:00 AAPL: no Call …"); null when there is none.
 */
export function volFarmerNoteOn(daySummary: string | null, symbol: string): string | null {
  if (daySummary === null) return null;
  const prefix = `${symbol}: `;
  for (const part of daySummary.split(" · ")) {
    const text = part.replace(/^\d{1,2}:\d{2} /, "");
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return null;
}

/** The Vol Farmer's notes on held shares with no Call sold (backtestVolFarmerLook.ts), as reasons. */
const volFarmerNoCallReasons: { pattern: RegExp; reason: string }[] = [
  { pattern: /^no Call passes the hedge rule/, reason: "no Call passed the hedge rule" },
  { pattern: /^no Call has a Put that passes the hedge rule/, reason: "no Call with a Put passed the hedge rule" },
  { pattern: /^no Call within the rules/, reason: "no Call within the rules" },
  { pattern: /^no Call expiry listed/, reason: "no Call expiry listed" },
  { pattern: /^no Call sold: the volume limit/, reason: "the volume limit" },
  { pattern: /^the hedge Put has no implied volatility/, reason: "no implied volatility for the hedge Put yet" },
  { pattern: /^no option orders while the open cycle spans a split/, reason: "a split inside the cycle" },
];

/**
 * A Vol Farmer note as a reason ("no Call passes the hedge rule with the Put held and expires by it (shares at 324.38)" →
 * "no Call passed the hedge rule"); a note not known here is its own reason, its parenthesis left out. A hedge-rule note's
 * figure: the break-even it states ("so the shares break even at 319.37"), else the shares' cost ("shares at 324.38").
 */
export function volFarmerNoCallReason(note: string): Pick<BacktestNoCallReason, "reason" | "figure"> {
  const known = volFarmerNoCallReasons.find((entry) => entry.pattern.test(note));
  const reason = known?.reason ?? note.replace(/\s*\(.*$/, "");
  const breakEven = /break even at (\d+(?:\.\d+)?)/.exec(note);
  const shareCost = /shares at (\d+(?:\.\d+)?)/.exec(note);
  const figure = breakEven ? { kind: "breakEven" as const, dollars: Number(breakEven[1]) } : shareCost ? { kind: "shareCost" as const, dollars: Number(shareCost[1]) } : null;
  return { reason, figure };
}

/**
 * A Vol Farmer v2 day's note on a symbol: from "SYMBOL: " (after the look's time when the day names it) up to the next
 * symbol's note or the summary's end. Its own orders' labels hold " · " ("Sell $7.5 Call · 21 Jan (312DTE) · 18× @ 3.33"),
 * so it is not cut at the first one as volFarmerNoteOn's note is; null when the day has no note on the symbol.
 */
export function volFarmerV2NoteOn(daySummary: string | null, symbol: string): string | null {
  if (daySummary === null) return null;
  const parts = daySummary.split(" · ");
  const start = parts.findIndex((part) => part.replace(/^\d{1,2}:\d{2} /, "").startsWith(`${symbol}: `));
  if (start < 0) return null;
  const next = parts.findIndex((part, index) => index > start && /^(?:\d{1,2}:\d{2} )?[A-Z][A-Z0-9.]*: /.test(part));
  return parts
    .slice(start, next < 0 ? undefined : next)
    .join(" · ")
    .replace(/^(?:\d{1,2}:\d{2} )?[^:]+: /, "");
}

/**
 * Vol Farmer v2's notes on a position's shares with no Call sold (backtestVolFarmerV2Look.ts): each part of the symbol's
 * note ("first position: no Call at or above its break-even 14.20 (expiry 130, below cost 20)"; parts are joined by "; ")
 * as a reason ("no Call at or above B-E¹"), its break-even the figure; the split note as the Vol Farmer's. Parts about
 * other orders are left out.
 */
export function volFarmerV2NoCallReasons(note: string): (Pick<BacktestNoCallReason, "reason" | "figure"> & { text: string })[] {
  return note.split("; ").flatMap((text): (Pick<BacktestNoCallReason, "reason" | "figure"> & { text: string })[] => {
    const belowBreakEven = /^(first|second) position: no Call at or above its break-even (-?\d+(?:\.\d+)?)/.exec(text);
    if (belowBreakEven) return [{ reason: `no Call at or above B-E${belowBreakEven[1] === "first" ? "¹" : "²"}`, figure: { kind: "level" as const, dollars: Number(belowBreakEven[2]) }, text }];
    if (/^(first|second) position: no Call sold: the volume limit/.test(text)) return [{ reason: "the volume limit", figure: null, text }];
    const known = volFarmerNoCallReasons.find((entry) => entry.pattern.test(text));
    return known ? [{ reason: known.reason, figure: null, text }] : [];
  });
}

/** A Vol Farmer v2 run's reasons, most days first: a day counts under every reason its note gives (none: no reason recorded). */
export function volFarmerV2RunReasons(days: readonly { date: string; note: string | null }[]): BacktestNoCallReason[] {
  const byReason = new Map<string, BacktestNoCallReason>();
  for (const { date, note } of days) {
    const reasons = note === null ? [] : volFarmerV2NoCallReasons(note);
    for (const { reason, figure, text } of reasons.length > 0 ? reasons : [{ reason: noSaleReasonLabels.unrecorded, figure: null, text: null }]) {
      const seen = byReason.get(reason);
      if (seen) seen.days += 1;
      else byReason.set(reason, { reason, days: 1, figure, firstNote: text === null ? null : { date, text } });
    }
  }
  return mostDaysFirst([...byReason.values()]);
}

/** A Vol Farmer run's reasons, most days first: each day's note on the symbol (none: no reason recorded). */
export function volFarmerRunReasons(days: readonly { date: string; note: string | null }[]): BacktestNoCallReason[] {
  const byReason = new Map<string, BacktestNoCallReason>();
  for (const { date, note } of days) {
    const { reason, figure } = note === null ? { reason: noSaleReasonLabels.unrecorded, figure: null } : volFarmerNoCallReason(note);
    const seen = byReason.get(reason);
    if (seen) seen.days += 1;
    else byReason.set(reason, { reason, days: 1, figure, firstNote: note === null ? null : { date, text: note } });
  }
  return mostDaysFirst([...byReason.values()]);
}

/**
 * Any other session's run reasons, most days first: a stock-only stretch's days (no option open) count as it stored them;
 * each other day under the reasons recorded for it (`reasonsOn`), else no reason recorded.
 */
export function recordedRunReasons(input: { days: readonly string[]; stretches: readonly Pick<BacktestStockOnlyStretch, "firstIdleDay" | "lastIdleDay" | "noSaleDays">[]; reasonsOn: (date: string) => readonly Exclude<keyof BacktestNoSaleDays, "unrecorded">[] }): BacktestNoCallReason[] {
  const counts: BacktestNoSaleDays = { extensionZ: 0, ivRank: 0, ladderPutInstead: 0, cash: 0, volume: 0, noCandidate: 0, unrecorded: 0 };
  const first = input.days[0];
  const last = input.days.at(-1);
  const inside = first === undefined || last === undefined ? [] : input.stretches.filter((stretch) => stretch.firstIdleDay >= first && stretch.lastIdleDay <= last);
  for (const stretch of inside) for (const key of Object.keys(counts) as (keyof BacktestNoSaleDays)[]) counts[key] += stretch.noSaleDays[key];
  for (const date of input.days) {
    if (inside.some((stretch) => stretch.firstIdleDay <= date && date <= stretch.lastIdleDay)) continue;
    const reasons = new Set(input.reasonsOn(date));
    if (reasons.size === 0) counts.unrecorded += 1;
    for (const reason of reasons) counts[reason] += 1;
  }
  return mostDaysFirst((Object.keys(counts) as (keyof BacktestNoSaleDays)[]).filter((key) => counts[key] > 0).map((key) => ({ reason: noSaleReasonLabels[key], days: counts[key], figure: null, firstNote: null })));
}
