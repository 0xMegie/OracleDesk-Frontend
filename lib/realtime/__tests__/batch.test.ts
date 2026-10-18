import { describe, expect, it, vi } from "vitest";
import { createBatcher } from "../batch";
import { Ring } from "../ring";
import { reduceFeed } from "../burst";

function scheduler() {
  const callbacks: (() => void)[] = [];
  return { callbacks, schedule: (cb: () => void) => { callbacks.push(cb); return callbacks.length; }, cancel: vi.fn(), flush: () => callbacks.splice(0).forEach(cb => cb()) };
}
describe("bounded realtime delivery", () => {
  it("coalesces 500 events into one notification per frame", () => {
    const s = scheduler(), batcher = createBatcher<number>(s), listener = vi.fn();
    batcher.subscribe(listener);
    for (let i = 0; i < 500; i++) batcher.push(i);
    expect(s.callbacks).toHaveLength(1); expect(listener).not.toHaveBeenCalled();
    s.flush(); expect(listener).toHaveBeenCalledTimes(1); expect(listener.mock.calls[0][0]).toHaveLength(500);
  });
  it("pauses delivery, keeps the newest bounded backlog, and reports overflow on resume", () => {
    const s = scheduler(), batcher = createBatcher<number>({ ...s, maxBatch: 3 }), listener = vi.fn();
    batcher.subscribe(listener); batcher.push(0); batcher.setPaused(true);
    [1, 2, 3, 4].forEach(batcher.push); s.flush(); expect(listener).not.toHaveBeenCalled();
    batcher.setPaused(false); s.flush();
    const batch = listener.mock.calls[0][0];
    expect([...batch]).toEqual([2, 3, 4]); expect(batch.overflow).toBe(2); expect(batch.resumed).toBe(true);
  });
  it("dispose cancels scheduled work and subscriptions can be removed", () => {
    const s = scheduler(), batcher = createBatcher<number>(s), listener = vi.fn();
    const stop = batcher.subscribe(listener); batcher.push(1); stop(); batcher.dispose(); s.flush();
    expect(listener).not.toHaveBeenCalled(); expect(s.cancel).toHaveBeenCalled();
  });
});
describe("immutable rings and burst reducer", () => {
  it("keeps the newest capacity, dedupes by stable key and preserves the old version", () => {
    const ring = new Ring<number>(3, String);
    const next = ring.pushMany([1, 2, 3, 2, 4]);
    expect(next.toArray()).toEqual([4, 2, 3]); expect(ring.toArray()).toEqual([]);
    expect(next.toArray()).toBe(next.toArray()); expect(next.pushMany([])).toBe(next);
  });
  it("summarises bursts and resumed batches, leaving normal batches unflagged", () => {
    const state = { ring: new Ring<number>(6, String), burst: null };
    const batch = (values: number[], resumed = false) => Object.assign(values, { overflow: 0, resumed });
    expect(reduceFeed(state, batch([1, 2]), 10).burst).toBeNull();
    expect(reduceFeed(state, batch(Array.from({ length: 42 }, (_, i) => i)), 10, 100).burst).toMatchObject({ count: 42, at: 100 });
    expect(reduceFeed(state, batch([1], true), 10).burst?.resumed).toBe(true);
  });
  it("summarises sustained activity across frames and clears after a quiet second", () => {
    const batch = (values: number[]) => Object.assign(values, { overflow: 0, resumed: false });
    const first = reduceFeed({ ring: new Ring<number>(6, String), burst: null }, batch([1, 2, 3, 4, 5, 6]), 10, 100);
    const next = reduceFeed(first, batch([7, 8, 9, 10, 11]), 10, 200);
    expect(next.burst?.count).toBe(11);
    expect(reduceFeed(next, batch([12]), 10, 1300).burst).toBeNull();
  });
});
