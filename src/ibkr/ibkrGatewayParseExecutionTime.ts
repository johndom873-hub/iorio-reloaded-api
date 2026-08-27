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
export function parseIbkrExecutionTime(raw: string | undefined): Date | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;

  const naiveUtcGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const partsInZone = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(naiveUtcGuess));
  const part = (type: string) => Number(partsInZone.find((p) => p.type === type)?.value);

  const asIfUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  const offsetMs = naiveUtcGuess - asIfUtc;
  return new Date(naiveUtcGuess + offsetMs);
}
