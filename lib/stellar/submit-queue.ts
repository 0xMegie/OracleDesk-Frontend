"use client";

import { useSyncExternalStore } from "react";
import { classifySequenceError } from "./errors";

const LOCK_PREFIX = "oracledesk-submit:";
const LEASE_MS = 10_000;
const HEARTBEAT_MS = 2_000;

export interface QueueRunContext {
  attempt: 0 | 1;
  signal: AbortSignal;
}

export interface QueueJob<T> {
  id: string;
  address: string;
  label: string;
  /** Same address + key requests within one second share the original promise. */
  dedupeKey?: string;
  run(context: QueueRunContext): Promise<T>;
}

export interface QueueEntryView {
  id: string;
  label: string;
}

export interface QueueState {
  address: string;
  running: QueueEntryView | null;
  waiting: QueueEntryView[];
  lockWaiting: boolean;
}

interface QueuedJob<T = unknown> {
  job: QueueJob<T>;
  controller: AbortController;
  resolve(value: T): void;
  reject(reason: unknown): void;
  cancelled: boolean;
  promise: Promise<T>;
}

interface LeaseRecord {
  owner: string;
  expiresAt: number;
}

const EMPTY_STATES = new Map<string, QueueState>();
const EMPTY_STATE = (address: string): QueueState => {
  let state = EMPTY_STATES.get(address);
  if (!state) {
    state = { address, running: null, waiting: [], lockWaiting: false };
    EMPTY_STATES.set(address, state);
  }
  return state;
};

function makeTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The queued transaction was cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The queued transaction was cancelled.", "AbortError"));
      },
      { once: true },
    );
  });
}

async function withBrowserLock<T>(
  address: string,
  signal: AbortSignal,
  run: () => Promise<T>,
  onWaiting: (waiting: boolean) => void,
): Promise<T> {
  if (typeof navigator === "undefined") return run();

  if (navigator.locks) {
    onWaiting(true);
    try {
      return await navigator.locks.request(
        `${LOCK_PREFIX}${address}`,
        { mode: "exclusive", signal },
        async () => {
          onWaiting(false);
          return run();
        },
      );
    } finally {
      onWaiting(false);
    }
  }

  return withLease(address, signal, run, onWaiting);
}

/**
 * Best-effort fallback for browsers without Web Locks. localStorage provides
 * the lease, while BroadcastChannel lets other tabs observe its heartbeat.
 */
async function withLease<T>(
  address: string,
  signal: AbortSignal,
  run: () => Promise<T>,
  onWaiting: (waiting: boolean) => void,
): Promise<T> {
  if (typeof localStorage === "undefined") return run();

  const tabId = getTabId();
  const key = `${LOCK_PREFIX}${address}`;
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("oracledesk-submit");
  const readLease = (): LeaseRecord | null => {
    try {
      const value = localStorage.getItem(key);
      return value ? (JSON.parse(value) as LeaseRecord) : null;
    } catch {
      return null;
    }
  };
  const writeLease = () => {
    const lease = { owner: tabId, expiresAt: Date.now() + LEASE_MS };
    localStorage.setItem(key, JSON.stringify(lease));
    channel?.postMessage({ address, ...lease });
    return readLease()?.owner === tabId;
  };

  try {
    onWaiting(true);
    while (!signal.aborted) {
      const current = readLease();
      if (!current || current.expiresAt <= Date.now()) {
        if (writeLease()) break;
      }
      await sleep(200, signal);
    }
    if (signal.aborted) throw new DOMException("The queued transaction was cancelled.", "AbortError");
    onWaiting(false);

    const heartbeat = setInterval(() => {
      if (readLease()?.owner === tabId) writeLease();
    }, HEARTBEAT_MS);
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      if (readLease()?.owner === tabId) localStorage.removeItem(key);
      channel?.postMessage({ address, owner: tabId, expiresAt: 0 });
    }
  } finally {
    channel?.close();
  }
}

let tabId: string | undefined;
function getTabId(): string {
  tabId ??= makeTabId();
  return tabId;
}

export class SubmitQueue {
  private readonly pending = new Map<string, QueuedJob[]>();
  private readonly running = new Map<string, QueuedJob>();
  private readonly listeners = new Set<() => void>();
  private readonly deduplicated = new Map<string, { until: number; promise: Promise<unknown> }>();
  private readonly snapshots = new Map<string, QueueState>();
  private readonly lockWaiting = new Set<string>();

