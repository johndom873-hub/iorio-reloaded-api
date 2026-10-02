/** Resolves after `ms`, or as soon as `signal` aborts (immediately if it already has). Never rejects. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
