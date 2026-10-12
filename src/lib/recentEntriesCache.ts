/**
 * A bounded cache that keeps the most recent entries: when the current generation reaches its limit it becomes the
 * previous one (the one before is dropped), so between `limit` and 2 × `limit` of the latest entries stay. An entry
 * found in the previous generation moves to the current one. Holds at most 2 × `limit` entries.
 */
export class RecentEntriesCache<Key, Value> {
  private current = new Map<Key, Value>();
  private previous = new Map<Key, Value>();

  constructor(private readonly limit: number) {
    if (!(limit >= 1)) throw new RangeError(`A cache limit must be at least 1, got ${limit}`);
  }

  has(key: Key): boolean {
    return this.current.has(key) || this.previous.has(key);
  }

  /** The value kept for the key; undefined when none is (a cached undefined reads the same: use has() to tell). */
  get(key: Key): Value | undefined {
    if (this.current.has(key)) return this.current.get(key);
    if (!this.previous.has(key)) return undefined;
    const value = this.previous.get(key)!;
    this.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    if (!this.current.has(key) && this.current.size >= this.limit) {
      this.previous = this.current;
      this.current = new Map();
    }
    this.current.set(key, value);
  }
}
