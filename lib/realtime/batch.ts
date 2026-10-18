/**
 * Per-frame event batching between the socket and React (issue #41).
 * Framework-free so it is unit-testable in node.
 */

export interface Batcher<E> {
  push(e: E): void;
  subscribe(fn: (batch: readonly E[], meta: BatchMeta) => void): () => void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

export interface BatchMeta {
  /** Events dropped because the pending batch hit maxBatch. */
  overflow: number;
  /** True when this batch is the catch-up flush after a pause. */
  resumed: boolean;
}

type Schedule = (cb: () => void) => unknown;
type Cancel = (handle: unknown) => void;

const defaultSchedule: Schedule = (cb) =>
  typeof requestAnimationFrame === "function" ? { raf: requestAnimationFrame(cb) } : { t: setTimeout(cb, 16) };

const defaultCancel: Cancel = (h) => {
  const handle = h as { raf?: number; t?: ReturnType<typeof setTimeout> };
  if (handle.raf !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle.raf);
  if (handle.t !== undefined) clearTimeout(handle.t);
};

export function createBatcher<E>(opts: { schedule?: Schedule; cancel?: Cancel; maxBatch?: number } = {}): Batcher<E> {
  const schedule = opts.schedule ?? defaultSchedule;
  const cancel = opts.cancel ?? (opts.schedule ? () => {} : defaultCancel);
  const maxBatch = opts.maxBatch ?? 500;
  const subscribers = new Set<(batch: readonly E[], meta: BatchMeta) => void>();
  let pending: E[] = [];
  let overflow = 0;
  let paused = false;
  let resumed = false;
  let handle: unknown = null;
  let cancelled = false;
  let disposed = false;

  const flush = () => {
    handle = null;
    if (cancelled || disposed || paused || pending.length === 0) return;
    const batch = pending;
    const meta: BatchMeta = { overflow, resumed };
    pending = [];
    overflow = 0;
    resumed = false;
    for (const fn of subscribers) fn(batch, meta);
  };

  const ensureScheduled = () => {
    // rAF does not fire in hidden tabs, so never schedule while paused.
    if (handle !== null || paused || disposed) return;
    cancelled = false;
    handle = schedule(flush);
  };

  return {
    push(e) {
      if (disposed) return;
      if (pending.length >= maxBatch) overflow++;
      else pending.push(e);
      ensureScheduled();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      if (paused) {
        if (handle !== null) {
          cancel(handle);
          cancelled = true;
          handle = null;
        }
        return;
      }
      if (pending.length > 0) {
        resumed = true;
        flush();
      }
    },
    dispose() {
      disposed = true;
      if (handle !== null) {
        cancel(handle);
        cancelled = true;
        handle = null;
      }
      pending = [];
      subscribers.clear();
    },
  };
}
