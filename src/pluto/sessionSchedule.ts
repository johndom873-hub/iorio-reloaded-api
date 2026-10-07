import { db } from "../db/connection.js";
import { easternInstant, hhmmParts, resolveSessionSchedule, type SessionCloseSource } from "../lib/marketSessionStatus.js";
import type { PlutoSettings } from "./settingsStore.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Today's session for Pluto (approved 2026-09-28): the close comes from IBKR's liquid hours for
// SPY, read every trading morning by the option-chain structure job in every environment
// (lib/sessionCloseFromIbkr.ts) and stored in market_calendar.close_time, so every screen sees half days too. The trading window ends `closeMarginMinutes` before the close and
// working orders are cancelled `cancelMarginMinutes` before it, whatever the configured window.

/** Window end is never later than this long before the session close (15:30 on a 16:00 day, 12:30 on a 13:00 day). */
export const closeMarginMinutes = 30;
/** Working Pluto orders are cancelled this long before the close at the latest. */
export const cancelMarginMinutes = 2;

// Fallback only, used when IBKR has not answered yet today: NYSE early closes (13:00 ET).
export const earlyCloseDatesIso = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2027-12-23"]);

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
  cancelByEt: string;
  closeAtMs: number;
  cancelByMs: number;
  windowStartAtMs: number;
  windowEndAtMs: number;
}

function minutesOfDay(hhmm: string): number {
  const { hour, minute } = hhmmParts(hhmm);
  return hour * 60 + minute;
}

function hhmmFromMinutes(minutes: number): string {
  const clamped = Math.max(0, minutes);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
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
  const cancelByEt = hhmmFromMinutes(minutesOfDay(closeTimeEt) - cancelMarginMinutes);
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
    cancelByEt,
    closeAtMs,
    cancelByMs: closeAtMs - cancelMarginMinutes * 60_000,
    windowStartAtMs: easternInstant(dateIso, windowStart.hour, windowStart.minute).getTime(),
    windowEndAtMs: easternInstant(dateIso, windowEnd.hour, windowEnd.minute).getTime(),
  };
}

