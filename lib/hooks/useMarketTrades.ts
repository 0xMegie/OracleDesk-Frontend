"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchMarketTrades, type TradeRow } from "@/lib/stellar/events";
import { useRealtimeBatch, type TradeExecutedPayload } from "@/lib/realtime/RealtimeProvider";
import { mergeTrades, socketTradeToRow, withPrevPrice } from "./marketTrades";

/**
 * Newest trades for one market, decoded from market-core Trade events via RPC
 * and extended live by TRADE_EXECUTED (issue #40). The key starts with
 * "stellar" so a disconnect drops it with the other chain reads.
 */
export function useMarketTrades(onChainMarketId: string | null | undefined, { limit = 20 }: { limit?: number } = {}) {
  const [want, setWant] = useState(limit);
  const [live, setLive] = useState<{ marketId: string; rows: TradeRow[] }>({ marketId: "", rows: [] });

  const query = useQuery({
    queryKey: ["stellar", "marketTrades", onChainMarketId ?? "", want],
    enabled: Boolean(onChainMarketId),
    queryFn: ({ signal }) => fetchMarketTrades(BigInt(onChainMarketId as string), { want, signal }),
    staleTime: 60_000,
  });

  const onBatch = useCallback(
    (batch: readonly TradeExecutedPayload[]) => {
      if (!onChainMarketId) return;
      const rows: TradeRow[] = [];
      for (const p of batch) {
        const row = socketTradeToRow(p, onChainMarketId);
        if (row) rows.push(row);
      }
      if (rows.length === 0) return;
      setLive((prev) => ({
        marketId: onChainMarketId,
        rows: mergeTrades([], [...rows, ...(prev.marketId === onChainMarketId ? prev.rows : [])]),
      }));
    },
    [onChainMarketId],
  );
  useRealtimeBatch("TRADE_EXECUTED", onBatch);

  const liveRows = live.marketId === onChainMarketId ? live.rows : [];
  const rpcRows = query.data?.trades;
  const rows = useMemo(() => withPrevPrice(mergeTrades(rpcRows ?? [], liveRows)), [rpcRows, liveRows]);

  return {
    rows,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    isFetching: query.isFetching,
    reachedRetention: query.data?.reachedRetention ?? false,
    loadOlder: () => setWant((w) => w * 2),
  };
}
