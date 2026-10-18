import { describe, expect, it } from "vitest";
import { createBatcher } from "../batch";

function fakeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    },
    frame: () => queue.splice(0).forEach((cb) => cb()),
    pending: () => queue.length,
  };
}

describe("createBatcher", () => {
  it("coalesces events pushed in one frame into one batch", () => {
    const s = fakeScheduler();
    const b = createBatcher<number>({ schedule: s.schedule });
    const batches: number[][] = [];
    b.subscribe((batch) => batches.push([...batch]));
    b.push(1);
    b.push(2);
    b.push(3);
    expect(s.pending()).toBe(1);
    s.frame();
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it("delivers nothing while paused and one batch on resume", () => {
    const s = fakeScheduler();
    const b = createBatcher<number>({ schedule: s.schedule });
    const metas: Array<{ batch: number[]; resumed: boolean }> = [];
    b.subscribe((batch, meta) => metas.push({ batch: [...batch], resumed: meta.resumed }));
    b.setPaused(true);
    b.push(1);
    b.push(2);
    s.frame();
    expect(metas).toEqual([]);
    b.setPaused(false);
    expect(metas).toEqual([{ batch: [1, 2], resumed: true }]);
  });

  it("caps a paused backlog at maxBatch and reports overflow", () => {
    const s = fakeScheduler();
    const b = createBatcher<number>({ schedule: s.schedule, maxBatch: 3 });
    const seen: Array<{ n: number; overflow: number }> = [];
    b.subscribe((batch, meta) => seen.push({ n: batch.length, overflow: meta.overflow }));
    b.setPaused(true);
    for (let i = 0; i < 10; i++) b.push(i);
    b.setPaused(false);
    expect(seen).toEqual([{ n: 3, overflow: 7 }]);
  });

  it("dispose cancels a scheduled flush", () => {
    const s = fakeScheduler();
    const b = createBatcher<number>({ schedule: s.schedule });
    const batches: number[][] = [];
    b.subscribe((batch) => batches.push([...batch]));
    b.push(1);
    b.dispose();
    s.frame();
    expect(batches).toEqual([]);
  });
});
