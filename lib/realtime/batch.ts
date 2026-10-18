export type Batch<E> = readonly E[] & { readonly overflow: number; readonly resumed: boolean };

export function createBatcher<E>(opts: {
  schedule?: (cb: () => void) => unknown;
  cancel?: (handle: unknown) => void;
  maxBatch?: number;
} = {}) {
  const capacity = opts.maxBatch ?? 500;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid batch capacity");
  const schedule = opts.schedule ?? ((cb: () => void) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16));
  const cancel = opts.cancel ?? ((handle: unknown) => typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle as number) : clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<(batch: Batch<E>) => void>();
  let pending: E[] = [], overflow = 0, paused = false, disposed = false, scheduled = false, resumed = false;
  let handle: unknown;
  let generation = 0;
  function enqueue() {
    if (paused || disposed || scheduled || (!pending.length && !overflow)) return;
    scheduled = true;
    const token = generation;
    handle = schedule(() => {
      if (token !== generation || disposed || paused) return;
      scheduled = false;
      const batch = Object.assign(pending, { overflow, resumed }) as Batch<E>;
      pending = []; overflow = 0; resumed = false;
      for (const fn of listeners) fn(batch);
    });
  }
  return {
    push(event: E) {
      if (disposed) return;
      if (pending.length === capacity) { pending.shift(); overflow++; }
      pending.push(event);
      enqueue();
    },
    subscribe(fn: (batch: Batch<E>) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setPaused(value: boolean) {
      if (paused === value) return;
      paused = value;
      if (paused) {
        generation++; cancel(handle); scheduled = false;
      } else { resumed = true; enqueue(); }
    },
    dispose() { disposed = true; generation++; cancel(handle); pending = []; listeners.clear(); },
  };
}
