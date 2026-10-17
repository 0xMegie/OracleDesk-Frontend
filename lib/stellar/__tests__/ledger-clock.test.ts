import { describe, expect, it, vi } from "vitest";
import { LedgerClock } from "../ledger-clock";

describe("LedgerClock", () => {
  it("estimates from monotonic elapsed time, not wall-clock time", async () => {
    vi.useFakeTimers();
    let monotonic = 10;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const clock = new LedgerClock(async () => ({ sequence: 1, closeTime: 100 }));
    const stop = clock.subscribe(() => undefined);
    await Promise.resolve();
    expect(clock.now()).toBe(100);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    monotonic += 2_500;
    expect(clock.now()).toBe(102.5);
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns null before a sample and ignores backwards samples", async () => {
    let sample = { sequence: 10, closeTime: 100 };
    const clock = new LedgerClock(async () => sample);
    expect(clock.now()).toBeNull();
    const stop = clock.subscribe(() => undefined);
    await Promise.resolve();
    expect(clock.now()).toBe(100);
    sample = { sequence: 9, closeTime: 99 };
    await (clock as unknown as { sample(): Promise<void> }).sample();
    expect(clock.now()).toBe(100);
    stop();
  });
});
