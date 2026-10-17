"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { usePortfolio, usePositions } from "@/lib/hooks/usePortfolio";
import { formatUsdc } from "@/lib/stellar/units";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useRedeemAll, type PreparedWriteReview } from "@/lib/hooks/useStellar";
import { shouldSkipTxReview, TxReview, TxReviewPreferenceControl } from "@/components/tx-review";
import type { ReviewModel } from "@/lib/stellar/tx-decode";

const TerminalLog = () => {
  const [logs, setLogs] = useState([
    { text: "[2026-05-14 09:32:11] INITIALIZING ORACLE PROTOCOL...", color: "opacity-50" },
    { text: "[SUCCESS] Market Resolution Detected: ETH_PRICE_MAY_26 -> YES (100.00%)", color: "text-secondary-fixed" },
    { text: "[INFO] Wallet 0x8a1...f3e claimed 820.00 USDC in rewards.", color: "" },
    { text: "[TRADE] Order Executed: SELL 500 'NO' Contracts on 'SpaceX_Mars_2026' at $0.42.", color: "" },
    { text: "[PNL] Portfolio unrealized profit increased by 1.2% in last 60 minutes.", color: "" },
    { text: "[SYSTEM] Syncing with Polymarket API... Node latency 14ms.", color: "text-surface-dim opacity-70" },
    { text: "[SUCCESS] Limit order filled: 10,000 YES contracts @ $0.62.", color: "text-secondary-fixed" },
  ]);

  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const newLogOptions = [
        `[${time}] [HEARTBEAT] Pinged primary oracle cluster... 8ms`,
        `[${time}] [UPDATE] Price Feed updated for BTC/USD: $64,210.04`,
        `[${time}] [SECURE] Wallet session verified via ECDSA signature.`,
        `[${time}] [INFO] New liquidity detected in Election markets.`
      ];
      const randomLog = newLogOptions[Math.floor(Math.random() * newLogOptions.length)];
      setLogs(prev => [...prev.slice(-19), { text: randomLog, color: "text-surface-dim opacity-40 animate-pulse" }]);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <section className="lg:col-span-2 bg-on-background rounded shadow-lg overflow-hidden border border-outline">
      <div className="px-4 py-3 border-b border-outline/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-error"></div>
          <div className="w-3 h-3 rounded-full bg-secondary-fixed"></div>
          <div className="w-3 h-3 rounded-full bg-primary-fixed"></div>
          <span className="font-data-mono text-[11px] text-surface-variant ml-4 uppercase tracking-widest">Transaction & Performance Log</span>
        </div>
        <span className="material-symbols-outlined text-surface-variant text-[18px]">terminal</span>
      </div>
      <div 
        ref={terminalRef}
        className="p-6 h-[400px] overflow-y-auto font-data-mono text-[12px] text-primary-fixed-dim leading-relaxed scrollbar-hide scroll-smooth"
      >
        {logs.map((log, i) => (
          <div key={i} className={`mb-2 ${log.color}`}>
            {log.text}
          </div>
        ))}
        <div className="text-surface-dim opacity-40">... streaming real-time events ...</div>
      </div>
    </section>
  );
};

interface PositionRowProps {
  market: string;
  category: string;
  platform: string;
  side: string;
  sideColor: string;
  entry: string;
  prob: number;
  yesNo: string;
  size: string;
  pnl: string;
  pnlPercent: string;
  pnlColor: string;
  status: string;
  resolved?: boolean;
  claimable?: boolean;
}

