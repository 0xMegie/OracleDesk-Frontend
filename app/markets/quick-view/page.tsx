"use client";

import { TxReview, TxReviewPreferenceControl, shouldSkipTxReview } from "@/components/tx-review";
import type { ReviewModel } from "@/lib/stellar/tx-decode";
import { useSubmitQueueState } from "@/lib/stellar/submit-queue";


import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useMarket } from "@/lib/hooks/useMarkets";
import { getMarketByOnChainId } from "@/lib/api/markets";
import { ApiError } from "@/lib/api/client";
import { useBuy, useOnChainMarket, usePosition, useQuoteBuy, useUsdcBalance, useAccountReserve, usePrepareBuy, useMarketConfig, useLedgerNow, useEnableUsdc, useUsdcTrustline, useExactBuyQuote, usePositionState, useUsdcBalanceState } from "@/lib/hooks/useStellar";
import { useWallet } from "@/lib/contexts/WalletContext";
import { explorerTx } from "@/lib/stellar/config";
import { formatUsdc, formatXlm, maxIn, minOut, tryParseUsdc } from "@/lib/stellar/units";
import { buyBreakdown } from "@/lib/stellar/buy-breakdown";

import type { TxPhase } from "@/lib/stellar/tx-lifecycle";
import { preflightBuy } from "@/lib/stellar/preflight";
import { useLedgerNow as useLedgerClock } from "@/lib/stellar/ledger-clock";
import { MIN_TX_TIMEOUT_S, SAFETY_MARGIN_S } from "@/lib/stellar/deadline";
import { TradeTape } from "@/components/market/trade-tape";
import { PendingValue } from "@/components/pending-value";

const SLIPPAGE_BPS = 100; // 1%

const SourceTag = ({ source }: { source: "chain" | "backend" }) => (
  <span
    title={source === "chain" ? "Read live from the market contract" : "OracleDesk backend estimate; may lag the chain"}
    className={`ml-1 text-[9px] font-bold uppercase px-1 rounded ${source === "chain" ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-highest text-on-surface-variant"}`}
  >
    {source}
  </span>
);

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function MarketQuickViewPage() {
  return (
    <Suspense
      fallback={
        <main className="relative min-h-[calc(100vh-64px)] overflow-hidden bg-surface flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </main>
      }
    >
      <MarketQuickViewContent />
    </Suspense>
  );
}

function renderTxPhase(phase: TxPhase): string | null {
  switch (phase.name) {
    case "building":
      return null;
    case "simulating":
      return "Simulating transaction…";
    case "awaiting-signature":
      return "Waiting for your wallet…";
    case "submitting":
      return "Sending to the network…";
    case "pending":
      return "Waiting for a ledger…";
    case "confirmed":
      return "Transaction confirmed.";
    case "failed":
      return phase.error.message;
    case "expired":
      return "Transaction expired without confirmation.";
  }
}

