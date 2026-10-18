"use client";
import { useState } from "react";
import { useMarketTrades } from "@/lib/hooks/useMarketTrades";
import { useWallet } from "@/lib/contexts/WalletContext";
import { explorerAccount, explorerTx } from "@/lib/stellar/config";
import { formatUsdc, shortAddress } from "@/lib/stellar/units";

const ROW_HEIGHT = 48;
const VISIBLE = 8;
const OVERSCAN = 8;
function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function TradeTape({ onChainMarketId, limit = 20, compact = false }: { onChainMarketId: string; limit?: number; compact?: boolean }) {
  return <MarketTape key={onChainMarketId} id={onChainMarketId} limit={limit} compact={compact} />;
}
function MarketTape({ id, limit, compact }: { id: string; limit: number; compact: boolean }) {
  const [want, setWant] = useState(limit);
  const [scrollTop, setScrollTop] = useState(0);
  const query = useMarketTrades(id, { limit: want });
  const rows = query.data?.trades ?? [];
  const { address } = useWallet();
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, first + VISIBLE + OVERSCAN * 2);
  const titles = ["Time", "Side", "Action", "Trader", "USDC", "Shares", "Fee", "YES after", "Transaction"];
  return <section aria-label={`Trades on market ${id}`} className={`border-t border-outline-variant ${compact ? "pt-4" : "p-6"}`}>
    <h2 className="font-headline-sm text-headline-sm mb-2">Recent trades</h2>
    <p className="text-xs text-on-surface-variant mb-3">Market #{id} · Public contract events within the RPC retention window.</p>
    {query.isPending && <div role="status" className="h-24 bg-surface-container-low motion-safe:animate-pulse p-4">Loading trades…</div>}
    {query.isError && <p role="alert" className="text-sm text-error">Couldn&apos;t load trades. <button onClick={() => void query.refetch()} className="underline">Retry</button></p>}
    {!query.isPending && !query.isError && rows.length === 0 && <p className="py-6 text-sm text-on-surface-variant">No trades on this market in the RPC&apos;s retention window.</p>}
    {rows.length > 0 && <div className="overflow-auto" style={{ maxHeight: ROW_HEIGHT * VISIBLE + 34 }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
      <table aria-rowcount={rows.length + 1} className="w-full text-xs text-left whitespace-nowrap">
        <thead className="sticky top-0 bg-surface-container-lowest z-10"><tr>{titles.map(title => <th key={title} scope="col" className="px-2 py-2">{title}</th>)}</tr></thead>
        <tbody className="font-data-mono">
          {first > 0 && <tr aria-hidden="true"><td colSpan={9} style={{ height: first * ROW_HEIGHT }} /></tr>}
          {rows.slice(first, last).map((row, offset) => {
            const previous = rows[first + offset + 1]?.yesBpsAfter;
            const movement = previous === undefined ? null : row.yesBpsAfter - previous;
            return <tr key={row.id} aria-rowindex={first + offset + 2} style={{ height: ROW_HEIGHT }} className="border-b border-outline-variant/40">
              <td className="px-2"><time dateTime={row.closedAt ?? undefined} title={row.closedAt ?? "Ledger close time has not arrived yet"}>{row.closedAt ? relativeTime(row.closedAt, query.dataUpdatedAt) : `Ledger ${row.ledger}`}</time>{row.origin === "socket" && <span className="ml-1 text-on-surface-variant">live</span>}</td>
              <td className={`px-2 font-bold ${row.outcome === "Yes" ? "text-secondary" : "text-tertiary"}`}>{row.outcome.toUpperCase()}</td>
              <td className="px-2">{row.isBuy ? "BUY" : "SELL"}</td>
              <td className="px-2"><a href={explorerAccount(row.trader)} target="_blank" rel="noreferrer" className="text-primary underline">{row.trader === address ? "you" : shortAddress(row.trader)}</a></td>
              {[row.collateral, row.shares, row.fee].map((value, index) => <td key={titles[index + 4]} className="px-2 text-right" title={formatUsdc(value, { maxDecimals: 7 })}>{formatUsdc(value, { maxDecimals: index === 2 ? 7 : 2, grouping: true })}</td>)}
              <td className="px-2 text-right">{(row.yesBpsAfter / 100).toFixed(2)}%{movement !== null && <span aria-label={`${movement >= 0 ? "up" : "down"} ${Math.abs(movement)} basis points`}> {movement > 0 ? "↑" : movement < 0 ? "↓" : "→"}</span>}</td>
              <td className="px-2"><a href={explorerTx(row.txHash)} target="_blank" rel="noreferrer" className="text-primary underline" aria-label={`View transaction ${row.txHash}`}>{row.txHash.slice(0, 8)}…</a></td>
            </tr>;
          })}
          {last < rows.length && <tr aria-hidden="true"><td colSpan={9} style={{ height: (rows.length - last) * ROW_HEIGHT }} /></tr>}
        </tbody>
      </table>
    </div>}
    {query.data?.reachedRetention ? <p className="text-xs text-on-surface-variant mt-3">Older trades are beyond the RPC&apos;s retention window.</p> : want < 2000 && <button disabled={query.isFetching} onClick={() => setWant(n => Math.min(2000, n + 100))} className="text-primary text-sm underline mt-3 disabled:opacity-50">{query.isFetching ? "Loading…" : "Load older"}</button>}
    {want === 2000 && <p className="text-xs text-on-surface-variant mt-3">Showing up to the newest 2,000 trades.</p>}
  </section>;
}
