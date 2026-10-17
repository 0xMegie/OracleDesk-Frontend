import { describe, expect, it, vi } from "vitest";
import { SubmitQueue } from "../submit-queue";

const job = (id: string, address: string, run: (attempt: 0 | 1) => Promise<string>) => ({
  id,
  address,
  label: id,
  run: ({ attempt }: { attempt: 0 | 1 }) => run(attempt),
});

describe("SubmitQueue", () => {
  it("runs jobs for the same address sequentially", async () => {
    const queue = new SubmitQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue(job("first", "G1", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first-end");
      return "1";
    }));
    const second = queue.enqueue(job("second", "G1", async () => {
      order.push("second-start");
      return "2";
    }));

    expect(queue.getState("G1").waiting).toEqual([{ id: "second", label: "second" }]);
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["1", "2"]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("runs different accounts concurrently", async () => {
    const queue = new SubmitQueue();
    let release!: () => void;
    const first = queue.enqueue(job("first", "G1", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return "1";
    }));
    const second = queue.enqueue(job("second", "G2", async () => "2"));
    await expect(second).resolves.toBe("2");
    release();
    await expect(first).resolves.toBe("1");
  });

  it("retries txBadSeq exactly once with attempt 1", async () => {
    const queue = new SubmitQueue();
    const attempts: number[] = [];
    const run = vi.fn(async (attempt: 0 | 1) => {
      attempts.push(attempt);
      if (attempt === 0) throw new Error("txBadSeq");
      return "sent";
    });
    await expect(queue.enqueue(job("buy", "G1", run))).resolves.toBe("sent");
    expect(attempts).toEqual([0, 1]);
  });

  it("does not retry a second stale sequence failure", async () => {
    const queue = new SubmitQueue();
    const run = vi.fn(async () => {
      throw new Error("txBadSeq");
    });
    await expect(queue.enqueue(job("buy", "G1", run))).rejects.toThrow("txBadSeq");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("deduplicates identical submissions within one second", async () => {
    const queue = new SubmitQueue();
    const run = vi.fn(async () => "sent");
    const first = queue.enqueue({ ...job("first", "G1", run), dedupeKey: "buy:4:Yes:10" });
    const second = queue.enqueue({ ...job("second", "G1", run), dedupeKey: "buy:4:Yes:10" });
    await expect(Promise.all([first, second])).resolves.toEqual(["sent", "sent"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels waiting jobs but leaves a running job alone", async () => {
    const queue = new SubmitQueue();
    let release!: () => void;
    const running = queue.enqueue(job("running", "G1", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return "done";
    }));
    const waiting = queue.enqueue(job("waiting", "G1", async () => "not run"));
    await vi.waitFor(() => expect(queue.getState("G1").running?.id).toBe("running"));
    expect(queue.cancel("running")).toBe(false);
    expect(queue.cancel("waiting")).toBe(true);
    await expect(waiting).rejects.toThrow(/cancelled/i);
    release();
    await expect(running).resolves.toBe("done");
  });
});
