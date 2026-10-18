import { describe, expect, it, vi } from "vitest";
import { Contract, Keypair, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { CONTRACTS } from "../config";
import { decodeTrade, fetchMarketTrades, tradeTopicFilter, mergeTrades } from "../events";
import { marketCore } from "../clients";
import { priceYesBps } from "../generated/fpmm";

const trader = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
export function tradeFixture(ledger = 100, index = 1): rpc.Api.EventResponse {
  const fields: Record<string, xdr.ScVal> = {
    outcome: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Yes")]), is_buy: nativeToScVal(true),
    collateral: nativeToScVal(10000000n, { type: "i128" }), shares: nativeToScVal(15873015n, { type: "i128" }),
    fee: nativeToScVal(200000n, { type: "i128" }), reserve_yes: nativeToScVal(421n, { type: "i128" }), reserve_no: nativeToScVal(579n, { type: "i128" }),
  };
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`, type: "contract", ledger,
    ledgerClosedAt: "2026-10-18T12:00:00Z", contractId: new Contract(CONTRACTS.marketCore),
    transactionIndex: 1, operationIndex: 0, inSuccessfulContractCall: true, txHash: "a".repeat(64),
    topic: [xdr.ScVal.scvSymbol("trade"), nativeToScVal(7n, { type: "u64" }), nativeToScVal(trader, { type: "address" })],
    value: xdr.ScVal.scvMap(Object.keys(fields).sort().map(key => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }))),
  };
}
describe("market contract events", () => {
  it("derives the trade prefix from the pinned spec and encodes market id as scvU64", () => {
    const filter = tradeTopicFilter(7n);
    expect(filter[0]).toBe(tradeFixture().topic[0].toXDR("base64"));
    expect(xdr.ScVal.fromXDR(filter[1], "base64").switch().name).toBe("scvU64");
    expect(filter[2]).toBe("*");
  });
  it("decodes the contract-shaped XDR fixture with exact bigint amounts and implied price", () => {
    const row = decodeTrade(tradeFixture());
    expect(marketCore().spec.parseEvent(tradeFixture().topic, tradeFixture().value)?.name).toBe("Trade");
    expect(row).toMatchObject({ marketId: "7", trader, collateral: 10000000n, shares: 15873015n, fee: 200000n, yesBpsAfter: Number(priceYesBps(421n, 579n)) });
    expect(decodeTrade({ ...tradeFixture(), inSuccessfulContractCall: false })).toBeNull();
  });
  it("widens backward until enough rows are found, using only the selected market topics", async () => {
    const getEvents = vi.fn().mockResolvedValueOnce({ events: [], cursor: "recent" })
      .mockResolvedValueOnce({ events: [tradeFixture(5000), tradeFixture(5001)], cursor: "older" });
    const result = await fetchMarketTrades(7n, { want: 2, server: { getHealth: async () => ({ oldestLedger: 1, latestLedger: 12000, ledgerRetentionWindow: 12000, status: "healthy" }), getEvents } });
    expect(result.trades.map(row => row.ledger)).toEqual([5001, 5000]); expect(result.reachedRetention).toBe(false);
    expect(getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 10001, endLedger: 12001, filters: [{ topics: [tradeTopicFilter(7n)], contractIds: [CONTRACTS.marketCore] }] });
    expect(getEvents.mock.calls[1][0].endLedger).toBe(10001);
  });
  it("reports RPC retention, and aborted reads do not return partial history", async () => {
    const server = { getHealth: async () => ({ oldestLedger: 50, latestLedger: 100, ledgerRetentionWindow: 50, status: "healthy" as const }), getEvents: vi.fn().mockResolvedValue({ events: [], cursor: "end" }) };
    expect((await fetchMarketTrades(7n, { want: 20, server })).reachedRetention).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(fetchMarketTrades(7n, { want: 20, server, signal: controller.signal })).rejects.toThrow();
  });
  it("replaces socket copies by event id, retaining separate events from the same transaction", () => {
    const row = decodeTrade(tradeFixture())!;
    const socket = { ...row, origin: "socket" as const, reserveYes: null, reserveNo: null };
    const merged = mergeTrades([socket], [row, decodeTrade(tradeFixture(100, 2))!]);
    expect(merged).toHaveLength(2); expect(merged.every(row => row.origin === "rpc")).toBe(true);
  });
});
