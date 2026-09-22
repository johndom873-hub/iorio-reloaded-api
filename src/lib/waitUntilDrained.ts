// Generic "wait for in-flight work to finish, but not forever" helper — used by the worker's
// SIGTERM handler (drain in-flight order handling / reconciliation before exiting for a deploy
// or restart), kept here as a pure function so the polling/timeout logic is unit-testable without
// spinning up the whole worker.
export interface DrainResult {
  /** True if isDrained() became true within maxWaitMs; false if the timeout was hit first. */
  drained: boolean;
  elapsedMs: number;
}

export function waitUntilDrained(isDrained: () => boolean, maxWaitMs: number, pollIntervalMs: number, now: () => number = Date.now): Promise<DrainResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    const check = () => {
      if (isDrained()) {
        resolve({ drained: true, elapsedMs: now() - startedAt });
        return;
      }
      if (now() - startedAt >= maxWaitMs) {
        resolve({ drained: false, elapsedMs: now() - startedAt });
        return;
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}
