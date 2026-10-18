"use client";

import React, { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useMarketTrades } from "@/lib/hooks/useMarketTrades";
import { explorerAccount, explorerTx } from "@/lib/stellar/config";
import { formatUsdc, shortAddress } from "@/lib/stellar/units";

const ROW_HEIGHT = 32;
const OVERSCAN = 8;
const COLUMNS = ["Time", "Side", "Type", "Trader", "USDC", "Shares", "Fee", "Price after", "Tx"];

function relativeTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Minimal fixed-row windowing: renders only rows in view plus overscan. */
function useWindow(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(ROW_HEIGHT * 10);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  return { ref, start, end, onScroll: (e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop) };
}

/**
 * Per-market trade tape from market-core Trade events (issue #40).
 * Side and buy/sell are text, not colour alone.
 */
export function TradeTape({ onChainMarketId, limit = 20, compact = false }: { onChainMarketId: string; limit?: number; compact?: boolean }) {
  const { address } = useWallet();
  const tape = useMarketTrades(onChainMarketId, { limit });
  const { ref, start, end, onScroll } = useWindow(tape.rows.length);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const grid = "grid grid-cols-[4.5rem_3rem_3rem_6rem_5rem_5rem_4rem_6rem_3rem] gap-2 items-center";

  return (
    <section className="border border-outline-variant rounded-lg bg-white" aria-label="Recent trades">
      <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant">
        <span className="font-label-caps text-label-caps uppercase font-bold tracking-wider text-on-surface-variant">Recent trades</span>
        <span className="text-[9px] font-bold uppercase px-1 rounded bg-secondary-container text-on-secondary-container" title="Decoded from contract Trade events via Stellar RPC">
          chain
        </span>
      </div>

      {tape.isLoading ? (
        <div className="p-3 space-y-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-5 bg-surface-container-low rounded animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
      ) : tape.isError ? (
        <div className="p-3 text-xs text-error flex items-center gap-2" role="alert">
          Couldn&apos;t load trades from the RPC.
          <button type="button" onClick={() => tape.refetch()} className="text-primary hover:underline font-bold">
            Retry
          </button>
        </div>
      ) : tape.rows.length === 0 ? (
        <p className="p-3 text-xs text-on-surface-variant">No trades on this market in the RPC&apos;s retention window.</p>
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-rowcount={tape.rows.length + 1} className="min-w-[44rem] font-data-mono text-[11px]">
            <div role="row" aria-rowindex={1} className={`${grid} px-3 py-1 text-on-surface-variant border-b border-outline-variant/40`}>
              {COLUMNS.map((c) => (
                <span key={c} role="columnheader" className={c === "USDC" || c === "Shares" || c === "Fee" ? "text-right" : ""}>
                  {c}
                </span>
              ))}
            </div>
            <div ref={ref} onScroll={onScroll} className={`overflow-y-auto ${compact ? "max-h-64" : "max-h-[32rem]"}`}>
              <div style={{ height: tape.rows.length * ROW_HEIGHT, position: "relative" }}>
                {tape.rows.slice(start, end).map((row, i) => {
                  const index = start + i;
                  const moved = row.prevYesBps === null ? 0 : row.yesBpsAfter - row.prevYesBps;
                  const isYou = address !== null && row.trader === address;
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={index + 2}
                      className={`${grid} px-3 absolute left-0 right-0 border-b border-outline-variant/20`}
                      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                    >
                      <span role="cell" title={row.closedAt}>
                        {relativeTime(row.closedAt, now)}
                      </span>
                      <span role="cell" className={`font-bold ${row.outcome === "Yes" ? "text-secondary" : "text-tertiary"}`}>
                        {row.outcome === "Yes" ? "YES" : "NO"}
                      </span>
                      <span role="cell">{row.isBuy ? "BUY" : "SELL"}</span>
                      <span role="cell">
                        <a href={explorerAccount(row.trader)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          {isYou ? "you" : shortAddress(row.trader)}
                        </a>
                      </span>
                      <span role="cell" className="text-right">{formatUsdc(row.collateral, { maxDecimals: 2, grouping: true })}</span>
                      <span role="cell" className="text-right">{formatUsdc(row.shares, { maxDecimals: 2, grouping: true })}</span>
                      <span role="cell" className="text-right">{formatUsdc(row.fee, { maxDecimals: 2, grouping: true })}</span>
                      <span role="cell">
                        {(row.yesBpsAfter / 100).toFixed(1)}%
                        {moved !== 0 && (
                          <span className={moved > 0 ? "text-secondary" : "text-tertiary"}>
                            {" "}
                            {moved > 0 ? "▲" : "▼"}
                            <span className="sr-only">{moved > 0 ? "up" : "down"}</span> {(Math.abs(moved) / 100).toFixed(1)}
                          </span>
                        )}
                        {row.origin === "socket" && <span className="sr-only"> (live, unconfirmed by RPC)</span>}
                      </span>
                      <span role="cell">
                        <a href={explorerTx(row.txHash)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" aria-label={`Transaction ${row.txHash.slice(0, 8)}`}>
                          {row.txHash.slice(0, 4)}…
                        </a>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {!tape.isLoading && !tape.isError && (
        <div className="px-3 py-2 border-t border-outline-variant text-[11px] text-on-surface-variant flex items-center justify-between gap-2">
          {tape.reachedRetention ? (
            <span>Older trades are beyond the RPC&apos;s retention window.</span>
          ) : (
            <button type="button" onClick={tape.loadOlder} disabled={tape.isFetching} className="text-primary font-bold hover:underline disabled:opacity-50">
              {tape.isFetching ? "Loading…" : "Load older"}
            </button>
          )}
          <span>USDC is gross in for buys, net out for sells; fee shown separately.</span>
        </div>
      )}
    </section>
  );
}
