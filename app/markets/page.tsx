"use client";

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useBurstFeed } from "@/lib/realtime/useBurst";
import { formatFeedTime } from "@/lib/realtime/format";
import { RealtimeProfiler } from "@/components/realtime-profiler";
import Link from "next/link";
import { useMarkets } from "@/lib/hooks/useMarkets";
import { useOnChainMarket, useOnChainMarkets, type OnChainMarketView } from "@/lib/hooks/useStellar";
import type { Market, MarketStatus, MarketTracePreview } from "@/lib/api/markets";
import { BACKEND_CATEGORIES, BACKEND_CATEGORY_LABELS } from "@/lib/stellar/categories";
import { formatUsdc } from "@/lib/stellar/units";

/** Where a displayed value came from, wherever backend and chain can disagree. */
const SourceTag = ({ source }: { source: "chain" | "backend" }) => (
  <span
    title={source === "chain" ? "Read live from the market contract" : "OracleDesk backend estimate; may lag the chain"}
    className={`ml-1 text-[9px] font-bold uppercase px-1 rounded ${source === "chain" ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-highest text-on-surface-variant"}`}
  >
    {source}
  </span>
);

function chainStatusLabel(view: OnChainMarketView | undefined): string {
  if (!view) return "—";
  const status = view.market.status;
  if (status.tag === "Resolved") return `Resolved ${status.values[0].tag.toUpperCase()}`;
  return status.tag === "Void" ? "Voided" : "Open";
}

