// Line-usage measurement shared by the rolling quote windows (the chain capture's
// captureOptionQuoteBatch.ts and the Day Signals loop's daySignalsQuoteWindow.ts).
// Measurement only: nothing here changes what a window subscribes or when.
//
// A line counts as "subscribed" from our reqMktData call to our cancelMktData
// call, and as "answered" from IBKR's first tick for it to the cancel. The gap
// between the two is time the request spent before IBKR replied — our own
// outgoing message limiter's queue (maxReqPerSec), the network and IBKR's
// response time together. Averages are integrated over time, so a period's
// figure covers exactly that period whichever period a contract ends in.

/** Pure: nearest-rank percentile of an ascending list; null when empty. */
export function percentileOfSorted(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1))]!;
}

export interface LineUsageSummary {
  periodMs: number;
  /** Time-weighted average of lines subscribed (our reqMktData sent, cancel not yet sent). */
  averageSubscribed: number;
  /** Time-weighted average of lines IBKR had answered at least once. */
  averageAnswered: number;
  /** reqMktData + cancelMktData calls per second (each is one IBKR message). */
  messagesPerSecond: number;
  /** Lines released in the period. */
  released: number;
  /** Of those, released without any tick from IBKR. */
  releasedUnanswered: number;
  /** Subscribe → IBKR's first tick, for released lines that got one. */
  firstReplyMsP50: number | null;
  firstReplyMsP90: number | null;
  /** Subscribe → release, every released line. */
  holdMsP50: number | null;
  holdMsP90: number | null;
}

export interface LineUsageMeter {
  subscribed(requestId: number): void;
  /** Any tick for the request; only the first one counts. */
  answered(requestId: number): void;
  released(requestId: number): void;
  /** The period since the previous drain (or since the meter started), then starts a new one. */
  drain(): LineUsageSummary;
  /** Everything since the meter started. */
  wholeRun(): LineUsageSummary;
}

interface Accumulator {
  startedAt: number;
  subscribedLineMs: number;
  answeredLineMs: number;
  messages: number;
  released: number;
  releasedUnanswered: number;
  firstReplyMs: number[];
  holdMs: number[];
}

export function createLineUsageMeter(now: () => number = Date.now): LineUsageMeter {
  const open = new Map<number, { subscribedAt: number; firstReplyAt: number | null }>();
  let answeredCount = 0;
  let lastChangeAt = now();
  const freshAccumulator = (): Accumulator => ({ startedAt: now(), subscribedLineMs: 0, answeredLineMs: 0, messages: 0, released: 0, releasedUnanswered: 0, firstReplyMs: [], holdMs: [] });
  let period = freshAccumulator();
  const whole = freshAccumulator();

  // Adds the line-time since the last change at the counts that held until now.
  function advance(): number {
    const at = now();
    const elapsed = at - lastChangeAt;
    for (const accumulator of [period, whole]) {
      accumulator.subscribedLineMs += open.size * elapsed;
      accumulator.answeredLineMs += answeredCount * elapsed;
    }
    lastChangeAt = at;
    return at;
  }

  function summarize(accumulator: Accumulator): LineUsageSummary {
    const periodMs = now() - accumulator.startedAt;
    const firstReplies = [...accumulator.firstReplyMs].sort((a, b) => a - b);
    const holds = [...accumulator.holdMs].sort((a, b) => a - b);
    return {
      periodMs,
      averageSubscribed: periodMs > 0 ? accumulator.subscribedLineMs / periodMs : 0,
      averageAnswered: periodMs > 0 ? accumulator.answeredLineMs / periodMs : 0,
      messagesPerSecond: periodMs > 0 ? (accumulator.messages * 1000) / periodMs : 0,
      released: accumulator.released,
      releasedUnanswered: accumulator.releasedUnanswered,
      firstReplyMsP50: percentileOfSorted(firstReplies, 50),
      firstReplyMsP90: percentileOfSorted(firstReplies, 90),
      holdMsP50: percentileOfSorted(holds, 50),
      holdMsP90: percentileOfSorted(holds, 90),
    };
  }

  return {
    subscribed(requestId) {
      const at = advance();
      open.set(requestId, { subscribedAt: at, firstReplyAt: null });
      period.messages += 1;
      whole.messages += 1;
    },
    answered(requestId) {
      const line = open.get(requestId);
      if (!line || line.firstReplyAt !== null) return;
      line.firstReplyAt = advance();
      answeredCount += 1;
    },
    released(requestId) {
      const line = open.get(requestId);
      if (!line) return;
      const at = advance();
      open.delete(requestId);
      if (line.firstReplyAt !== null) answeredCount -= 1;
      for (const accumulator of [period, whole]) {
        accumulator.messages += 1;
        accumulator.released += 1;
        accumulator.holdMs.push(at - line.subscribedAt);
        if (line.firstReplyAt === null) accumulator.releasedUnanswered += 1;
        else accumulator.firstReplyMs.push(line.firstReplyAt - line.subscribedAt);
      }
    },
    drain() {
      advance();
      const summary = summarize(period);
      period = freshAccumulator();
      return summary;
    },
    wholeRun() {
      advance();
      return summarize(whole);
    },
  };
}

/** One log fragment for a summary, e.g. "subscribed avg 49.6, answered avg 21.0, 19.8 msg/s, first reply p50 2.9s p90 3.4s (0 never answered of 98)". */
export function describeLineUsage(summary: LineUsageSummary): string {
  const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  return (
    `subscribed avg ${summary.averageSubscribed.toFixed(1)}, answered avg ${summary.averageAnswered.toFixed(1)}, ${summary.messagesPerSecond.toFixed(1)} msg/s, ` +
    `first reply p50 ${seconds(summary.firstReplyMsP50)} p90 ${seconds(summary.firstReplyMsP90)} (${summary.releasedUnanswered} never answered of ${summary.released})`
  );
}
