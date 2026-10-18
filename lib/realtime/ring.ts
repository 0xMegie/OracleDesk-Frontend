/** Newest first, immutable on write. One cached array per version. */
export class Ring<T> {
  constructor(readonly capacity: number, private readonly key: (item: T) => string, private readonly items: readonly T[] = []) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid ring capacity");
  }
  pushMany(incoming: readonly T[]): Ring<T> {
    if (!incoming.length) return this;
    const seen = new Set<string>();
    const next = [...incoming].reverse().concat([...this.items]).filter(item => {
      const id = this.key(item);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    }).slice(0, this.capacity);
    if (next.length === this.items.length && next.every((item, i) => item === this.items[i])) return this;
    return new Ring(this.capacity, this.key, next);
  }
  toArray(): readonly T[] { return this.items; }
}
