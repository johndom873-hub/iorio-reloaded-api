import { easternDateIso, easternInstant } from "./marketSessionStatus.js";

// Heroku Scheduler only fires at fixed UTC times, but the capture is meant to
// run at the market open, 9:30 ET. 9:30 ET is 13:30 UTC during EDT and 14:30
// UTC during EST, so the job is scheduled at BOTH 13:30 and 14:30 UTC and
// exits unless it is currently 9:30-10:00 ET — exactly one of the two does
// the real work every day of the year, with no manual change at the daylight
// saving switch.
//
// The window is 30 minutes wide so a Scheduler start delay plus dyno boot time
// can't push a legitimate run outside it.
const captureWindowStart = { hour: 9, minute: 30 };
const captureWindowEnd = { hour: 10, minute: 0 };

export function isWithinChainCaptureClockWindow(now: Date = new Date()): boolean {
  const dateIso = easternDateIso(now);
  const windowStart = easternInstant(dateIso, captureWindowStart.hour, captureWindowStart.minute);
  const windowEnd = easternInstant(dateIso, captureWindowEnd.hour, captureWindowEnd.minute);
  return now >= windowStart && now < windowEnd;
}
