/**
 * An in-process cache of one async load per key, kept for `ttlMs` after it resolves. Callers asking for a key while
 * its load is still running share that load, so concurrent requests make one upstream call.
 *
 * Memory stays bounded: each resolved entry is deleted by its own timer when its time is up (not on the next read),
 * a rejected load is deleted at once, and when `maxEntries` is reached the oldest entry is dropped before a new one
 * is added. Timers are unref'd so they never keep the process alive.
 */
export interface ExpiringPromiseCache<Value> {
  get(key: string, load: () => Promise<Value>): Promise<Value>;
  size(): number;
  clear(): void;
}

interface CacheEntry<Value> {
  promise: Promise<Value>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

export function createExpiringPromiseCache<Value>({ ttlMs, maxEntries }: { ttlMs: number; maxEntries: number }): ExpiringPromiseCache<Value> {
  const entriesByKey = new Map<string, CacheEntry<Value>>();

  function remove(key: string, entry: CacheEntry<Value>): void {
    if (entriesByKey.get(key) !== entry) return;
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entriesByKey.delete(key);
  }

  function get(key: string, load: () => Promise<Value>): Promise<Value> {
    const existing = entriesByKey.get(key);
    if (existing) return existing.promise;

    while (entriesByKey.size >= maxEntries) {
      const oldestKey = entriesByKey.keys().next().value as string;
      remove(oldestKey, entriesByKey.get(oldestKey)!);
    }

    const entry: CacheEntry<Value> = { promise: Promise.resolve().then(load), expiryTimer: null };
    entriesByKey.set(key, entry);
    entry.promise.then(
      () => {
        if (entriesByKey.get(key) !== entry) return;
        entry.expiryTimer = setTimeout(() => remove(key, entry), ttlMs);
        entry.expiryTimer.unref?.();
      },
      () => remove(key, entry),
    );
    return entry.promise;
  }

  function clear(): void {
    for (const [key, entry] of [...entriesByKey]) remove(key, entry);
  }

  return { get, size: () => entriesByKey.size, clear };
}
