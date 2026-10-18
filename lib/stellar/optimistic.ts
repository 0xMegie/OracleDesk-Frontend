import type { OutcomeTag } from "./clients";
import type { Position } from "./generated/market-core";

export type TradeKind = "buy" | "sell" | "redeem";
export interface Provisional { txHash: string | null; ledger: number; kind: TradeKind }
export interface Stamped<T> { value: T; ledger: number; provisional?: Provisional; awaitingRpc?: Provisional }

export function applyBuy(p: Position, outcome: OutcomeTag, sharesOut: bigint): Position {
  if (sharesOut < 0n) throw new Error("Negative shares");
  return outcome === "Yes" ? { ...p, yes: p.yes + sharesOut } : { ...p, no: p.no + sharesOut };
}
export function applySell(p: Position, outcome: OutcomeTag, sharesSold: bigint): Position {
  if (sharesSold < 0n || (outcome === "Yes" ? p.yes : p.no) < sharesSold) throw new Error("Insufficient cached shares");
  return outcome === "Yes" ? { ...p, yes: p.yes - sharesSold } : { ...p, no: p.no - sharesSold };
}
export function applyRedeem(): Position { return { yes: 0n, no: 0n }; }
export function balanceDelta(kind: TradeKind, r: { collateralIn?: bigint; collateralOut?: bigint; payout?: bigint }): bigint {
  const value = kind === "buy" ? r.collateralIn : kind === "sell" ? r.collateralOut : r.payout;
  if (value === undefined || value < 0n) throw new Error("Missing or negative confirmed amount");
  return kind === "buy" ? -value : value;
}

export function reconcileRead<T>(previous: Stamped<T> | undefined, fresh: Stamped<T>, equal: (a: T, b: T) => boolean, key: readonly unknown[]): Stamped<T> {
  if (!previous) return fresh;
  // Also protect already-reconciled values against a lagging RPC or an old read.
  if (fresh.ledger < previous.ledger) return previous;
  const pending = previous.provisional ?? previous.awaitingRpc;
  if (pending && !equal(previous.value, fresh.value)) {
    console.warn("[optimistic] mismatch", { key, expected: previous.value, actual: fresh.value, txHash: pending.txHash });
  }
  return fresh;
}
