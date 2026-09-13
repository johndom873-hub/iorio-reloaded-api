// Rolling in-memory stats for Iorio Pulse's LLM node — how often Genosuke
// calls OpenRouter and how long each call takes. Memory-only and
// approximate by design (same non-persistence choice as presenceTracker.ts):
// this is a dashboard decoration, not a billing/observability system, so a
// dyno restart just resets the window rather than needing a table.
const windowMs = 15 * 60_000;

interface Call {
  timestamp: number;
  durationMs: number;
}

let calls: Call[] = [];

export function record(durationMs: number): void {
  const now = Date.now();
  calls.push({ timestamp: now, durationMs });
  calls = calls.filter((call) => now - call.timestamp <= windowMs);
}

export function stats(): { callsPerMinute: number; avgLatencyMs: number | null } {
  const now = Date.now();
  const recent = calls.filter((call) => now - call.timestamp <= windowMs);
  if (recent.length === 0) return { callsPerMinute: 0, avgLatencyMs: null };

  const avgLatencyMs = recent.reduce((sum, call) => sum + call.durationMs, 0) / recent.length;
  const callsPerMinute = recent.length / (windowMs / 60_000);
  return { callsPerMinute: Math.round(callsPerMinute * 10) / 10, avgLatencyMs: Math.round(avgLatencyMs) };
}
