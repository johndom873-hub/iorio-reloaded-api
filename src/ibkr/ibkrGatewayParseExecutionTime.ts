// IBKR's Execution.time is not ISO and not parseable by `new Date()` — it's
// "YYYYMMDD HH:mm:ss <IANA zone name>", e.g. "20260824 09:44:07 US/Eastern"
// (found 2026-08-24 backfilling real HOOD executions: `new Date(execution.time)`
// silently produced an Invalid Date, which then crashed the trades insert
// with "invalid input syntax for type timestamp"). This affects every real
// execution, not just historical ones — recordExecution in ibkrGatewayWorker.ts hits
// the exact same string shape live.
//
// Standard "guess and correct" technique: build a UTC instant using the
// wall-clock numbers as if they were already UTC, format that instant back
// into the named zone via Intl (which knows the real DST rules), and use
// the difference to correct the guess — avoids hardcoding EST/EDT offsets.
// One formatter per zone, built once: constructing an Intl.DateTimeFormat per call holds native memory until a GC.
const zonePartsFormatters = new Map<string, Intl.DateTimeFormat>();
function zonePartsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zonePartsFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zonePartsFormatters.set(zone, formatter);
  }
  return formatter;
}

export function parseIbkrExecutionTime(raw: string | undefined): Date | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;

  const naiveUtcGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const formatter = zonePartsFormatter(zone!);
  // The zone's offset from UTC at an instant (e.g. −4 h for EDT).
  const zoneOffsetMsAt = (instantMs: number) => {
    const partsInZone = formatter.formatToParts(new Date(instantMs));
    const part = (type: string) => Number(partsInZone.find((p) => p.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instantMs;
  };
  // Corrected twice: on a DST-change day the offset at the first guess can be the other side of the switch.
  const firstGuess = naiveUtcGuess - zoneOffsetMsAt(naiveUtcGuess);
  return new Date(naiveUtcGuess - zoneOffsetMsAt(firstGuess));
}
