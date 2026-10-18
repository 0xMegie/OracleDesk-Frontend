import { Ring } from "./ring";
import type { BatchMeta } from "./batch";

/** Pure reducer behind useBurstFeed (issue #41). */
export interface BurstState<T> {
  ring: Ring<T>;
  burst: { count: number; at: number } | null;
  /** Events dropped while the tab was hidden. */
  hiddenOverflow: number;
  /** Bumped when a batch should render without per-row animation. */
  instantKey: number;
}

export function initialBurstState<T>(capacity: number, key: (row: T) => string): BurstState<T> {
  return { ring: new Ring<T>(capacity, key), burst: null, hiddenOverflow: 0, instantKey: 0 };
}

export function reduceBatch<T>(
  state: BurstState<T>,
  rows: readonly T[],
  meta: BatchMeta,
  opts: { burstThreshold: number; now: number },
): BurstState<T> {
  // Batches arrive oldest first; the ring is newest first.
  const ring = state.ring.pushMany([...rows].reverse());
  const isBurst = rows.length + meta.overflow > opts.burstThreshold;
  return {
    ring,
    burst: isBurst ? { count: rows.length + meta.overflow, at: opts.now } : null,
    hiddenOverflow: meta.resumed ? meta.overflow : 0,
    instantKey: isBurst || meta.resumed ? state.instantKey + 1 : state.instantKey,
  };
}
