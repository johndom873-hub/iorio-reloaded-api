/**
 * Wraps an async callback so repeated calls run strictly one at a time, in
 * the order they were invoked, even if the caller doesn't wait for each
 * call's promise before firing the next one. Found 2026-09-09: the SSE
 * routes' onUpdate callbacks passed to streamLiveGreeks/streamLivePrices do
 * real async work (a DB fallback lookup) on their first invocation —
 * streamLiveGreeks/streamLivePrices call onUpdate synchronously without
 * awaiting it, so a later, still-incomplete update could race ahead of an
 * earlier one still awaiting its DB query and get written to the SSE
 * response first, making a value that had already arrived appear to
 * regress to null on the client. Serializing eliminates the race outright
 * — every call fully finishes (including whatever it sends) before the
 * next one starts.
 */
export function serializeAsyncCalls<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  let queue: Promise<void> = Promise.resolve();
  return (...args: Args) => {
    queue = queue.then(() => fn(...args)).catch((error) => console.error("serializeAsyncCalls: callback failed", error));
  };
}
