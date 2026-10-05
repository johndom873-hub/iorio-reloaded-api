import { easternDateIso, easternInstant } from "./marketSessionStatus.js";

// Heroku Scheduler only fires at fixed UTC times, but the capture is meant to
// run 30 minutes after the market open, 10:00 ET (moved from 9:30 on 2026-09-30:
// quotes in the first minutes after the open swing too hard to fit a surface).
// 10:00 ET is 14:00 UTC during EDT and 15:00 UTC during EST, so the job is
// scheduled at BOTH 14:00 and 15:00 UTC and exits unless it is currently 10:00-10:30 ET — exactly one of the two does
// the real work every day of the year, with no manual change at the daylight
// saving switch.
//
// The window is 30 minutes wide so a Scheduler start delay plus dyno boot time
// can't push a legitimate run outside it.
const captureWindowStart = { hour: 10, minute: 0 };
const captureWindowEnd = { hour: 10, minute: 30 };

export function isWithinChainCaptureClockWindow(now: Date = new Date()): boolean {
  const dateIso = easternDateIso(now);
  const windowStart = easternInstant(dateIso, captureWindowStart.hour, captureWindowStart.minute);
  const windowEnd = easternInstant(dateIso, captureWindowEnd.hour, captureWindowEnd.minute);
  return now >= windowStart && now < windowEnd;
}
