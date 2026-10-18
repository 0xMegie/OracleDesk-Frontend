import { describe, expect, it } from "vitest";
import {
  applyBuy,
  applyRedeem,
  applySell,
  balanceDelta,
  bigintEquals,
  guardRead,
  positionEquals,
  reconcile,
  stackProvisional,
  type Stamped,
} from "../optimistic";
import type { Position } from "../generated/market-core";

const pos = (yes: bigint, no: bigint): Position => ({ yes, no });

describe("delta functions", () => {
  it("applyBuy adds to the chosen side", () => {
    expect(applyBuy(pos(1n, 2n), "Yes", 5n)).toEqual(pos(6n, 2n));
    expect(applyBuy(pos(1n, 2n), "No", 5n)).toEqual(pos(1n, 7n));
  });

  it("applySell throws below zero", () => {
    expect(applySell(pos(5n, 0n), "Yes", 5n)).toEqual(pos(0n, 0n));
    expect(() => applySell(pos(4n, 0n), "Yes", 5n)).toThrow(RangeError);
  });

  it("applyRedeem zeroes both sides", () => {
    expect(applyRedeem()).toEqual(pos(0n, 0n));
  });

  it("balanceDelta signs per kind", () => {
    expect(balanceDelta({ kind: "buy", collateralIn: 10n })).toBe(-10n);
    expect(balanceDelta({ kind: "sell", collateralOut: 7n })).toBe(7n);
    expect(balanceDelta({ kind: "redeem", payout: 0n })).toBe(0n);
  });
});

describe("ledger-aware cache rules", () => {
  const provisional: Stamped<bigint> = { value: 90n, ledger: 100, provisional: { txHash: "ab", ledger: 100, kind: "buy" } };

  it("a stale read at a lower ledger does not overwrite a provisional value", () => {
    expect(guardRead(provisional, { value: 100n, ledger: 99 })).toBe(provisional);
  });

  it("a read at or above the tx ledger wins", () => {
    expect(guardRead(provisional, { value: 90n, ledger: 100 })).toEqual({ value: 90n, ledger: 100 });
  });

  it("reconcile clears provisional on match", () => {
    const r = reconcile(provisional, { value: 90n, ledger: 101 }, bigintEquals);
    expect(r.status).toBe("match");
    if (r.status === "match") expect(r.next.provisional).toBeUndefined();
  });

  it("reconcile replaces with the chain value on mismatch", () => {
    const r = reconcile(provisional, { value: 80n, ledger: 101 }, bigintEquals);
    expect(r).toMatchObject({ status: "mismatch", expected: 90n, actual: 80n, next: { value: 80n } });
  });

  it("reconcile reports lagging below the tx ledger", () => {
    expect(reconcile(provisional, { value: 100n, ledger: 50 }, bigintEquals).status).toBe("lagging");
  });

  it("two consecutive buys stack and keep the highest ledger", () => {
    const first = stackProvisional<Position>({ value: pos(0n, 0n), ledger: 10 }, pos(5n, 0n), { txHash: "a", ledger: 20, kind: "buy" });
    const second = stackProvisional(first, applyBuy(first.value, "Yes", 3n), { txHash: "b", ledger: 22, kind: "buy" });
    expect(second.value).toEqual(pos(8n, 0n));
    expect(second.provisional?.ledger).toBe(22);
    expect(positionEquals(second.value, pos(8n, 0n))).toBe(true);
  });
});
