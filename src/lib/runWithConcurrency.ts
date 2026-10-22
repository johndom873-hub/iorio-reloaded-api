/**
 * Runs `handle` over every item with at most `workerCount` in flight, each worker taking the next item as soon as
 * it finishes one. `handle` is expected to catch its own errors: a throw rejects the returned promise while the
 * other workers carry on with the remaining items.
 */
export async function runWithConcurrency<T>(items: readonly T[], workerCount: number, handle: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) await handle(items[nextIndex++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workerCount, items.length)) }, worker));
}
