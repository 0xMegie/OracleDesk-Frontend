import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { applyBuy, applySell, applyRedeem, balanceDelta, reconcileRead, type Stamped } from "../optimistic";
import { balanceKey, positionKey, cancelTradeReads, confirmTrade } from "../optimistic-cache";
import type { Position } from "../generated/market-core";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("confirmed bigint deltas", () => {
  it("updates only the selected side and rejects negative amounts", () => {
    const p = { yes: 1n, no: 2n };
    expect(applyBuy(p, "Yes", 3n)).toEqual({ yes: 4n, no: 2n });
    expect(applySell(p, "No", 1n)).toEqual({ yes: 1n, no: 1n });
    expect(() => applySell(p, "Yes", 2n)).toThrow(); expect(p).toEqual({ yes: 1n, no: 2n });
    expect(applyRedeem()).toEqual({ yes: 0n, no: 0n });
    expect(balanceDelta("buy", { collateralIn: 5n })).toBe(-5n);
    expect(balanceDelta("sell", { collateralOut: 5n })).toBe(5n);
    expect(balanceDelta("redeem", { payout: 0n })).toBe(0n);
  });
});
describe("ledger reconciliation with a real QueryClient", () => {
  const pkey = positionKey("1", "wallet"), bkey = balanceKey("wallet");
  function setup() {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client.setQueryData(pkey, { value: { yes: 10n, no: 2n }, ledger: 10 });
    client.setQueryData(bkey, { value: 100n, ledger: 10 });
    return client;
  }
  const buy = { kind: "buy" as const, marketId: "1", holder: "wallet", ledger: 11, txHash: "a", outcome: "Yes" as const, collateralIn: 5n, sharesOut: 8n };
  it("shows exact returned values immediately and a lower-ledger read cannot overwrite them", async () => {
    const client = setup(); await cancelTradeReads(client, "1", "wallet"); confirmTrade(client, buy);
    const position = client.getQueryData<Stamped<Position>>(pkey)!;
    expect(position).toMatchObject({ value: { yes: 18n, no: 2n }, ledger: 11, provisional: { txHash: "a" } });
    expect(client.getQueryData<Stamped<bigint>>(bkey)?.value).toBe(95n);
    expect(reconcileRead(position, { value: { yes: 10n, no: 2n }, ledger: 10 }, (a, b) => a.yes === b.yes, pkey)).toBe(position);
    client.clear();
  });
  it("clears provisional at the confirmed ledger and replaces a mismatch with a warning", () => {
    const client = setup(); confirmTrade(client, buy);
    const previous = client.getQueryData<Stamped<Position>>(pkey)!;
    const fresh = { value: { yes: 18n, no: 2n }, ledger: 11 };
    const equal = (a: Position, b: Position) => a.yes === b.yes && a.no === b.no;
    expect(reconcileRead(previous, fresh, equal, pkey)).toBe(fresh);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const different = { value: { yes: 20n, no: 2n }, ledger: 12 };
    expect(reconcileRead(previous, different, equal, pkey)).toBe(different); expect(warning).toHaveBeenCalledOnce(); client.clear();
  });
  it("stacks two confirmed buys and zero-payout redemption, without touching other owners", () => {
    const client = setup(); confirmTrade(client, buy); confirmTrade(client, { ...buy, ledger: 12, txHash: "b" });
    expect(client.getQueryData<Stamped<Position>>(pkey)?.value.yes).toBe(26n);
    expect(client.getQueryData<Stamped<bigint>>(bkey)?.value).toBe(90n);
    confirmTrade(client, { ...buy, kind: "redeem", ledger: 13, payout: 0n });
    expect(client.getQueryData<Stamped<Position>>(pkey)?.value).toEqual({ yes: 0n, no: 0n });
    expect(client.getQueryData<Stamped<bigint>>(bkey)?.value).toBe(90n);
    expect(client.getQueryData(positionKey("1", "other"))).toBeUndefined(); client.clear();
  });
  it("a rejected signature leaves snapshots exactly unchanged", async () => {
    const client = setup(), before = client.getQueryData(pkey);
    const observer = new MutationObserver(client, { mutationFn: async () => { throw new Error("User rejected"); }, onMutate: () => cancelTradeReads(client, "1", "wallet"), onSuccess: () => confirmTrade(client, buy) });
    await expect(observer.mutate()).rejects.toThrow("User rejected");
    expect(client.getQueryData(pkey)).toBe(before); expect(client.getQueryData<Stamped<bigint>>(bkey)?.value).toBe(100n); client.clear();
  });
  it("unknown ledgers invalidate without applying deltas; disconnect never recreates removed keys", async () => {
    const client = setup(); confirmTrade(client, { ...buy, ledger: null });
    expect(client.getQueryData<Stamped<Position>>(pkey)?.value.yes).toBe(10n);
    expect(client.getQueryState(pkey)?.isInvalidated).toBe(true);
    confirmTrade(client, buy); client.removeQueries({ queryKey: ["stellar"] });
    await vi.advanceTimersByTimeAsync(10000); expect(client.getQueryData(pkey)).toBeUndefined(); client.clear();
  });
  it("keeps a lagging value labelled awaiting RPC after retries, without applying the same confirmation twice", async () => {
    const client = setup(); confirmTrade(client, buy);
    await vi.advanceTimersByTimeAsync(8000);
    const position = client.getQueryData<Stamped<Position>>(pkey)!;
    expect(position.provisional).toBeUndefined();
    expect(position.awaitingRpc).toMatchObject({ ledger: 11, txHash: "a" });
    expect(reconcileRead(position, { value: { yes: 10n, no: 2n }, ledger: 10 }, (a, b) => a.yes === b.yes, pkey)).toBe(position);
    confirmTrade(client, buy);
    expect(client.getQueryData<Stamped<Position>>(pkey)?.value.yes).toBe(18n);
    client.clear();
  });
});
