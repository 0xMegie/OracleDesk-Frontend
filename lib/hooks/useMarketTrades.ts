"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeBatch } from "@/lib/realtime/RealtimeProvider";
import { isMarketId, type TradeEvent } from "@/lib/realtime/types";
import { fetchMarketTrades, mergeTrades, type TradeRow } from "@/lib/stellar/events";

export function socketTrade(payload: TradeEvent, marketId: string): TradeRow | null {
  if (payload.onChainMarketId !== marketId) return null;
  return { id: payload.eventId, ledger: payload.ledger, closedAt: payload.closedAt ?? null, txHash: payload.txHash,
    marketId, trader: payload.trader, outcome: payload.direction === "YES" ? "Yes" : "No", isBuy: payload.isBuy,
    collateral: BigInt(payload.collateralRaw), shares: BigInt(payload.sharesRaw), fee: BigInt(payload.feeRaw),
    yesBpsAfter: payload.priceYesBps, reserveYes: null, reserveNo: null, origin: "socket" };
}
type TapeData = Awaited<ReturnType<typeof fetchMarketTrades>>;
export function useMarketTrades(id: string, { limit = 20 }: { limit?: number } = {}) {
  const client = useQueryClient();
  const queryKey = ["stellar", "marketTrades", id, limit] as const;
  useRealtimeBatch(batch => {
    const rows = batch.flatMap(event => {
      if (event.type !== "TRADE_EXECUTED") return [];
      const row = socketTrade(event.payload, id); return row ? [row] : [];
    });
    if (rows.length) client.setQueryData<TapeData>(queryKey, previous => ({
      trades: mergeTrades(previous?.trades ?? [], rows).slice(0, limit),
      reachedRetention: previous?.reachedRetention ?? false, latestLedger: previous?.latestLedger ?? 0, cursor: previous?.cursor ?? "",
    }));
  });
  return useQuery<TapeData>({
    queryKey, placeholderData: previous => previous, enabled: isMarketId(id), staleTime: 60_000, refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const result = await fetchMarketTrades(BigInt(id), { want: limit, signal });
      const existing = client.getQueryData<TapeData>(queryKey);
      // A socket event may arrive while the RPC request is in flight.
      return { ...result, trades: mergeTrades(existing?.trades.filter(row => row.origin === "socket" && row.ledger > result.latestLedger) ?? [], result.trades).slice(0, limit) };
    },
  });
}
