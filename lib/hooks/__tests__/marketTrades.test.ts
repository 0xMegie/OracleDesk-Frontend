import { describe, expect, it } from "vitest";
import { mergeTrades, socketTradeToRow, withPrevPrice } from "../marketTrades";
import type { TradeExecutedPayload } from "@/lib/realtime/RealtimeProvider";

const payload = (over: Partial<TradeExecutedPayload> = {}): TradeExecutedPayload => ({
  onChainMarketId: "7",
  marketId: null,
  marketQuestion: null,
  trader: "GTRADER",
  direction: "YES",
  isBuy: true,
  collateralRaw: "10000000",
  sharesRaw: "15873015",
  feeRaw: "200000",
  priceYesBps: 6421,
  txHash: "a".repeat(64),
  ledger: 10,
  eventId: "e1",
  ...over,
});

describe("market trades merging", () => {
  it("ignores socket rows for other markets", () => {
    expect(socketTradeToRow(payload({ onChainMarketId: "8" }), "7")).toBeNull();
  });

  it("rejects malformed amounts", () => {
    expect(socketTradeToRow(payload({ collateralRaw: "1.5" }), "7")).toBeNull();
  });

  it("replaces a socket row with the decoded RPC row of the same id", () => {
    const socket = socketTradeToRow(payload(), "7")!;
    const rpcRow = { ...socket, origin: "rpc" as const, reserveYes: 1n, reserveNo: 2n };
    const merged = mergeTrades([rpcRow], [socket]);
    expect(merged).toHaveLength(1);
    expect(merged[0].origin).toBe("rpc");
  });

  it("computes the previous price from the next-older row", () => {
    const a = socketTradeToRow(payload({ eventId: "a", ledger: 11, priceYesBps: 6500 }), "7")!;
    const b = socketTradeToRow(payload({ eventId: "b", ledger: 10, priceYesBps: 6400 }), "7")!;
    const rows = withPrevPrice(mergeTrades([], [b, a]));
    expect(rows.map((r) => r.prevYesBps)).toEqual([6400, null]);
  });
});
