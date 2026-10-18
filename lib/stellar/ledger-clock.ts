import { useSyncExternalStore } from "react";
import { rpcServer } from "./clients";

export interface LedgerSample {
  sequence: number;
  closeTime: number;
  observedAt: number;
}

interface LedgerPoint {
  sequence: number;
  closeTime: number;
}

export async function fetchLatestLedger(): Promise<LedgerPoint> {
  const latest = await rpcServer().getLatestLedger();
  const closeTime = Number(latest.closeTime);
  if (!Number.isSafeInteger(latest.sequence) || !Number.isFinite(closeTime) || closeTime < 0) {
    throw new Error("The Stellar RPC returned an invalid ledger clock sample.");
  }
  return { sequence: latest.sequence, closeTime };
}

export class LedgerClock {
  private samples: LedgerSample[] = [];
  private listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private versionValue = 0;

  constructor(
    private readonly fetchLatest: () => Promise<LedgerPoint>,
    private readonly opts: { pollMs?: number; avgCloseSeconds?: number } = {},
  ) {}

  get version() {
    return this.versionValue;
  }

  now(): number | null {
    const sample = this.samples.at(-1);
    if (!sample) return null;
    const elapsed = (performance.now() - sample.observedAt) / 1000;
    if (elapsed < 0.01) return sample.closeTime;
    if (elapsed > (this.opts.pollMs ?? 10_000) / 500) return null;
    const growthCap = this.averageCloseSeconds() * 2;
    return sample.closeTime + Math.min(Math.max(0, elapsed), growthCap);
  }

  uncertainty(): number {
    return this.samples.length < 2 ? this.averageCloseSeconds() : this.averageCloseSeconds() / 2;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  start(): void {
    if (this.pollTimer) return;
    void this.sample();
    this.pollTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void this.sample();
    }, this.opts.pollMs ?? 10_000);
    this.tickTimer = setInterval(() => this.notify(), 1_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = null;
    this.tickTimer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private onVisibilityChange = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.samples = [];
    this.notify();
    void this.sample();
  };

  private async sample(): Promise<void> {
    try {
      const next = await this.fetchLatest();
      const previous = this.samples.at(-1);
      if (previous && (next.sequence < previous.sequence || next.closeTime < previous.closeTime)) return;
      if (previous && next.sequence === previous.sequence) return;
      this.samples.push({ ...next, observedAt: performance.now() });
      this.samples = this.samples.slice(-10);
      this.notify();
    } catch {
      // An unavailable RPC must not be replaced with the machine's wall clock.
      this.notify();
    }
  }

  private averageCloseSeconds(): number {
    if (this.samples.length < 2) return this.opts.avgCloseSeconds ?? 5.5;
    let elapsed = 0;
    let ledgers = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const before = this.samples[i - 1];
      const after = this.samples[i];
      elapsed += after.closeTime - before.closeTime;
      ledgers += after.sequence - before.sequence;
    }
    return ledgers > 0 ? elapsed / ledgers : this.opts.avgCloseSeconds ?? 5.5;
  }

  private notify(): void {
    this.versionValue++;
    this.listeners.forEach((listener) => listener());
  }
}

const ledgerClock = new LedgerClock(fetchLatestLedger);

export function useLedgerNow(): { now: number | null; uncertainty: number } {
  useSyncExternalStore(ledgerClock.subscribe, () => ledgerClock.version, () => 0);
  return { now: ledgerClock.now(), uncertainty: ledgerClock.uncertainty() };
}

export const getLedgerNow = () => ledgerClock.now();
