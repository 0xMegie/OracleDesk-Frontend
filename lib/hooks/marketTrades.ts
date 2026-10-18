import type { TradeRow } from "@/lib/stellar/events";
import { MAX_TAPE_ROWS } from "@/lib/stellar/events";
import type { TradeExecutedPayload } from "@/lib/realtime/RealtimeProvider";

/** Pure helpers behind useMarketTrades (issue #40), kept React-free for tests. */

const INT = /^\d+$/;

/** Builds a provisional tape row from a socket payload, or null if it is for another market or malformed. */
export function socketTradeToRow(p: TradeExecutedPayload, marketId: string): TradeRow | null {
  if (p.onChainMarketId !== marketId) return null;
  if (!INT.test(p.collateralRaw) || !INT.test(p.sharesRaw) || !INT.test(p.feeRaw ?? "0")) return null;
  if (typeof p.eventId !== "string" || !p.eventId) return null;
  return {
    id: p.eventId,
    ledger: p.ledger,
    closedAt: new Date().toISOString(),
    txHash: p.txHash,
    marketId,
    trader: p.trader,
    outcome: p.direction === "YES" ? "Yes" : "No",
    isBuy: p.isBuy,
    collateral: BigInt(p.collateralRaw),
    shares: BigInt(p.sharesRaw),
    fee: BigInt(p.feeRaw ?? "0"),
    // Socket rows carry no reserves; the next RPC refetch replaces them.
    reserveYes: 0n,
    reserveNo: 0n,
    yesBpsAfter: p.priceYesBps,
    origin: "socket",
  };
}

/**
 * Merges RPC rows (authoritative) with live socket rows, newest first,
 * deduped by event id. A decoded RPC row replaces a socket row with the same id.
 */
export function mergeTrades(rpcRows: readonly TradeRow[], socketRows: readonly TradeRow[]): TradeRow[] {
  const byId = new Map<string, TradeRow>();
  for (const r of socketRows) byId.set(r.id, r);
  for (const r of rpcRows) byId.set(r.id, r);
  return [...byId.values()]
    .sort((a, b) => (b.ledger - a.ledger) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
    .slice(0, MAX_TAPE_ROWS);
}

/** Price before each trade, from the next-older row (null for the oldest). */
export function withPrevPrice(rows: readonly TradeRow[]): Array<TradeRow & { prevYesBps: number | null }> {
  return rows.map((r, i) => ({ ...r, prevYesBps: i + 1 < rows.length ? rows[i + 1].yesBpsAfter : null }));
}
