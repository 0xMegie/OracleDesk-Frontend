"use client";

import { useCallback, useState } from "react";
import { useRealtimeBatch, type RealtimeEventName, type RealtimeEvents } from "./RealtimeProvider";
import { initialBurstState, reduceBatch, type BurstState } from "./burst";

/**
 * A bounded, stable-keyed feed for one realtime event. Batches above
 * `burstThreshold` set `burst` so the UI can show one summary line instead
 * of animating every row (issue #41).
 */
export function useBurstFeed<K extends RealtimeEventName, T>(
  eventName: K,
  opts: {
    capacity: number;
    burstThreshold?: number;
    toRow: (e: RealtimeEvents[K]) => T | null;
    key: (row: T) => string;
  },
): {
  rows: readonly T[];
  burst: BurstState<T>["burst"];
  hiddenOverflow: number;
  instantKey: number;
} {
  const { capacity, key, toRow } = opts;
  const burstThreshold = opts.burstThreshold ?? 10;
  const [state, setState] = useState(() => initialBurstState<T>(capacity, key));

  const onBatch = useCallback(
    (batch: readonly RealtimeEvents[K][], meta: { overflow: number; resumed: boolean }) => {
      const rows: T[] = [];
      for (const e of batch) {
        const row = toRow(e);
        if (row !== null) rows.push(row);
      }
      if (rows.length === 0 && meta.overflow === 0) return;
      setState((prev) => reduceBatch(prev, rows, meta, { burstThreshold, now: Date.now() }));
    },
    [toRow, burstThreshold],
  );
  useRealtimeBatch(eventName, onBatch);

  return { rows: state.ring.toArray(), burst: state.burst, hiddenOverflow: state.hiddenOverflow, instantKey: state.instantKey };
}