const PositionRow = ({ market, category, platform, side, sideColor, entry, prob, yesNo, size, pnl, pnlPercent, pnlColor, status, resolved, claimable }: PositionRowProps) => {
  return (
    <tr className={`transition-colors border-b border-outline-variant hover:bg-surface-container/50 ${resolved ? 'bg-surface-container-highest' : ''}`}>
      <td className="px-6 py-4 font-body-md text-on-surface max-w-xs">
        <span className="block truncate font-semibold">{market}</span>
        <span className="text-[11px] text-outline uppercase">{category} • {platform}</span>
      </td>
      <td className="px-4 py-4">
        <span className={`${sideColor} px-2 py-0.5 rounded text-[11px] font-bold`}>{side}</span>
      </td>
      <td className="px-4 py-4 text-right font-data-mono">{entry}</td>
      <td className="px-4 py-4">
        <div className="flex flex-col gap-1 w-32 mx-auto">
          <div className="flex justify-between text-[10px] text-outline font-bold">
            <span>{prob}%</span>
            <span>{yesNo}</span>
          </div>
          <div className="h-1 bg-outline-variant rounded-full overflow-hidden relative">
            <div 
              className={`h-full absolute left-0 top-0 ${side === 'YES' ? 'bg-secondary' : 'bg-tertiary'}`} 
              style={{ width: `${prob}%` }}
            ></div>
          </div>
        </div>
      </td>
      <td className="px-4 py-4 text-right font-data-mono">{size}</td>
      <td className="px-4 py-4 text-right font-data-mono">
        <div className={`${pnlColor} font-bold`}>{pnl}</div>
        <div className={`text-[11px] ${pnlColor === 'text-secondary' ? 'text-secondary-container bg-on-secondary-fixed-variant' : 'text-tertiary-container bg-error-container'} px-1 rounded inline-block`}>
          {pnlPercent}
        </div>
      </td>
      <td className="px-4 py-4 text-center">
        <span className={`text-[10px] ${resolved ? 'bg-on-background text-surface' : 'bg-primary-container text-on-primary-container'} px-2 py-0.5 rounded-full uppercase`}>
          {status}
        </span>
      </td>
      <td className="px-6 py-4 text-right space-x-2">
        {claimable ? (
          <button 
            className="bg-secondary text-primary-foreground px-3 py-1 rounded font-label-caps text-[10px] uppercase shadow-sm active:scale-95 transition-transform"
            onClick={() => alert("Reward claiming coming soon.")}
          >
            Claim Rewards
          </button>
        ) : (
          <>
            <button 
              className="text-primary hover:underline font-label-caps text-label-caps"
              onClick={() => alert("Position management coming soon.")}
            >
              Manage
            </button>
            <button 
              className="text-tertiary hover:underline font-label-caps text-label-caps"
              onClick={() => alert("Closing functionality coming soon.")}
            >
              Close
            </button>
          </>
        )}
      </td>
    </tr>
  );
};

