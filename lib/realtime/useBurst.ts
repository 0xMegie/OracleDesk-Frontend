"use client";
import { useState } from "react";
import { Ring } from "./ring";
import { reduceFeed, type FeedState } from "./burst";
import { useRealtimeBatch } from "./RealtimeProvider";
import { eventKey, type RealtimeEvent } from "./types";

export function useBurstFeed(opts: { capacity: number; burstThreshold?: number; type?: RealtimeEvent["type"] }) {
  const [state, setState] = useState<FeedState<RealtimeEvent>>(() => ({ ring: new Ring(opts.capacity, eventKey), burst: null }));
  useRealtimeBatch(batch => {
    const selected = batch.filter(event => !opts.type || event.type === opts.type);
    if (!selected.length && !batch.overflow) return;
    const filtered = Object.assign(selected, { overflow: batch.overflow, resumed: batch.resumed });
    setState(previous => reduceFeed(previous, filtered, opts.burstThreshold));
  });
  return { rows: state.ring.toArray(), burst: state.burst };
}
