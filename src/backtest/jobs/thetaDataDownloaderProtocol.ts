// The ThetaData downloader's stdout protocol (docs/backtesting/DATA-FILES.md): one JSON object per line. Pure.

export type DownloaderEvent =
  | { type: "start"; symbol: string; daysTotal: number; daysDone: number }
  | { type: "progress"; daysDone: number; daysTotal: number; lastDate: string; quoteRows: number | null }
  | { type: "done"; daysDone: number; daysTotal: number }
  | { type: "error"; message: string };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The event a line carries, or null when the line is not one (it is then only logged). */
export function parseDownloaderLine(line: string): DownloaderEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  switch (event.type) {
    case "start":
      return isCount(event.daysTotal) && isCount(event.daysDone) ? { type: "start", symbol: String(event.symbol ?? ""), daysTotal: event.daysTotal, daysDone: event.daysDone } : null;
    case "progress":
      return isCount(event.daysTotal) && isCount(event.daysDone) && typeof event.lastDate === "string"
        ? { type: "progress", daysDone: event.daysDone, daysTotal: event.daysTotal, lastDate: event.lastDate, quoteRows: isCount(event.quoteRows) ? event.quoteRows : null }
        : null;
    case "done":
      return isCount(event.daysTotal) && isCount(event.daysDone) ? { type: "done", daysDone: event.daysDone, daysTotal: event.daysTotal } : null;
    case "error":
      return { type: "error", message: typeof event.message === "string" && event.message.trim() !== "" ? event.message : "The downloader reported an error without a message." };
    default:
      return null;
  }
}