function MarketQuickViewContent() {
  const searchParams = useSearchParams();
  const marketId = searchParams.get("marketId");
  const onChainIdParam = searchParams.get("onChainId");
  const initialSide = searchParams.get("side") === "NO" ? "No" : "Yes";

  const backendById = useMarket(marketId ?? undefined);
  // Opened from an on-chain id: the backend may or may not know this market.
  const backendByChainId = useQuery({
    queryKey: ["market-by-chain-id", onChainIdParam],
    queryFn: () => getMarketByOnChainId(onChainIdParam as string),
    enabled: Boolean(onChainIdParam) && !marketId,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const market = backendById.data ?? backendByChainId.data ?? null;
  const onChainMarketId = market?.onChainMarketId ?? onChainIdParam ?? null;
  const chain = useOnChainMarket(onChainMarketId);

  const { address, isConnected, isWrongNetwork, openModal } = useWallet();
  const position = usePosition(onChainMarketId, address);
  const balance = useUsdcBalance(address);
  const reserve = useAccountReserve(address);
  const positionState = usePositionState(onChainMarketId, address);
  const balanceState = useUsdcBalanceState(address);
  const config = useMarketConfig();
  const ledgerNow = useLedgerNow();
  const ledger = useLedgerClock();
  const trustline = useUsdcTrustline(address);
  const enableUsdc = useEnableUsdc();
  const trustlineMissing = trustline.data?.kind === "missing";
  const trustlineUnauthorized = trustline.data?.kind === "present" && !trustline.data.authorized;
  const buy = useBuy();
  const submitQueue = useSubmitQueueState(address);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);
  const [showModal] = useState(true);
  const [side, setSide] = useState<"Yes" | "No">(initialSide);
  const [amountInput, setAmountInput] = useState("10");
  const [buyMode, setBuyMode] = useState<"usdc" | "shares">("usdc");
  const [buyStatus, setBuyStatus] = useState<string | null>(null);
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const amountRaw = tryParseUsdc(amountInput);
  const debouncedAmount = useDebounced(amountRaw, 400);
  const exactQuote = useExactBuyQuote(onChainMarketId, side, buyMode === "shares" ? debouncedAmount : null);
  const spendRaw = buyMode === "shares" ? exactQuote.data?.collateralIn ?? null : amountRaw;
  const quote = useQuoteBuy(onChainMarketId, side, buyMode === "usdc" ? debouncedAmount : spendRaw);
  const prepareBuy = usePrepareBuy({ marketId: onChainMarketId, outcome: side, collateralIn: spendRaw, slippageBps: SLIPPAGE_BPS, holder: address });
  const fees = prepareBuy.data?.fees;
  const isUnfunded = reserve.data?.funded === false;
  const isInsufficientXlm = !!(reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable);
  const xlmDeficit = reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable ? fees.totalFee - reserve.data.spendable : 0n;
  const closeReview = useCallback((approved: boolean) => {
    setReviewModel(null); reviewResolver.current?.(approved); reviewResolver.current = null;
  }, []);
  const review = useCallback(async (_prepared: unknown, model: ReviewModel, changedFrom?: ReviewModel, force = false) => {
    if (!force && shouldSkipTxReview()) return true;
    setReviewModel({ model, changedFrom });
    return new Promise<boolean>(resolve => { reviewResolver.current = resolve; });
  }, []);
  useEffect(() => () => { reviewResolver.current?.(false); }, []);
  const view = chain.data;
  const breakdown = view && debouncedAmount && debouncedAmount > 0n
    ? (() => {
        const [bought, other] = side === "Yes" ? [view.market.reserve_yes, view.market.reserve_no] : [view.market.reserve_no, view.market.reserve_yes];
        try { return buyBreakdown(bought, other, debouncedAmount, BigInt(view.market.fee_bps)); } catch { return null; }
      })()
    : null;

  // Illustrative only: there is no price history source yet.
  const sparklinePath = "M0 25 L10 22 L20 28 L30 18 L40 20 L50 15 L60 17 L70 10 L80 12 L90 5 L100 8";

  const fromChain = Boolean(view);
  const backendProb = market ? Math.round((market.currentYesProb ?? market.initialYesProb) * 100) : 50;
  const yesProb = view ? Math.round(view.yesBps / 100) : backendProb;
  const noProb = 100 - yesProb;
  const chainStatus = view?.market.status;
  // Use a timer-backed timestamp so freshness changes are reflected without impure render reads.
  const secondsToClose = ledger.now !== null && view ? Number(view.market.close_time - BigInt(Math.floor(ledger.now))) : null;
  const safeToTrade = secondsToClose !== null && secondsToClose > SAFETY_MARGIN_S + MIN_TX_TIMEOUT_S;
  const countdown = secondsToClose !== null && secondsToClose >= 0 && secondsToClose < 3600 ? `Closes in ${Math.floor(secondsToClose / 60)}m ${secondsToClose % 60}s` : null;
  const isOpen = chainStatus?.tag === "Open" && Number(view?.market.close_time ?? 0) * 1000 > chain.dataUpdatedAt;
  const isFresh = (updatedAt: number, maxAge: number) =>
    now !== null && now >= updatedAt && now - updatedAt <= maxAge;
  const tradePreflight = preflightBuy(
    {
      config:
        config.data && isFresh(config.dataUpdatedAt, 60_000)
          ? { paused: config.data.paused }
          : undefined,
      market: view?.market,
      marketIsStale: Boolean(view && now !== null && !isFresh(chain.dataUpdatedAt, 15_000)),
      ledgerNow:
        ledgerNow.data !== undefined && isFresh(ledgerNow.dataUpdatedAt, 5_000)
          ? ledgerNow.data
          : undefined,
      position: position.data && isFresh(position.dataUpdatedAt, 15_000) ? position.data : undefined,
      positionIsStale: Boolean(position.data && now !== null && !isFresh(position.dataUpdatedAt, 15_000)),
      usdcBalance:
        balance.data !== undefined && isFresh(balance.dataUpdatedAt, 15_000)
          ? balance.data
          : undefined,
    },
    side,
    spendRaw ?? 0n,
  );
  const buyPreflightFailure = tradePreflight.ok === false ? tradePreflight.failures[0] : null;

  const isLoading = backendById.isLoading || (backendByChainId.isLoading && !marketId) || (chain.isLoading && !market);
  const notFound = !market && !view;

  const handleBuy = async () => {
    if (!isConnected) {
      void openModal();
      return;
    }
    if (!onChainMarketId) return;
    if (trustlineMissing) {
      setBuyStatus("Enable your USDC trustline below, then click Buy again.");
      return;
    }
    if (trustlineUnauthorized) {
      setBuyStatus("The issuer hasn't authorized your USDC trustline.");
      return;
    }
    if (isWrongNetwork) {
      setBuyStatus("Switch your wallet to Stellar Testnet to place this trade.");
      return;
    }
    if (!amountRaw || amountRaw <= 0n) {
      setBuyStatus(buyMode === "usdc" ? "Enter an amount like 10 or 2.5." : "Enter a share amount greater than zero.");
      return;
    }
    if (ledger.now === null) {
      setBuyStatus("Checking market time…");
      return;
    }
    if (!safeToTrade) {
      setBuyStatus("This market closes too soon to safely place a trade.");
      return;
    }
    setBuyStatus(null);
    try {
      const result = await buy.mutateAsync({
        marketId: onChainMarketId,
        outcome: side,
        collateralIn: spendRaw ?? 0n,
        review,
        slippageBps: SLIPPAGE_BPS,
        prepared: prepareBuy.data,
      });
      setBuyStatus(
        `Bought ${formatUsdc(result.sharesOut, { maxDecimals: 2 })} ${side.toUpperCase()} shares.` +
          (result.txHash ? ` View: ${explorerTx(result.txHash)}` : ""),
      );
    } catch (err) {
      setBuyStatus(err instanceof Error ? err.message : "The trade didn't go through.");
    }
  };

  const handleEnableUsdc = async () => {
    setBuyStatus("Checking XLM reserve, then opening your wallet…");
    try {
      await enableUsdc.mutateAsync();
      setBuyStatus("USDC is enabled. Review your amount and click Buy to submit the trade.");
    } catch (err) {
      setBuyStatus(err instanceof Error ? err.message : "Couldn't enable USDC.");
    }
  };

  if (isLoading) {
    return (
      <main className="relative min-h-[calc(100vh-64px)] overflow-hidden bg-surface flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="relative min-h-[calc(100vh-64px)] overflow-hidden bg-surface flex flex-col items-center justify-center p-6 text-center">
        <span className="material-symbols-outlined text-error text-6xl mb-4">error</span>
        <h2 className="text-headline-md mb-2">Market Not Found</h2>
        <p className="text-on-surface-variant mb-6">The market you are looking for does not exist or could not be loaded.</p>
        <Link href="/markets" className="bg-primary text-white px-6 py-2 rounded-lg font-label-caps">
          BACK TO MARKETS
        </Link>
      </main>
    );
  }

  const title = market?.question ?? `Market #${onChainMarketId} · ${view?.market.meta_uri ?? ""}`;
  const statusLabel = chainStatus
    ? chainStatus.tag === "Resolved" ? `RESOLVED ${chainStatus.values[0].tag.toUpperCase()}` : chainStatus.tag === "Void" ? "VOID" : isOpen ? "OPEN" : "CLOSED"
    : market?.status ?? "";
  const categoryLabel = market?.category ?? view?.market.category.tag ?? "";
  const liquidityText = view
    ? `$${formatUsdc(view.market.sets_minted, { maxDecimals: 2, grouping: true })}`
    : market ? `$${market.totalLiquidity.toLocaleString()}` : "—";
  const latestTrace = market?.reasoningTraces?.[0];

  return (
    <main className="relative min-h-[calc(100vh-64px)] overflow-hidden bg-surface">
      {/* Background decoration for terminal feel */}
      <div className="fixed bottom-4 left-4 font-data-mono text-[10px] text-outline opacity-50 z-0 pointer-events-none">
        STELLAR TESTNET :: MARKET {onChainMarketId !== null ? `#${onChainMarketId}` : "NOT ON-CHAIN"}
      </div>

      {/* Main Content Background (Simulated/Blurred) */}
      <div className={`max-w-container-max-width mx-auto p-gutter grid grid-cols-1 md:grid-cols-3 gap-6 transition-all duration-700 ${showModal ? "opacity-40 select-none pointer-events-none blur-sm" : "opacity-100"}`}>
        <div className="md:col-span-2 space-y-6">
          <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded-xl">
            <div className="h-4 w-24 bg-surface-container rounded mb-4"></div>
            <div className="h-8 w-full bg-surface-container rounded mb-6"></div>
            <div className="h-64 w-full bg-surface-container rounded"></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="h-32 bg-surface-container-lowest border border-outline-variant rounded-xl"></div>
            <div className="h-32 bg-surface-container-lowest border border-outline-variant rounded-xl"></div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded-xl h-[500px]"></div>
        </div>
      </div>

      {/* Market Details Quick View Modal Overlay */}
      <AnimatePresence>
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-on-background/20 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white w-full max-w-[560px] rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] border border-outline-variant overflow-hidden flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant bg-surface-bright">
                <div className="flex items-center gap-2">
                  <span className={`${isOpen ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-highest text-on-surface-variant'} font-label-caps text-[10px] px-2 py-0.5 rounded-full font-bold`}>
                    {statusLabel}
                    {chainStatus && <SourceTag source="chain" />}
                  </span>
                  {countdown && <span className="text-[10px] font-data-mono text-on-surface-variant">{countdown}</span>}
                  <span className="font-label-caps text-label-caps text-outline uppercase font-bold tracking-wider">{categoryLabel}</span>
                </div>
                <Link 
                  href="/markets"
                  aria-label="Close"
                  className="text-outline hover:text-on-surface transition-colors p-1"
                >
                  <span className="material-symbols-outlined">close</span>
                </Link>
              </div>

              {/* Content Area */}
              <div className="p-6 space-y-6">
                {/* Market Question */}
                <div>
                  <h2 className="font-headline-sm text-headline-sm text-on-surface leading-tight">
                    {title}
                  </h2>
                </div>

                {/* 24h Performance & Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-center">
                  <div className="space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-display-lg text-display-lg text-on-surface text-4xl">{yesProb}%</span>
                      <SourceTag source={fromChain ? "chain" : "backend"} />
                    </div>
                    <p className="font-label-caps text-label-caps text-outline uppercase font-bold tracking-wider">YES price</p>
                  </div>
                  {/* Sparkline Simulation */}
                  <div className="h-16 relative w-full" aria-hidden="true" title="Illustration; price history isn't indexed yet">
                    <svg className="w-full h-full text-secondary stroke-2 fill-none" viewBox="0 0 100 30" preserveAspectRatio="none">
                      <path 
                        d={sparklinePath} 
                        stroke="currentColor" 
                        strokeLinecap="round" 
                        strokeLinejoin="round" 
                        strokeWidth="2"
                      />
                      <defs>
                        <linearGradient id="sparkline-gradient" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="currentColor" stopOpacity="0.1" />
                          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path 
                        d={`${sparklinePath} L100 30 L0 30 Z`} 
                        fill="url(#sparkline-gradient)" 
                        stroke="none"
                      />
                    </svg>
                  </div>
                </div>

                {/* Trading Module */}
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" aria-pressed={side === 'Yes'} onClick={() => setSide('Yes')} className={`group relative bg-surface-container-lowest border ${side === 'Yes' ? 'border-secondary border-2' : 'border-secondary/30'} hover:border-secondary hover:bg-secondary-container/10 p-4 rounded-lg transition-all duration-200`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-label-caps text-label-caps text-secondary font-bold">YES</span>
                      <span className="font-data-mono text-data-mono text-on-surface">${(yesProb/100).toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-surface-container h-1 rounded-full overflow-hidden">
                      <div className="bg-secondary h-full transition-all duration-500" style={{ width: `${yesProb}%` }}></div>
                    </div>
                  </button>
                  <button type="button" aria-pressed={side === 'No'} onClick={() => setSide('No')} className={`group relative bg-surface-container-lowest border ${side === 'No' ? 'border-tertiary border-2' : 'border-tertiary/30'} hover:border-tertiary hover:bg-tertiary-container/10 p-4 rounded-lg transition-all duration-200`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-label-caps text-label-caps text-tertiary font-bold">NO</span>
                      <span className="font-data-mono text-data-mono text-on-surface">${(noProb/100).toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-surface-container h-1 rounded-full overflow-hidden">
                      <div className="bg-tertiary h-full transition-all duration-500" style={{ width: `${noProb}%` }}></div>
                    </div>
                  </button>
                </div>

                {/* Buy */}
                {onChainMarketId !== null && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="inline-flex rounded border border-outline-variant p-0.5" aria-label="Buy amount unit">
                        <button type="button" aria-pressed={buyMode === "usdc"} onClick={() => setBuyMode("usdc")} className={`px-2 py-1 text-[10px] rounded ${buyMode === "usdc" ? "bg-primary text-primary-foreground" : "text-on-surface-variant"}`}>USDC</button>
                        <button type="button" aria-pressed={buyMode === "shares"} onClick={() => setBuyMode("shares")} className={`px-2 py-1 text-[10px] rounded ${buyMode === "shares" ? "bg-primary text-primary-foreground" : "text-on-surface-variant"}`}>Shares</button>
                      </div>
                      <label htmlFor="buy-amount" className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] shrink-0">
                        Amount ({buyMode === "usdc" ? "USDC" : `${side.toUpperCase()} shares`})
                      </label>
                      <input
                        id="buy-amount"
                        inputMode="decimal"
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        className="flex-1 bg-surface border border-outline-variant rounded p-2 font-data-mono text-sm outline-none focus:ring-2 focus:ring-primary"
                      />
                      <button
                        type="button"
                        onClick={handleBuy}
                        disabled={
                          buy.isPending ||
                          (isConnected && !isOpen) ||
                          (isConnected && isUnfunded) ||
                          (isConnected && isInsufficientXlm)
                        }
                        className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-label-caps text-label-caps font-bold disabled:opacity-50"
                      >
                        {!isConnected
                          ? "Connect"
                          : buy.isPending
                          ? (buy.phase.name === "awaiting-signature" ? "Signing…" : "Buying…")
                          : isUnfunded
                          ? "Fund Account"
                          : isInsufficientXlm
                          ? "Insufficient XLM"
                          : `Buy ${side.toUpperCase()}`}
                      </button>
                    </div>
                    <div className="flex justify-between text-[11px] font-data-mono text-on-surface-variant">
                      <span>
                        {amountRaw === null
                          ? buyMode === "usdc" ? "Enter an amount like 10 or 2.5" : "Enter a share amount"
                          : buyMode === "shares" && exactQuote.data
                            ? `Costs ≈ ${formatUsdc(exactQuote.data.collateralIn, { maxDecimals: 2 })} USDC (fee ${formatUsdc(exactQuote.data.fee, { maxDecimals: 2 })}), at most ${formatUsdc(maxIn(exactQuote.data.collateralIn, SLIPPAGE_BPS), { maxDecimals: 2 })} with 1% slippage`
                            : buyMode === "shares" && exactQuote.error
                              ? exactQuote.error.message
                              : buyMode === "shares" && exactQuote.isFetching
                                ? "Quoting exact share amount…"
                                : quote.data !== undefined
                            ? `≈ ${formatUsdc(quote.data, { maxDecimals: 2 })} shares, at least ${formatUsdc(minOut(quote.data, SLIPPAGE_BPS), { maxDecimals: 2 })} (1% slippage)`
                            : quote.error ? quote.error.message : quote.isFetching ? "Quoting…" : ""}
                      </span>
                      {balance.data !== undefined && <span>Balance {formatUsdc(balance.data, { maxDecimals: 2, grouping: true })}<PendingValue state={balanceState.data} /></span>}
                    </div>

                    {/* Network fee & reserve row */}
                    {isConnected && (
                      <div
                        className="flex justify-between items-center text-[11px] font-data-mono text-on-surface-variant"
                        title={fees ? `Inclusion: ${formatXlm(fees.inclusionFee)} XLM · Resource: ${formatXlm(fees.resourceFee)} XLM (assumes the network base reserve of 0.5 XLM)` : "assumes the network base reserve of 0.5 XLM"}
                      >
                        <span>
                          Network fee {fees ? `≈ ${formatXlm(fees.totalFee)} XLM` : prepareBuy.isLoading ? "≈ calculating…" : "—"} ·{" "}
                          {reserve.isLoading
                            ? "checking XLM…"
                            : reserve.isError
                            ? "couldn't check XLM balance"
                            : reserve.data && !reserve.data.funded
                            ? "unfunded"
                            : reserve.data
                            ? `spendable ${formatXlm(reserve.data.spendable, { maxDecimals: 1 })} XLM`
                            : "spendable —"}
                        </span>
                        {fees && (
                          <span className="text-[10px] text-outline">
                            (inclusion {formatXlm(fees.inclusionFee)} + resource {formatXlm(fees.resourceFee)})
                          </span>
                        )}
                      </div>
                    )}

                    {/* Blocking warnings */}
                    {isConnected && isUnfunded && (
                      <p className="text-xs text-error font-medium" role="alert">
                        Fund this account with XLM first.
                      </p>
                    )}
                    {isConnected && isInsufficientXlm && xlmDeficit !== null && (
                      <p className="text-xs text-error font-medium" role="alert">
                        You need about {formatXlm(xlmDeficit)} more XLM to pay the network fee.
                      </p>
                    )}

                    {!isOpen && view && (
                      <p className="text-[11px] text-on-surface-variant">This market is closed to trading.</p>
                    )}
                    {ledger.now === null && <p className="text-[11px] text-on-surface-variant">Checking market time…</p>}
                    {isOpen && !safeToTrade && <p className="text-[11px] text-on-surface-variant">Trading is disabled this close to the market deadline.</p>}
                    {trustlineMissing && !isWrongNetwork && (
                      <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3 space-y-2">
                        <p className="text-xs text-on-surface-variant">
                          Enable USDC once to buy on Stellar. This creates a trustline and locks one base reserve (typically 0.5 XLM); it does not submit your trade.
                        </p>
                        <button type="button" onClick={handleEnableUsdc} disabled={enableUsdc.isPending} className="bg-primary text-primary-foreground px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50">
                          {enableUsdc.isPending ? "Enabling…" : "Enable USDC"}
                        </button>
                      </div>
                    )}
                    {trustlineUnauthorized && <p className="text-[11px] text-error">The issuer hasn&apos;t authorized your USDC trustline.</p>}
                    {position.data && (position.data.yes > 0n || position.data.no > 0n || positionState.data?.provisional || positionState.data?.awaitingRpc) && (
                      <p className="text-[11px] font-data-mono text-on-surface">
                        Your position: {formatUsdc(position.data.yes, { maxDecimals: 2 })} YES · {formatUsdc(position.data.no, { maxDecimals: 2 })} NO
                        <PendingValue state={positionState.data} fallback={<SourceTag source="chain" />} />
                      </p>
                    )}

                    {/* Observable tx lifecycle phase */}
                    {buy.isPending && (
                      <div className="text-xs text-on-surface-variant flex items-center gap-1.5" role="status">
                        <span>{renderTxPhase(buy.phase) ?? "Processing transaction…"}</span>
                        {"hash" in buy.phase && buy.phase.hash && (
                          <a
                            href={explorerTx(buy.phase.hash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline font-data-mono"
                          >
                            View: {buy.phase.hash.slice(0, 8)}…
                          </a>
                        )}
                      </div>
                    )}

                    {/* Status message */}
                    {!buy.isPending && buyStatus && (
                      <p className="text-xs text-on-surface-variant break-all" role="status">{buyStatus}</p>
                    )}
                  </div>
                )}

                {onChainMarketId !== null && <TradeTape onChainMarketId={onChainMarketId} limit={20} compact />}

                {/* AI Reasoning Snippet */}
                <div className="bg-[#f0f9fa] border border-primary-container/20 p-4 rounded-lg space-y-2 relative overflow-hidden">
                  <div className="flex items-center gap-2 text-primary z-10 relative">
                    <span className="material-symbols-outlined text-[18px]">psychology</span>
                    <span className="font-label-caps text-label-caps uppercase font-bold tracking-wider">Oracle AI Insights</span>
                  </div>
                  <p className="font-body-md text-body-md text-on-surface-variant italic z-10 relative leading-relaxed">
                    {latestTrace
                      ? `The agent estimates a ${Math.round(latestTrace.probabilityEstimate * 100)}% probability. Edge: ${Math.round(latestTrace.edge * 100)}%.`
                      : "No reasoning trace has been published for this market yet."
                    }
                  </p>
                  <div className="absolute right-0 bottom-0 opacity-5 translate-x-4 translate-y-4">
                    <span className="material-symbols-outlined text-6xl">neurology</span>
                  </div>
                </div>
              </div>

              {/* Footer Action */}
              <div className="px-6 py-4 bg-surface-container-low border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex flex-col items-center sm:items-start">
                  <span className="font-data-mono text-data-mono text-on-surface font-bold">{liquidityText}<SourceTag source={fromChain ? "chain" : "backend"} /></span>
                  <span className="text-[10px] text-outline font-label-caps uppercase font-bold tracking-wider">Collateral locked</span>
                </div>
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  {market && (
                    <Link href={`/markets/terminal?marketId=${market.id}`} className="flex-1 sm:flex-none font-label-caps text-label-caps text-primary hover:underline px-4 transition-all font-bold text-center">View Full Terminal</Link>
                  )}
                  {market && latestTrace && (
                    <Link href={`/copy-trade?marketId=${market.id}&traceId=${latestTrace.id}`} className="flex-1 sm:flex-none bg-primary text-primary-foreground px-6 py-2.5 rounded-lg font-label-caps text-label-caps hover:bg-primary-container active:scale-95 transition-all shadow-sm font-bold uppercase text-center">Copy Agent</Link>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
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
