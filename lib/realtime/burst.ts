import { Ring } from "./ring";
import type { Batch } from "./batch";

export interface FeedState<T> {
  ring: Ring<T>;
  recent?: readonly { at: number; count: number }[];
  burst: { count: number; at: number; overflow: number; resumed: boolean } | null;
}
export function reduceFeed<T>(state: FeedState<T>, batch: Batch<T>, threshold = 10, now = Date.now()): FeedState<T> {
  // Count a rolling second, so a steady stream across many small frames also
  // suspends row animations. Bucket by flush, with a hard bound for custom clocks.
  const recent = [...(state.recent ?? []).filter(bucket => bucket.at > now - 1000),
    { at: now, count: batch.length + batch.overflow }].slice(-500);
  const count = recent.reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    ring: state.ring.pushMany(batch),
    recent,
    burst: count > threshold || batch.resumed
      ? { count, at: now, overflow: batch.overflow, resumed: batch.resumed } : null,
  };
}
