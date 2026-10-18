import { describe, expect, it } from "vitest";
import { initialBurstState, reduceBatch } from "../burst";

const key = (x: { id: string }) => x.id;
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

describe("reduceBatch", () => {
  it("flags a burst above the threshold", () => {
    const s = reduceBatch(initialBurstState(8, key), rows(42), { overflow: 0, resumed: false }, { burstThreshold: 10, now: 1 });
    expect(s.burst).toEqual({ count: 42, at: 1 });
    expect(s.ring.size).toBe(8);
    expect(s.instantKey).toBe(1);
  });

  it("does not flag normal batches", () => {
    const s = reduceBatch(initialBurstState(8, key), rows(3), { overflow: 0, resumed: false }, { burstThreshold: 10, now: 1 });
    expect(s.burst).toBeNull();
    expect(s.instantKey).toBe(0);
    // Newest (last in the batch) first.
    expect(s.ring.toArray()[0].id).toBe("2");
  });

  it("reports overflow from a hidden-tab catch-up", () => {
    const s = reduceBatch(initialBurstState(8, key), rows(5), { overflow: 12, resumed: true }, { burstThreshold: 100, now: 1 });
    expect(s.hiddenOverflow).toBe(12);
  });
});