const FilterBar = ({ 
  status, 
  setStatus, 
  category, 
  setCategory 
}: { 
  status: string; 
  setStatus: (s: string) => void;
  category: string;
  setCategory: (c: string) => void;
}) => {
  return (
    <section className="mb-8 bg-surface-container-low p-4 rounded-xl border border-outline-variant">
      <div className="flex flex-col lg:flex-row gap-4 justify-between items-center">
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          <div className="relative flex-grow min-w-[240px]">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
            <input 
              className="w-full pl-10 pr-4 py-2 bg-surface border border-outline-variant rounded-lg text-body-md focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all" 
              placeholder="Search markets, assets, or events..." 
              type="text"
            />
          </div>
          <select 
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="bg-surface border border-outline-variant rounded-lg px-4 py-2 text-label-caps font-label-caps outline-none focus:ring-2 focus:ring-primary cursor-pointer"
          >
            <option value="">All Categories</option>
            {BACKEND_CATEGORIES.map((c) => (
              <option key={c} value={c}>{BACKEND_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-4 w-full lg:w-auto justify-between lg:justify-end">
          <div className="flex bg-surface-container rounded-lg p-1 border border-outline-variant">
            <button 
              onClick={() => setStatus("ACTIVE")}
              className={`px-4 py-1.5 text-label-caps font-label-caps shadow-sm rounded-md transition-all ${status === "ACTIVE" ? "bg-surface text-primary font-bold" : "text-on-surface-variant hover:text-primary"}`}
            >
              Live
            </button>
            <button 
              onClick={() => setStatus("RESOLVED")}
              className={`px-4 py-1.5 text-label-caps font-label-caps shadow-sm rounded-md transition-all ${status === "RESOLVED" ? "bg-surface text-primary font-bold" : "text-on-surface-variant hover:text-primary"}`}
            >
              Resolved
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-secondary animate-pulse motion-reduce:animate-none"></span>
            <span className="font-data-mono text-label-caps text-secondary uppercase">Stellar Testnet</span>
          </div>
        </div>
      </div>
    </section>
  );
};

interface MarketCardProps {
  href: string;
  category: string;
  onChainMarketId: string | null;
  reasoningTraces?: MarketTracePreview[];
  expiry: string;
  title: string;
  /** Backend estimate, 0-100, used when the market isn't on-chain. */
  backendYesProb: number | null;
  backendLiquidity: string | null;
}

const MarketCard = ({ href, category, onChainMarketId, reasoningTraces, expiry, title, backendYesProb, backendLiquidity }: MarketCardProps) => {
  const chain = useOnChainMarket(onChainMarketId);
  const view = chain.data;
  const fromChain = Boolean(view);
  const yesProb = view ? Math.round(view.yesBps / 100) : backendYesProb ?? 50;
  const noProb = 100 - yesProb;
  const liquidity = view
    ? `$${formatUsdc(view.market.sets_minted, { maxDecimals: 2, grouping: true })}`
    : backendLiquidity ?? "—";
  const platform = onChainMarketId !== null ? `On-chain #${onChainMarketId}` : "Not on-chain yet";
  const latestTrace = reasoningTraces?.[0];
  const aiSignal = latestTrace ? (latestTrace.edge > 0.05 ? "BULLISH" : latestTrace.edge < -0.05 ? "BEARISH" : "NEUTRAL") : "ANALYZING";
  const aiStatus = latestTrace ? `${Math.abs(latestTrace.edge * 100).toFixed(1)}% EDGE` : "STABLE";
  const id = href;
  const volume24h = chainStatusLabel(view);
  
  return (
    <motion.div 
      whileHover={{ y: -4 }}
      className="group bg-surface border border-outline-variant rounded-xl overflow-hidden hover:shadow-lg hover:border-primary/30 transition-all flex flex-col"
    >
      <div className="p-5 flex-grow">
        <div className="flex justify-between items-start mb-4">
          <div className="flex gap-2 flex-wrap">
            <span className={`px-2 py-1 rounded text-label-caps font-bold uppercase tracking-wider ${onChainMarketId !== null ? 'bg-primary-container text-on-primary-container border border-primary/20' : 'bg-surface-container-highest text-on-surface-variant'}`}>
              {platform}
            </span>
            <span className="bg-surface-container-highest text-on-surface-variant px-2 py-1 rounded text-label-caps font-bold uppercase tracking-wider">{category}</span>
            <div className={`flex items-center gap-1 px-2 py-1 rounded ${aiSignal === 'NEUTRAL' || aiSignal === 'ANALYZING' ? 'bg-surface-container-highest' : aiSignal === 'BEARISH' ? 'bg-tertiary-fixed/30' : 'bg-secondary-fixed/30'}`}>
              <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                {aiSignal === 'ANALYZING' ? 'sync' : aiSignal === 'NEUTRAL' ? 'psychology' : aiSignal === 'BULLISH' ? 'trending_up' : 'trending_down'}
              </span>
              <span className={`${aiSignal === 'NEUTRAL' || aiSignal === 'ANALYZING' ? 'text-on-surface-variant' : aiSignal === 'BEARISH' ? 'text-tertiary' : 'text-secondary'} text-label-caps font-bold uppercase`}>
                AI {aiSignal}: {aiStatus}
              </span>
            </div>
          </div>
          <span className="font-data-mono text-label-caps text-on-surface-variant">EXP: {expiry}</span>
        </div>
        <Link href={id} className="block">
          <h3 className="font-headline-sm text-headline-sm text-on-surface mb-6 group-hover:text-primary transition-colors line-clamp-3">
            {title}
          </h3>
        </Link>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-label-caps font-label-caps mb-2">
              <span className="text-secondary">YES {yesProb}%<SourceTag source={fromChain ? "chain" : "backend"} /></span>
              <span className="text-tertiary">NO {noProb}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-outline-variant overflow-hidden flex">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${yesProb}%` }}
                className="h-full bg-secondary transition-all duration-700" 
              />
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${noProb}%` }}
                className="h-full bg-tertiary transition-all duration-700" 
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
            <div>
              <p className="text-label-caps text-on-surface-variant uppercase mb-1">Liquidity<SourceTag source={fromChain ? "chain" : "backend"} /></p>
              <p className="font-data-mono text-body-md">{liquidity}</p>
            </div>
            <div>
              <p className="text-label-caps text-on-surface-variant uppercase mb-1">On-chain status</p>
              <p className={`font-data-mono text-body-md ${volume24h === 'Open' ? 'text-secondary' : 'text-on-surface-variant'}`}>
                {chain.isLoading ? "…" : volume24h}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="p-3 grid grid-cols-2 gap-2 bg-surface-container-low border-t border-outline-variant">
        <Link href={`${id}&side=YES`} className="bg-secondary text-primary-foreground py-2.5 rounded-lg font-label-caps text-label-caps font-bold hover:brightness-110 active:opacity-80 transition-all uppercase text-center">Bet Yes</Link>
        <Link href={`${id}&side=NO`} className="bg-tertiary text-primary-foreground py-2.5 rounded-lg font-label-caps text-label-caps font-bold hover:brightness-110 active:opacity-80 transition-all uppercase text-center">Bet No</Link>
      </div>    </motion.div>
  );
};

const TradingFeed = () => {
  const { rows, burst } = useBurstFeed({ capacity: 8, type: "TRADE_EXECUTED" });
  const reduceMotion = useReducedMotion();
  const feed = rows.flatMap(event => {
    if (event.type !== "TRADE_EXECUTED") return [];
    const data = event.payload;
    return [{
      key: data.eventId,
      time: formatFeedTime(data.closedAt ?? event.receivedAt) + (data.closedAt ? "" : " received"),
      market: data.marketQuestion || `Market #${data.onChainMarketId}`,
      size: `$${formatUsdc(BigInt(data.collateralRaw), { maxDecimals: 2, grouping: true })}`,
      bet: `${data.isBuy ? "BUY" : "SELL"} ${data.direction}`,
      prob: `YES ${(data.priceYesBps / 100).toFixed(1)}%`,
      color: data.direction === "YES" ? "text-secondary" : "text-tertiary",
    }];
  });
  const animate = !reduceMotion && !burst;
  const tableRows = feed.map(row => {
    const cells = <>
      <td className="py-3 text-on-surface-variant">{row.time}</td>
      <td className="py-3">{row.market}</td>
      <td className="py-3 text-right">{row.size}</td>
      <td className={`py-3 text-right ${row.color} font-bold`}>{row.bet}</td>
      <td className="py-3 text-right">{row.prob}</td>
    </>;
    const className = "hover:bg-surface-container transition-colors border-b border-outline-variant/30";
    return animate
      ? <motion.tr key={row.key} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className={className}>{cells}</motion.tr>
      : <tr key={row.key} className={className}>{cells}</tr>;
  });

  return (
    <section className="mt-12">
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-outlined text-primary">analytics</span>
        <h2 className="font-headline-sm text-headline-sm uppercase tracking-tight">Real-time Trading Feed</h2>
      </div>
      {burst && <p className="text-xs text-on-surface-variant mb-2">{burst.count} trades in the last second{burst.overflow ? ` · ${burst.overflow} more events while this tab was hidden` : ""}.</p>}
      <div className="terminal-log-flow border border-outline-variant rounded-xl overflow-hidden bg-white">
        <div className="p-4 overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-outline-variant">
                <th className="pb-3 text-label-caps text-on-surface-variant">Time</th>
                <th className="pb-3 text-label-caps text-on-surface-variant">Market</th>
                <th className="pb-3 text-label-caps text-on-surface-variant text-right">Size</th>
                <th className="pb-3 text-label-caps text-on-surface-variant text-right">Bet</th>
                <th className="pb-3 text-label-caps text-on-surface-variant text-right">Probability</th>
              </tr>
            </thead>
            <tbody key={animate ? "animated" : "static"} className="font-data-mono text-body-md">
              {feed.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-on-surface-variant">Waiting for on-chain trades…</td></tr>}
              {animate ? <AnimatePresence initial={false}>{tableRows}</AnimatePresence> : tableRows}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

function OnChainOnlyMarkets({ knownIds }: { knownIds: Set<string> }) {
  const { data, isLoading, error } = useOnChainMarkets(12);
  const orphans = (data ?? []).filter((v) => !knownIds.has(v.id));
  if (isLoading || error || orphans.length === 0) return null;
  return (
    <section className="mt-12">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-outlined text-primary">link</span>
        <h2 className="font-headline-sm text-headline-sm uppercase tracking-tight">On-chain markets without OracleDesk metadata</h2>
      </div>
      <p className="text-on-surface-variant text-sm mb-4">
        These markets exist on the market contract but the backend has no record of them, so only on-chain data is shown.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {orphans.map((v) => (
          <MarketCard
            key={v.id}
            href={`/markets/quick-view?onChainId=${v.id}`}
            category={v.market.category.tag}
            onChainMarketId={v.id}
            expiry={new Date(Number(v.market.close_time) * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()}
            title={`Market #${v.id} · ${v.market.meta_uri}`}
            backendYesProb={null}
            backendLiquidity={null}
          />
        ))}
      </div>
    </section>
  );
}

export default function Markets() {
  const [status, setStatus] = useState<MarketStatus>("ACTIVE");
  const [category, setCategory] = useState<string>("");
  const { data, isLoading, error } = useMarkets({ 
    status, 
    category: (category || undefined) as Market["category"] | undefined,
  });
  const marketsData = data?.markets ?? [];
  const knownIds = new Set(marketsData.flatMap((m) => (m.onChainMarketId ? [m.onChainMarketId] : [])));

  return (
    <div className="min-h-screen bg-surface">
      <main className="pt-24 pb-12 px-gutter max-w-container-max-width mx-auto">
        <FilterBar 
          status={status} 
          setStatus={(s) => setStatus(s as MarketStatus)} 
          category={category} 
          setCategory={setCategory} 
        />
        
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-64 bg-surface-container-low animate-pulse motion-reduce:animate-none rounded-xl border border-outline-variant"></div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-12 bg-surface-container-low rounded-xl border border-error/20">
            <span className="material-symbols-outlined text-error text-4xl mb-4">error</span>
            <p className="text-on-surface-variant font-medium">Failed to load markets.</p>
            <p className="text-on-surface-variant/70 text-sm mt-2">
              {error instanceof Error ? error.message : "Please check if the backend is running and accessible."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="mt-6 px-4 py-2 bg-primary text-white rounded-lg font-label-caps text-label-caps"
            >
              Retry Connection
            </button>
          </div>
        ) : marketsData.length === 0 ? (
          <div className="text-center py-12 bg-surface-container-low rounded-xl border border-outline-variant text-on-surface-variant">
            No markets match these filters yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {marketsData.map((m) => {
              const rawProb = m.currentYesProb ?? m.initialYesProb;
              return (
                <MarketCard 
                  key={m.id} 
                  href={`/markets/quick-view?marketId=${m.id}`}
                  category={m.category}
                  onChainMarketId={m.onChainMarketId}
                  reasoningTraces={m.reasoningTraces}
                  expiry={new Date(m.expiryTimestamp).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()}
                  title={m.question}
                  backendYesProb={Math.round(rawProb * 100)}
                  backendLiquidity={`$${(m.totalLiquidity).toLocaleString()}`}
                />
              );
            })}
          </div>
        )}

        <OnChainOnlyMarkets knownIds={knownIds} />

        <RealtimeProfiler id="TradingFeed"><TradingFeed /></RealtimeProfiler>
      </main>
    </div>
  );
}
