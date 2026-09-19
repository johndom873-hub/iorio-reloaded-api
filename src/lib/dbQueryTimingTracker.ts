import type { Knex } from "knex";

// Rolling query-latency stats for Iorio Pulse's Database node. Times every
// query the web dyno runs through knex (start on "query", stop on
// "query-response"/"query-error"). Memory-only per dyno process, same
// non-persistence choice as requestRateTracker.ts/llmStats.ts: a dashboard
// decoration, not a metrics pipeline. Covers only this process's queries —
// the VPS worker's own queries aren't included.
const windowMs = 5 * 60_000;
// Safety bound on memory only; a 5-minute window normally holds far fewer.
const maxSamples = 10_000;

interface QuerySample {
  finishedAtMs: number;
  durationMs: number;
}

let samples: QuerySample[] = [];
const startedAtByQueryUid = new Map<string, number>();

interface KnexQueryEvent {
  __knexQueryUid: string;
}

export function installDbQueryTimingTracker(knexInstance: Knex): void {
  const recordFinished = (query: KnexQueryEvent) => {
    const startedAtMs = startedAtByQueryUid.get(query.__knexQueryUid);
    if (startedAtMs === undefined) return;
    startedAtByQueryUid.delete(query.__knexQueryUid);
    samples.push({ finishedAtMs: Date.now(), durationMs: performance.now() - startedAtMs });
    if (samples.length > maxSamples) samples = samples.slice(-maxSamples);
  };

  knexInstance.on("query", (query: KnexQueryEvent) => {
    startedAtByQueryUid.set(query.__knexQueryUid, performance.now());
  });
  knexInstance.on("query-response", (_response: unknown, query: KnexQueryEvent) => recordFinished(query));
  knexInstance.on("query-error", (_error: unknown, query: KnexQueryEvent) => recordFinished(query));
}

export function dbQueryTimingStats(): { averageMs: number | null; slowestMs: number | null } {
  const cutoffMs = Date.now() - windowMs;
  samples = samples.filter((sample) => sample.finishedAtMs >= cutoffMs);
  if (samples.length === 0) return { averageMs: null, slowestMs: null };
  const totalMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
  return { averageMs: totalMs / samples.length, slowestMs: Math.max(...samples.map((sample) => sample.durationMs)) };
}
