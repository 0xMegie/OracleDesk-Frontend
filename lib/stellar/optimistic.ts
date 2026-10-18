import type { OutcomeTag } from "./clients";
import type { Position } from "./generated/market-core";

/**
 * Optimistic position/balance updates (issue #39).
 *
 * After a confirmed write we know the exact contract-returned amounts, so the
 * caches are updated immediately and marked provisional. Reads whose
 * simulation ledger is below the tx ledger are ignored until the RPC catches
 * up; the chain value always wins once it does.
 */

export type WriteKind = "buy" | "sell" | "redeem";

export interface Provisional {
  txHash: string | null;
  ledger: number;
  kind: WriteKind;
  /** Set when reconciliation gave up waiting for the RPC to reach `ledger`. */
  awaitingRpc?: boolean;
}

export interface Stamped<T> {
  value: T;
  ledger: number;
  provisional?: Provisional;
}

export function applyBuy(p: Position, outcome: OutcomeTag, sharesOut: bigint): Position {
  return outcome === "Yes" ? { yes: p.yes + sharesOut, no: p.no } : { yes: p.yes, no: p.no + sharesOut };
}

export function applySell(p: Position, outcome: OutcomeTag, sharesSold: bigint): Position {
  const next = outcome === "Yes" ? { yes: p.yes - sharesSold, no: p.no } : { yes: p.yes, no: p.no - sharesSold };
  if (next.yes < 0n || next.no < 0n) throw new RangeError("applySell would make the position negative");
  return next;
}

export function applyRedeem(): Position {
  return { yes: 0n, no: 0n };
}

export type WriteResult =
  | { kind: "buy"; collateralIn: bigint }
  | { kind: "sell"; collateralOut: bigint }
  | { kind: "redeem"; payout: bigint };

/** Signed change to the holder's USDC balance. */
export function balanceDelta(r: WriteResult): bigint {
  switch (r.kind) {
    case "buy":
      return -r.collateralIn;
    case "sell":
      return r.collateralOut;
    case "redeem":
      return r.payout;
  }
}

/**
 * Decides what a query function should store given the cached value and a
 * fresh read. A read below a provisional ledger is stale and must not win.
 */
export function guardRead<T>(cached: Stamped<T> | undefined, fresh: Stamped<T>): Stamped<T> {
  if (cached?.provisional && fresh.ledger < cached.provisional.ledger) return cached;
  return fresh;
}

export type ReconcileOutcome<T> =
  | { status: "lagging" }
  | { status: "match"; next: Stamped<T> }
  | { status: "mismatch"; next: Stamped<T>; expected: T; actual: T };

export function reconcile<T>(
  provisional: Stamped<T>,
  fresh: Stamped<T>,
  equals: (a: T, b: T) => boolean,
): ReconcileOutcome<T> {
  const minLedger = provisional.provisional?.ledger ?? 0;
  if (fresh.ledger < minLedger) return { status: "lagging" };
  const next: Stamped<T> = { value: fresh.value, ledger: fresh.ledger };
  if (equals(provisional.value, fresh.value)) return { status: "match", next };
  return { status: "mismatch", next, expected: provisional.value, actual: fresh.value };
}

export const positionEquals = (a: Position, b: Position) => a.yes === b.yes && a.no === b.no;
export const bigintEquals = (a: bigint, b: bigint) => a === b;

/** Stacks a provisional write on top of whatever is cached (possibly another provisional). */
export function stackProvisional<T>(
  base: Stamped<T>,
  value: T,
  p: Provisional,
): Stamped<T> {
  const ledger = Math.max(p.ledger, base.provisional?.ledger ?? 0);
  return { value, ledger: Math.max(base.ledger, ledger), provisional: { ...p, ledger } };
}

/** Retry schedule for reconciliation reads, in ms after the write. */
export const RECONCILE_DELAYS_MS = [1_000, 3_000, 8_000] as const;
