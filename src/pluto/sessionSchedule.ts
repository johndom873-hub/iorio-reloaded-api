import { db } from "../db/connection.js";
import { earlyCloseDatesIso, easternInstant, hhmmParts, resolveSessionSchedule, type SessionCloseSource } from "../lib/marketSessionStatus.js";
import type { PlutoSettings } from "./settingsStore.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Today's session for Pluto (approved 2026-09-28): the close comes from IBKR's liquid hours for
// SPY, read every trading morning by the option-chain structure job in every environment
// (lib/sessionCloseFromIbkr.ts) and stored in market_calendar.close_time, so every screen sees half days too. The trading window ends `closeMarginMinutes` before the close,
// whatever the configured window; v4's buybacks of Calls in the money go on until `buyBacksStopMinutesBeforeClose` before it
// (Marcelo 2026-11-24), and an order still working then stays at IBKR until the close (a DAY order, it ends there).

/** Window end is never later than this long before the session close (15:30 on a 16:00 day, 12:30 on a 13:00 day). */
export const closeMarginMinutes = 30;
/** v4 sends its last buyback of a Call in the money this long before the close (15:59 on a 16:00 day, 12:59 on a 13:00 day). */
export const buyBacksStopMinutesBeforeClose = 1;

export type PlutoSessionCloseSource = SessionCloseSource | "fallback_list";

export interface PlutoSession {
  dateIso: string;
  isOpen: boolean;
  closeTimeEt: string;
  closeSource: PlutoSessionCloseSource;
  closeReadAt: string | null;
  windowStartEt: string;
  /** The configured window end, clamped to closeMarginMinutes before the close. */
  windowEndEt: string;
  /** When v4 sends its last buyback: buyBacksStopMinutesBeforeClose before the close. */
  buyBacksStopEt: string;
  closeAtMs: number;
  buyBacksStopAtMs: number;
  windowStartAtMs: number;
  windowEndAtMs: number;
}

function minutesOfDay(hhmm: string): number {
  const { hour, minute } = hhmmParts(hhmm);
  return hour * 60 + minute;
}

/** Pure: minutes after midnight as HH:MM (630 is 10:30). */
export function hhmmFromMinutes(minutes: number): string {
  const clamped = Math.max(0, minutes);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** Pure: the time `minutes` before an HH:MM time, HH:MM (15:30 less 2 minutes is 15:28). */
export function hhmmMinutesBefore(hhmm: string, minutes: number): string {
  return hhmmFromMinutes(minutesOfDay(hhmm) - minutes);
}

/** Pure: the earlier of the configured window end and (close − margin). */
export function effectiveWindowEndEt(windowEndEt: string, closeTimeEt: string, marginMinutes = closeMarginMinutes): string {
  return hhmmFromMinutes(Math.min(minutesOfDay(windowEndEt), minutesOfDay(closeTimeEt) - marginMinutes));
}

export async function resolvePlutoSession(now: Date, settings: Pick<PlutoSettings, "windowStartEt" | "windowEndEt">): Promise<PlutoSession> {
  const dateIso = easternIsoDate(now);
  const schedule = await resolveSessionSchedule(dateIso);
  let closeTimeEt = schedule.closeTimeEt;
  let closeSource: PlutoSessionCloseSource = schedule.closeSource;
  if (closeSource === "regular" && earlyCloseDatesIso.has(dateIso)) {
    closeTimeEt = "13:00";
    closeSource = "fallback_list";
  }
  const close = hhmmParts(closeTimeEt);
  const closeAtMs = easternInstant(dateIso, close.hour, close.minute).getTime();
  const buyBacksStopEt = hhmmFromMinutes(minutesOfDay(closeTimeEt) - buyBacksStopMinutesBeforeClose);
  const windowEndEt = effectiveWindowEndEt(settings.windowEndEt, closeTimeEt);
  const windowStart = hhmmParts(settings.windowStartEt);
  const windowEnd = hhmmParts(windowEndEt);
  return {
    dateIso,
    isOpen: schedule.isOpen,
    closeTimeEt,
    closeSource,
    closeReadAt: schedule.closeReadAt,
    windowStartEt: settings.windowStartEt,
    windowEndEt,
    buyBacksStopEt,
    closeAtMs,
    buyBacksStopAtMs: closeAtMs - buyBacksStopMinutesBeforeClose * 60_000,
    windowStartAtMs: easternInstant(dateIso, windowStart.hour, windowStart.minute).getTime(),
    windowEndAtMs: easternInstant(dateIso, windowEnd.hour, windowEnd.minute).getTime(),
  };
}

