/**
 * Fixed-capacity, newest-first ring with stable keys (issue #41).
 * Immutable on write: pushMany returns a new Ring (or the same one when
 * nothing changed) so React state comparisons stay cheap.
 */
export class Ring<T> {
  private readonly items: readonly T[];
  readonly version: number;

  constructor(
    readonly capacity: number,
    private readonly keyOf: (item: T) => string,
    items: readonly T[] = [],
    version = 0,
  ) {
    this.items = items;
    this.version = version;
  }

  /** Items are given newest first. Duplicates (by key) are dropped. */
  pushMany(incoming: readonly T[]): Ring<T> {
    if (incoming.length === 0) return this;
    const seen = new Set(this.items.map(this.keyOf));
    const fresh: T[] = [];
    for (const item of incoming) {
      const k = this.keyOf(item);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(item);
    }
    if (fresh.length === 0) return this;
    const next = [...fresh, ...this.items].slice(0, this.capacity);
    return new Ring(this.capacity, this.keyOf, next, this.version + 1);
  }

  clear(): Ring<T> {
    return this.items.length === 0 ? this : new Ring(this.capacity, this.keyOf, [], this.version + 1);
  }

  toArray(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }
}
