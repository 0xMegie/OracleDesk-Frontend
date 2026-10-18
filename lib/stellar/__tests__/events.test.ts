import { describe, expect, it, beforeEach } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { priceYesBps } from "../generated/fpmm";
import {
  clearTradeCache,
  decodeTrade,
  eventPrefix,
  fetchMarketTrades,
  tradeTopicFilter,
  type EventsServer,
  type RawEvent,
} from "../events";

const TRADER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

function tradeEvent(id: string, ledger: number, marketId = 7n): RawEvent {
  const body = xdr.ScVal.scvMap([
    ["collateral", nativeToScVal(10_000_000n, { type: "i128" })],
    ["fee", nativeToScVal(200_000n, { type: "i128" })],
    ["is_buy", xdr.ScVal.scvBool(true)],
    ["outcome", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Yes")])],
    ["reserve_no", nativeToScVal(60_000_000n, { type: "i128" })],
    ["reserve_yes", nativeToScVal(40_000_000n, { type: "i128" })],
    ["shares", nativeToScVal(15_873_015n, { type: "i128" })],
  ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k as string), val: v as xdr.ScVal })));
  return {
    id,
    ledger,
    ledgerClosedAt: "2026-10-01T00:00:00Z",
    txHash: "a".repeat(64),
    topic: [xdr.ScVal.scvSymbol("trade"), nativeToScVal(marketId, { type: "u64" }), nativeToScVal(TRADER, { type: "address" })],
    value: body,
  };
}

describe("tradeTopicFilter", () => {
  it("encodes the market id as scvU64 and wildcards the trader", () => {
    const [name, market, trader] = tradeTopicFilter(7n);
    expect(xdr.ScVal.fromXDR(market, "base64").switch().name).toBe("scvU64");
    expect(xdr.ScVal.fromXDR(name, "base64").sym().toString()).toBe("trade");
    expect(trader).toBe("*");
  });

  it("reads the event name from the contract spec", () => {
    expect(eventPrefix("Trade")).toBe("trade");
    expect(eventPrefix("MarketResolved")).toBe("market_resolved");
  });
});

describe("decodeTrade", () => {
  it("decodes into a TradeRow with bigint amounts and the exact post-trade price", () => {
    const row = decodeTrade(tradeEvent("e1", 10));
    expect(row).toMatchObject({ marketId: "7", trader: TRADER, outcome: "Yes", isBuy: true, collateral: 10_000_000n, fee: 200_000n });
    expect(row.yesBpsAfter).toBe(Number(priceYesBps(40_000_000n, 60_000_000n)));
  });
});

function fakeServer(events: RawEvent[], oldestLedger: number, latestLedger: number): EventsServer & { starts: number[] } {
  const starts: number[] = [];
  return {
    starts,
    getHealth: async () => ({ oldestLedger, latestLedger }),
    getEvents: async (req) => {
      const start = (req as { startLedger?: number }).startLedger ?? oldestLedger;
      starts.push(start);
      return { events: events.filter((e) => e.ledger >= start), latestLedger };
    },
  };
}

describe("fetchMarketTrades", () => {
  beforeEach(() => clearTradeCache());

  it("widens the window until want is satisfied", async () => {
    const server = fakeServer([tradeEvent("old", 95_000), tradeEvent("new", 99_500)], 1_000, 100_000);
    const res = await fetchMarketTrades(7n, { want: 2, server });
    expect(res.trades.map((t) => t.id)).toEqual(["new", "old"]);
    expect(server.starts[0]).toBe(98_000);
    expect(server.starts.length).toBeGreaterThan(1);
    expect(res.reachedRetention).toBe(false);
  });

  it("reports reachedRetention at oldestLedger", async () => {
    const server = fakeServer([tradeEvent("only", 99_900)], 99_000, 100_000);
    const res = await fetchMarketTrades(7n, { want: 5, server });
    expect(res.trades).toHaveLength(1);
    expect(res.reachedRetention).toBe(true);
    expect(Math.min(...server.starts)).toBe(99_000);
  });
});