  enqueue<T>(job: QueueJob<T>): Promise<T> {
    const now = Date.now();
    const dedupeKey = job.dedupeKey ? `${job.address}:${job.dedupeKey}` : null;
    if (dedupeKey) {
      const previous = this.deduplicated.get(dedupeKey);
      if (previous && previous.until > now) return previous.promise as Promise<T>;
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const queued: QueuedJob<T> = { job, controller: new AbortController(), resolve, reject, cancelled: false, promise };
    const jobs = this.pending.get(job.address) ?? [];
    jobs.push(queued);
    this.pending.set(job.address, jobs);
    if (dedupeKey) {
      this.deduplicated.set(dedupeKey, { until: now + 1_000, promise });
      setTimeout(() => {
        if (this.deduplicated.get(dedupeKey)?.promise === promise) this.deduplicated.delete(dedupeKey);
      }, 1_000);
    }
    this.notify();
    void this.drain(job.address);
    return promise;
  }

  /** Removes a job only while it is still waiting; a running wallet request is never cancelled. */
  cancel(id: string): boolean {
    for (const [address, jobs] of this.pending) {
      const index = jobs.findIndex((entry) => entry.job.id === id);
      if (index < 0) continue;
      const [entry] = jobs.splice(index, 1);
      entry.cancelled = true;
      entry.controller.abort();
      entry.reject(new DOMException("The queued transaction was cancelled.", "AbortError"));
      if (!jobs.length) this.pending.delete(address);
      this.notify();
      return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(address: string): QueueState {
    const state = this.snapshots.get(address);
    if (state) return state;
    const empty = EMPTY_STATE(address);
    this.snapshots.set(address, empty);
    return empty;
  }

  private view(entry: QueuedJob | undefined): QueueEntryView | null {
    return entry ? { id: entry.job.id, label: entry.job.label } : null;
  }

  private notify(): void {
    const addresses = new Set([...this.pending.keys(), ...this.running.keys(), ...this.snapshots.keys(), ...this.lockWaiting]);
    for (const address of addresses) {
      const running = this.view(this.running.get(address));
      const waiting = (this.pending.get(address) ?? []).map((entry) => this.view(entry) as QueueEntryView);
      const previous = this.snapshots.get(address);
      if (
        previous?.running?.id !== running?.id ||
        previous?.waiting.map((entry) => entry.id).join("|") !== waiting.map((entry) => entry.id).join("|") ||
        previous?.lockWaiting !== this.lockWaiting.has(address)
      ) {
        this.snapshots.set(address, { address, running, waiting, lockWaiting: this.lockWaiting.has(address) });
      }
    }
    for (const listener of this.listeners) listener();
  }

  private async drain(address: string): Promise<void> {
    if (this.running.has(address)) return;
    const jobs = this.pending.get(address);
    const entry = jobs?.shift();
    if (!entry) {
      this.pending.delete(address);
      return;
    }
    if (!jobs?.length) this.pending.delete(address);
    this.running.set(address, entry);
    this.notify();

    try {
      const result = await withBrowserLock(address, entry.controller.signal, async () => {
        try {
          return await entry.job.run({ attempt: 0, signal: entry.controller.signal });
        } catch (error) {
          if (!classifySequenceError(error)) throw error;
          return entry.job.run({ attempt: 1, signal: entry.controller.signal });
        }
      }, (waiting) => {
        if (waiting) this.lockWaiting.add(address);
        else this.lockWaiting.delete(address);
        this.notify();
      });
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      this.running.delete(address);
      this.notify();
      void this.drain(address);
    }
  }
}

let singleton: SubmitQueue | undefined;
export function getSubmitQueue(): SubmitQueue {
  singleton ??= new SubmitQueue();
  return singleton;
}

export function useSubmitQueueState(address: string | null | undefined): QueueState {
  const queue = getSubmitQueue();
  const subscribe = (listener: () => void) => queue.subscribe(listener);
  const getSnapshot = () => (address ? queue.getState(address) : EMPTY_STATE(""));
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STATE(address ?? ""));
}
