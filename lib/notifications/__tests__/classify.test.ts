import { describe, expect, it } from "vitest";
import { classifyRedeemed, classifyResolved, classifyTrace, classifyTrade, classifyTx } from "../classify";

const owner = "GOWNER";
const ctx = { owner, network: "Test SDF Network ; September 2015", now: 1_000 };
const trade = {
  trader: owner,
  eventId: "0001-0001",
  onChainMarketId: "7",
  collateralRaw: "10000000",
  sharesRaw: "15873015",
  txHash: "b".repeat(64),
  direction: "YES",
  isBuy: true,
  ledger: 5,
};

describe("classifyTrade", () => {
  it("ignores trades by other traders", () => {
    expect(classifyTrade({ ...trade, trader: "GOTHER" }, ctx)).toBeNull();
  });

  it("rejects malformed collateralRaw and txHash", () => {
    expect(classifyTrade({ ...trade, collateralRaw: "-1" }, ctx)).toBeNull();
    expect(classifyTrade({ ...trade, collateralRaw: "1.5" }, ctx)).toBeNull();
    expect(classifyTrade({ ...trade, txHash: "xyz" }, ctx)).toBeNull();
  });

  it("produces deterministic ids for the same event", () => {
    expect(classifyTrade(trade, ctx)!.id).toBe("fill:0001-0001");
    expect(classifyTrade(trade, { ...ctx, now: 2_000 })!.id).toBe(classifyTrade(trade, ctx)!.id);
  });
});

describe("classifyTrace", () => {
  const payload = { onChainMarketId: "7", onChainTraceId: "3", action: "buy" };
  it("only fires for held markets", () => {
    expect(classifyTrace(payload, new Set(["8"]), ctx)).toBeNull();
    expect(classifyTrace(payload, new Set(["7"]), ctx)?.id).toBe("trace:3");
  });
});

describe("resolution and redemption", () => {
  const resolved = { id: "e", ledger: 9, closedAt: "2026-10-01T00:00:00Z", marketId: "7" };

  it("a void resolution is redeemable", () => {
    const item = classifyResolved({ ...resolved, outcome: null }, { yes: 1n, no: 0n }, ctx);
    expect(item).toMatchObject({ kind: "redeemable", id: "redeemable:7", data: { outcome: "void" } });
  });

  it("nothing to redeem without a position", () => {
    expect(classifyResolved({ ...resolved, outcome: "Yes" }, { yes: 0n, no: 0n }, ctx)).toBeNull();
  });

  it("redeemed only for the owner", () => {
    const ev = { ...resolved, txHash: "c".repeat(64), holder: "GOTHER", payout: 5n };
    expect(classifyRedeemed(ev, ctx)).toBeNull();
    expect(classifyRedeemed({ ...ev, holder: owner }, ctx)?.data.payoutRaw).toBe("5");
  });

  it("does not record wallet rejections", () => {
    expect(classifyTx({ hash: null, kind: "buy", state: "failed", errorKind: "rejected" }, ctx)).toBeNull();
    expect(classifyTx({ hash: "d".repeat(64), kind: "buy", state: "failed" }, ctx)?.id).toBe(`tx-failed:${"d".repeat(64)}`);
  });
});