export default function PortfolioPage() {
  const [status, setStatus] = useState<"OPEN" | "CLOSED">("OPEN");
  const wallet = useWallet();
  const redeemBatch = useRedeemAll();
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const { data: summary, isLoading: isSummaryLoading } = usePortfolio();
  const { data: positionsData, isLoading: isPositionsLoading } = usePositions({ status });
  const positions = positionsData?.positions ?? [];
  const currentRedeemIds = new Set(redeemBatch.discovery?.redeemables.map((item) => item.marketId.toString()) ?? []);
  const currentRedeemed = redeemBatch.discovery?.redeemables.filter(
    (item) => redeemBatch.states[item.marketId.toString()]?.s === "redeemed",
  ) ?? [];
  const expectedRedeemTotal = redeemBatch.discovery?.redeemables.reduce((total, item) => total + item.expectedPayout, 0n) ?? 0n;
  const redeemedPayoutTotal = currentRedeemed.reduce(
    (total, item) => {
      const state = redeemBatch.states[item.marketId.toString()];
      return total + (state?.s === "redeemed" ? state.payout : 0n);
    },
    0n,
  );
  const resumedItems = Object.entries(redeemBatch.states).filter(([id, item]) =>
    !currentRedeemIds.has(id) && (item.s === "redeemed" || item.s === "failed" || item.s === "skipped"),
  );
  const reviewRedeem = useCallback<PreparedWriteReview>(async (_prepared, model, changedFrom, forceReview = false) => {
    if (!forceReview && shouldSkipTxReview()) return true;
    return new Promise<boolean>((resolve) => {
      reviewResolver.current = resolve;
      setReviewModel({ model, changedFrom });
    });
  }, []);
  const closeReview = useCallback((approved: boolean) => {
    setReviewModel(null);
    const resolve = reviewResolver.current;
    reviewResolver.current = null;
    resolve?.(approved);
  }, []);

  useEffect(
    () => () => {
      const resolve = reviewResolver.current;
      reviewResolver.current = null;
      resolve?.(false);
    },
    [],
  );

  return (
    <main className="max-w-container-max-width mx-auto px-gutter py-8">
      {/* Portfolio Header / Summary */}
      <section className="mb-8 flex flex-col md:flex-row justify-between items-end gap-6">
        <div>
          <h1 className="font-display-lg text-display-lg text-on-background mb-1">Portfolio Performance</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">Institutional grade overview of your prediction market exposure.</p>
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="bg-white border border-outline-variant p-4 rounded min-w-[160px] shadow-sm">
            <div className="font-label-caps text-label-caps text-outline mb-1">EQUITY (USDC)</div>
            <div className="font-headline-sm text-headline-sm text-on-background">
              {isSummaryLoading ? "..." : `$${summary?.totalUsdc.toLocaleString()}`}
            </div>
            <div className={`text-[12px] font-bold ${(summary?.dailyPnl ?? 0) >= 0 ? 'text-secondary' : 'text-tertiary'} flex items-center gap-1 mt-1`}>
              <span className="material-symbols-outlined text-[14px]">
                {(summary?.dailyPnl ?? 0) >= 0 ? 'arrow_upward' : 'arrow_downward'}
              </span> 
              {isSummaryLoading ? "0.0%" : `${Math.abs(summary?.dailyPnl ?? 0).toFixed(2)}%`}
            </div>
          </div>
          
          <div className="bg-white border border-outline-variant p-4 rounded min-w-[160px] shadow-sm">
            <div className="font-label-caps text-label-caps text-outline mb-1">TREASURY CAPITAL</div>
            <div className="font-headline-sm text-headline-sm text-secondary">
              {isSummaryLoading ? "..." : summary?.availableCapitalRaw ? `${formatUsdc(BigInt(summary.availableCapitalRaw), { maxDecimals: 2, grouping: true })} USDC` : "—"}
            </div>
            <div className="text-[10px] font-bold text-on-surface-variant mt-1">Read live from the treasury contract</div>
          </div>

          <div className="bg-white border border-outline-variant p-4 rounded min-w-[160px] shadow-sm">
            <div className="font-label-caps text-label-caps text-outline mb-1">ACTIVE POSITIONS</div>
            <div className="font-headline-sm text-headline-sm text-on-background">
              {isSummaryLoading ? "..." : summary?.openPositions}
            </div>
            <div className="text-[12px] font-medium text-on-surface-variant mt-1">Managed by OracleDesk</div>
          </div>
        </div>
      </section>

      {/* J4: Unified Gateway Balance Widget */}
      <section className="mb-12 bg-primary-container/10 border border-primary/20 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center text-on-primary">
            <span className="material-symbols-outlined">account_balance_wallet</span>
          </div>
          <div>
            <h3 className="font-headline-sm text-headline-sm">Agent Treasury</h3>
            <p className="text-on-surface-variant text-sm">USDC the agent can trade with, capped on-chain by the treasury contract</p>
          </div>
        </div>
        <div className="flex gap-8">
          <div className="text-center">
            <div className="font-label-caps text-[10px] text-outline mb-1">AVAILABLE (STELLAR TESTNET)</div>
            <div className="font-data-mono font-bold text-lg text-primary">{summary?.availableCapitalRaw ? formatUsdc(BigInt(summary.availableCapitalRaw), { maxDecimals: 2, grouping: true }) : "—"} USDC</div>
          </div>
          <div className="w-px h-10 bg-outline-variant self-center"></div>
          <div className="text-center">
            <div className="font-label-caps text-[10px] text-outline mb-1">DEPLOYED (BACKEND RECORD)</div>
            <div className="font-data-mono font-bold text-lg text-secondary">{(summary?.deployedCapital ?? 0).toLocaleString()} USDC</div>
          </div>
        </div>
      </section>

      <section className="mb-12 rounded-xl border border-outline-variant bg-white p-6 shadow-sm" aria-labelledby="connected-redemptions-title">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 id="connected-redemptions-title" className="font-headline-sm text-headline-sm text-on-surface">
              Connected wallet redemptions
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">
              Scan on-chain positions for resolved markets and redeem them one at a time. Each transaction is signed separately by your wallet.
            </p>
            <div className="mt-2">
              <TxReviewPreferenceControl />
            </div>
            {redeemBatch.discovery && (
              <p className="mt-2 text-xs text-on-surface-variant" role="status">
                Scanned {redeemBatch.discovery.scannedMarkets.toString()} of {redeemBatch.discovery.totalMarkets.toString()} markets; found{" "}
                {redeemBatch.discovery.redeemables.length} redeemable position(s).
                {redeemBatch.discovery.scanLimited ? " The scan limit was reached; newer markets were checked first." : ""}
              </p>
            )}
            {redeemBatch.discovery && redeemBatch.discovery.redeemables.length > 0 && (
              <p className="mt-1 text-xs text-on-surface-variant">
                Expected total: {formatUsdc(expectedRedeemTotal, { maxDecimals: 2, grouping: true })} USDC ·
                {" "}{currentRedeemed.length} of {redeemBatch.discovery.redeemables.length} redeemed
                {currentRedeemed.length > 0
                  ? ` (${formatUsdc(redeemedPayoutTotal, { maxDecimals: 2, grouping: true })} USDC received)`
                  : ""}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void redeemBatch.scan()}
              disabled={!wallet.isConnected || wallet.isWrongNetwork || redeemBatch.scanning || redeemBatch.running}
              className="rounded border border-outline-variant px-4 py-2 text-sm font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {redeemBatch.scanning ? "Scanning ledger…" : "Scan wallet"}
            </button>
            <button
              type="button"
              onClick={() => void redeemBatch.redeemAll(reviewRedeem)}
              disabled={!wallet.isConnected || wallet.isWrongNetwork || !redeemBatch.discovery?.redeemables.length || redeemBatch.running || redeemBatch.scanning}
              className="rounded bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Redeem all
            </button>
            {redeemBatch.running ? (
              <button type="button" onClick={redeemBatch.cancel} className="rounded border border-outline-variant px-4 py-2 text-sm font-semibold">
                Stop after current
              </button>
            ) : Object.values(redeemBatch.states).some((item) => item.s === "failed") ? (
              <button
                type="button"
                onClick={() => void redeemBatch.retryFailed(reviewRedeem)}
                className="rounded border border-outline-variant px-4 py-2 text-sm font-semibold"
              >
                Retry failed
              </button>
            ) : null}
          </div>
        </div>

        {!wallet.isConnected && <p className="mt-4 text-sm text-on-surface-variant">Connect a Stellar wallet to scan your positions.</p>}
        {wallet.isWrongNetwork && <p className="mt-4 text-sm text-error">Switch your wallet to Stellar Testnet to redeem positions.</p>}
        {redeemBatch.error && <p className="mt-4 text-sm text-error" role="alert">{redeemBatch.error}</p>}

        {redeemBatch.discovery && redeemBatch.discovery.redeemables.length > 0 && (
          <ul className="mt-5 divide-y divide-outline-variant rounded border border-outline-variant">
            {redeemBatch.discovery.redeemables.map((item) => {
              const id = item.marketId.toString();
              const itemState = redeemBatch.states[id] ?? { s: "queued" as const };
              const payout = formatUsdc(item.expectedPayout, { maxDecimals: 2, grouping: true });
              return (
                <li key={id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-on-surface">Market #{id} · {item.settlement.toUpperCase()} winner</p>
                    <p className="text-sm text-on-surface-variant">
                      Estimated payout: {payout} USDC
                      {item.archived ? " · archived ledger entry" : ""}
                    </p>
                    {itemState.s === "failed" && <p className="mt-1 text-sm text-error">{itemState.error}</p>}
                    {itemState.s === "redeemed" && <p className="mt-1 text-sm text-secondary">Redeemed · {formatUsdc(itemState.payout, { maxDecimals: 2, grouping: true })} USDC</p>}
                    {itemState.s === "signing" && <p className="mt-1 text-sm text-primary">Waiting for wallet signature…</p>}
                    {itemState.s === "submitting" && <p className="mt-1 text-sm text-primary">Submitted to Stellar…</p>}
                    {itemState.s === "skipped" && <p className="mt-1 text-sm text-on-surface-variant">Skipped</p>}
                  </div>
                  {!redeemBatch.running && itemState.s !== "redeemed" && itemState.s !== "skipped" && (
                    <button
                      type="button"
                      onClick={() => redeemBatch.skip(id)}
                      className="self-start rounded border border-outline-variant px-3 py-1.5 text-xs font-semibold text-on-surface-variant sm:self-center"
                    >
                      Skip
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {redeemBatch.discovery && redeemBatch.discovery.redeemables.length === 0 && (
          <p className="mt-5 text-sm text-on-surface-variant">No resolved positions are ready to redeem.</p>
        )}
        {resumedItems.length > 0 && (
          <div className="mt-5 border-t border-outline-variant pt-4">
            <h3 className="font-label-caps text-xs font-bold uppercase tracking-wide text-on-surface-variant">
              Saved batch progress
            </h3>
            <ul className="mt-2 space-y-2 text-sm">
              {resumedItems.map(([id, item]) => (
                <li key={id} className="flex flex-wrap justify-between gap-2">
                  <span>Market #{id}</span>
                  <span className={item.s === "failed" ? "text-error" : item.s === "redeemed" ? "text-secondary" : "text-on-surface-variant"}>
                    {item.s === "redeemed"
                      ? `Redeemed · ${formatUsdc(item.payout, { maxDecimals: 2, grouping: true })} USDC`
                      : item.s === "failed"
                        ? item.error
                        : "Skipped"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Detailed Positions Table */}
      <section className="bg-white border border-outline-variant rounded shadow-sm overflow-hidden mb-12">
        <div className="px-6 py-4 border-b border-outline-variant flex flex-col sm:flex-row justify-between items-start sm:items-center bg-surface-container-low gap-4">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Agent {status === 'OPEN' ? 'Open' : 'Resolved'} Positions</h2>
          <div className="flex items-center gap-4">
            <div className="flex bg-surface-container rounded-lg p-1 border border-outline-variant">
              <button 
                onClick={() => setStatus("OPEN")}
                className={`px-4 py-1.5 text-label-caps font-label-caps shadow-sm rounded-md transition-all ${status === "OPEN" ? "bg-surface text-primary font-bold" : "text-on-surface-variant hover:text-primary"}`}
              >
                Open
              </button>
              <button 
                onClick={() => setStatus("CLOSED")}
                className={`px-4 py-1.5 text-label-caps font-label-caps shadow-sm rounded-md transition-all ${status === "CLOSED" ? "bg-surface text-primary font-bold" : "text-on-surface-variant hover:text-primary"}`}
              >
                Resolved
              </button>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left min-w-[1000px]">
            <thead>
              <tr className="bg-surface font-label-caps text-label-caps text-outline border-b border-outline-variant">
                <th className="px-6 py-4 font-semibold">MARKET</th>
                <th className="px-4 py-4 font-semibold">SIDE</th>
                <th className="px-4 py-4 font-semibold text-right">ENTRY</th>
                <th className="px-4 py-4 font-semibold text-center">PROBABILITY</th>
                <th className="px-4 py-4 font-semibold text-right">SIZE</th>
                <th className="px-4 py-4 font-semibold text-right">PNL</th>
                <th className="px-4 py-4 font-semibold text-center">STATUS</th>
                <th className="px-6 py-4 font-semibold text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {isPositionsLoading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-on-surface-variant">Loading positions...</td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-on-surface-variant">No active positions found.</td>
                </tr>
              ) : (
                positions.map((pos) => (
                  <PositionRow 
                    key={pos.id}
                    market={pos.market.question}
                    category={pos.market.category}
                    platform={pos.market.onChainMarketId !== null ? `On-chain #${pos.market.onChainMarketId}` : "Not on-chain"}
                    side={pos.direction}
                    sideColor={pos.direction === 'YES' ? "bg-secondary-container text-on-secondary-container" : "bg-tertiary-container text-on-tertiary-container"}
                    entry={`$${pos.entryPrice.toFixed(2)}`}
                    prob={pos.currentPrice ? Math.round(pos.currentPrice * 100) : 50}
                    yesNo={pos.direction}
                    size={pos.size.toLocaleString()}
                    pnl={(pos.pnl ?? 0) >= 0 ? `+$${Math.abs(pos.pnl ?? 0).toFixed(2)}` : `-$${Math.abs(pos.pnl ?? 0).toFixed(2)}`}
                    pnlPercent={`${(pos.pnl ?? 0) >= 0 ? '+' : ''}${(((pos.pnl ?? 0) / (pos.size * pos.entryPrice)) * 100 || 0).toFixed(1)}%`}
                    pnlColor={(pos.pnl ?? 0) >= 0 ? 'text-secondary' : 'text-tertiary'}
                    status={pos.status}
                    resolved={pos.status !== 'OPEN'}
                    claimable={pos.status === 'CLOSED'}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Performance Log & Reasoning Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <TerminalLog />

        {/* AI Reasoning Sidebar (Oracle Insights) */}
        <aside className="flex flex-col gap-6">
          <div className="bg-surface-container-low border border-outline-variant rounded p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
              <h3 className="font-headline-sm text-headline-sm">Oracle Insight</h3>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant mb-4 leading-relaxed">
              The current exposure to &quot;US Fed Rate Cut&quot; represents 42% of active portfolio risk. Sentiment analysis indicates a bullish divergence on Polymarket vs. prediction on Kalshi.
            </p>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-[12px] p-2 bg-white rounded border border-outline-variant">
                <span className="font-bold text-on-surface">Alpha Score</span>
                <span className="text-secondary font-black">8.4/10</span>
              </div>
              <div className="flex justify-between items-center text-[12px] p-2 bg-white rounded border border-outline-variant">
                <span className="font-bold text-on-surface">Risk Level</span>
                <span className="text-tertiary font-black">Moderate</span>
              </div>
            </div>
          </div>
          
          <div className="bg-white border border-outline-variant rounded overflow-hidden shadow-sm group">
            {/* SVG network graph replacing external image */}
            <div className="relative h-40 overflow-hidden bg-on-background">
              <svg
                className="w-full h-full"
                viewBox="0 0 320 160"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Connection lines */}
                <line x1="160" y1="80" x2="60"  y2="40"  stroke="#004655" strokeWidth="0.8" strokeOpacity="0.4" />
                <line x1="160" y1="80" x2="260" y2="35"  stroke="#004655" strokeWidth="0.8" strokeOpacity="0.4" />
                <line x1="160" y1="80" x2="55"  y2="130" stroke="#004655" strokeWidth="0.8" strokeOpacity="0.4" />
                <line x1="160" y1="80" x2="265" y2="125" stroke="#006c49" strokeWidth="0.8" strokeOpacity="0.4" />
                <line x1="160" y1="80" x2="160" y2="20"  stroke="#004655" strokeWidth="0.8" strokeOpacity="0.3" />
                <line x1="60"  y1="40" x2="160" y2="20"  stroke="#004655" strokeWidth="0.5" strokeOpacity="0.2" />
                <line x1="260" y1="35" x2="265" y2="125" stroke="#006c49" strokeWidth="0.5" strokeOpacity="0.2" />
                {/* Animated pulse lines */}
                <line x1="160" y1="80" x2="60"  y2="40"  stroke="#8bd1e8" strokeWidth="1.5" strokeOpacity="0.6">
                  <animate attributeName="stroke-dashoffset" from="0" to="-120" dur="2s" repeatCount="indefinite" />
                  <animate attributeName="stroke-dasharray" values="4 116; 4 116" dur="2s" repeatCount="indefinite" />
                </line>
                <line x1="160" y1="80" x2="265" y2="125" stroke="#4edea3" strokeWidth="1.5" strokeOpacity="0.6">
                  <animate attributeName="stroke-dashoffset" from="0" to="-120" dur="3s" repeatCount="indefinite" />
                  <animate attributeName="stroke-dasharray" values="4 116; 4 116" dur="3s" repeatCount="indefinite" />
                </line>
                {/* Nodes */}
                <circle cx="160" cy="80"  r="9" fill="#005f73" />
                <circle cx="160" cy="80"  r="14" fill="#005f73" fillOpacity="0.2" />
                <circle cx="60"  cy="40"  r="5" fill="#004655" />
                <circle cx="260" cy="35"  r="5" fill="#004655" />
                <circle cx="55"  cy="130" r="5" fill="#006c49" />
                <circle cx="265" cy="125" r="5" fill="#006c49" />
                <circle cx="160" cy="20"  r="4" fill="#004655" />
                <circle cx="100" cy="115" r="3" fill="#6f797c" />
                <circle cx="220" cy="110" r="3" fill="#6f797c" />
                {/* Label */}
                <text x="160" y="84" textAnchor="middle" fontSize="7" fill="#b2ebff" fontFamily="monospace">NODE</text>
                <text x="160" y="91" textAnchor="middle" fontSize="5" fill="#8bd1e8" fontFamily="monospace">0x71C</text>
              </svg>
              {/* Overlay scan line */}
              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/5 to-transparent pointer-events-none animate-pulse" />
            </div>
            <div className="p-4">
              <h4 className="font-label-caps text-label-caps text-outline mb-2">NETWORK ACTIVITY</h4>
              <div className="flex items-center justify-between">
                <span className="font-body-md text-body-md font-bold">Mainnet Congestion</span>
                <span className="text-secondary font-bold">Low (12 Gwei)</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
      {reviewModel && (
        <TxReview
          model={reviewModel.model}
          changedFrom={reviewModel.changedFrom}
          onConfirm={() => closeReview(true)}
          onCancel={() => closeReview(false)}
        />
      )}
    </main>
  );
}