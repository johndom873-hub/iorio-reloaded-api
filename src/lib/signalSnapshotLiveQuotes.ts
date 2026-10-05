// A Signals order is priced from the quotes its snapshot records, so it may only be built from live ones (Marcelo
// 2026-10-02: never trade without confirmation of live prices). The app's order forms already block on this; the check
// here is the backstop for a form that lets a day or snapshot quote through (a roll was priced from the previous
// session's close that way).

export const maximumLiveQuoteAgeMs = 15_000;

interface SnapshotQuote {
  quoteSource?: unknown;
  quotedAt?: unknown;
}

function describeQuoteProblem(label: string, quote: unknown, now: Date): string | null {
  if (typeof quote !== "object" || quote === null) return `${label} has no quote recorded`;
  const { quoteSource, quotedAt } = quote as SnapshotQuote;
  if (quoteSource !== "live") return `${label} is priced from a ${typeof quoteSource === "string" ? quoteSource : "missing"} quote, not a live one`;
  // The pooled live path leaves quotedAt unset (the frame's own time is the time), so only a stated time can be stale.
  if (typeof quotedAt === "string") {
    const ageMs = now.getTime() - new Date(quotedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > maximumLiveQuoteAgeMs) return `${label}'s live quote is older than ${maximumLiveQuoteAgeMs / 1000} seconds`;
  }
  return null;
}

/** The first reason a Signals snapshot's pricing quotes are not live and fresh, or null when every quote is (or the snapshot is not a Signals one). */
export function findNonLiveSnapshotQuoteReason(snapshot: Record<string, unknown> | null, now: Date = new Date()): string | null {
  if (snapshot === null) return null;
  const quotesToCheck: { label: string; quote: unknown }[] =
    snapshot.kind === "roll"
      ? [
          { label: "The leg being closed", quote: snapshot.closeLeg },
          { label: "The new leg", quote: snapshot.replacement },
        ]
      : snapshot.candidate !== undefined
        ? [{ label: "The contract", quote: snapshot.candidate }]
        : [];
  for (const { label, quote } of quotesToCheck) {
    const problem = describeQuoteProblem(label, quote, now);
    if (problem) return `${problem}. Wait for live prices and build the order again.`;
  }
  return null;
}
