"use client";

import { TxReview, TxReviewPreferenceControl, shouldSkipTxReview } from "@/components/tx-review";
import type { ReviewModel } from "@/lib/stellar/tx-decode";
import { useSubmitQueueState } from "@/lib/stellar/submit-queue";


import React, { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useWallet } from "@/lib/contexts/WalletContext";
import { getTrace, ReasoningTrace } from "@/lib/api/traces";
import { confirmCopyTrade, initiateCopyTrade } from "@/lib/api/trade";
import { ApiError } from "@/lib/api/client";
import { useMarket } from "@/lib/hooks/useMarkets";
import { useBuy, useQuoteBuy, useUsdcBalance, useAccountReserve, usePrepareBuy, useOnChainMarket, fetchOnChainMarket, useUsdcTrustline, useEnableUsdc, useUsdcBalanceState, type PreparedWriteReview } from "@/lib/hooks/useStellar";
import { explorerTx } from "@/lib/stellar/config";
import { formatUsdc, formatXlm, minOut, shareOf } from "@/lib/stellar/units";
import { TxPhase } from "@/lib/stellar/tx-lifecycle";

/** Wait this long after the slider stops before asking for a new quote. */
import { getLedgerNow, useLedgerNow } from "@/lib/stellar/ledger-clock";
import { MIN_TX_TIMEOUT_S, SAFETY_MARGIN_S } from "@/lib/stellar/deadline";
import { PendingValue } from "@/components/pending-value";
const QUOTE_DEBOUNCE_MS = 400;

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

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function CopyTradeContent() {
  const { address, isConnected, isWrongNetwork, openModal, ensureSession } = useWallet();
  const searchParams = useSearchParams();
  const router = useRouter();

  const traceId = searchParams.get("traceId");
  const marketIdParam = searchParams.get("marketId");

  const [trace, setTrace] = useState<ReasoningTrace | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const { data: market } = useMarket(marketIdParam ?? trace?.marketId ?? undefined);
  const onChainMarketId = market?.onChainMarketId ?? null;
  const onChainMarket = useOnChainMarket(onChainMarketId);

  const balance = useUsdcBalance(address);
  const balanceState = useUsdcBalanceState(address);
  const ledger = useLedgerNow();
  const trustline = useUsdcTrustline(address);
  const enableUsdc = useEnableUsdc();
  const trustlineMissing = trustline.data?.kind === "missing";
  const trustlineReady = trustline.data?.kind === "native" || (trustline.data?.kind === "present" && trustline.data.authorized);
  const marketCanTrade = onChainMarket.data?.market.status.tag === "Open" && ledger.now !== null && Number(onChainMarket.data.market.close_time) - ledger.now > SAFETY_MARGIN_S + MIN_TX_TIMEOUT_S;
  const reserve = useAccountReserve(address);
  const buy = useBuy();
  const submitQueue = useSubmitQueueState(address);

  // Allocation as a share of the wallet's USDC balance, in basis points.
  const [allocationBps, setAllocationBps] = useState(1250);
  const [slippage, setSlippage] = useState(1.0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const reviewPreparedBuy = useCallback<PreparedWriteReview>(async (_prepared, model, changedFrom, forceReview = false) => {
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

  useEffect(() => {
    if (!traceId) return;
    getTrace(traceId)
      .then(setTrace)
      .catch(() => setTraceError("We couldn't load this reasoning trace."));
  }, [traceId]);

  // Side comes from the trace's edge. No trace or zero edge means no trade.
  const side: "Yes" | "No" | null = trace && trace.edge !== 0 ? (trace.edge > 0 ? "Yes" : "No") : null;
  const buyLabel = side && onChainMarketId ? `Buy ${side} on #${onChainMarketId}` : "";
  const waitingForBuy =
    submitQueue.waiting.some((job) => job.label === buyLabel) ||
    (submitQueue.lockWaiting && submitQueue.running?.label === buyLabel);
  const allocation = allocationBps / 100;
  const amountRaw = balance.data !== undefined ? shareOf(balance.data, allocationBps) : null;
  const slippageBps = Math.round(slippage * 100);

  const debouncedAmount = useDebounced(amountRaw, QUOTE_DEBOUNCE_MS);
  const quote = useQuoteBuy(onChainMarketId, side ?? "Yes", side ? debouncedAmount : null);
  const minShares = quote.data !== undefined ? minOut(quote.data, slippageBps) : null;
  const prepareBuy = usePrepareBuy({
    marketId: onChainMarketId,
    outcome: side ?? "Yes",
    collateralIn: side ? debouncedAmount : null,
    slippageBps,
    holder: address,
  });

  const fees = prepareBuy.data?.fees;
  const isUnfunded = Boolean(reserve.data && !reserve.data.funded);
  const isInsufficientXlm = Boolean(
    reserve.data?.funded &&
    fees &&
    reserve.data.spendable < fees.totalFee
  );
  const xlmDeficit = (reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable)
    ? fees.totalFee - reserve.data.spendable
    : null;

  const handleSliderInteraction = (clientX: number) => {
    if (!sliderRef.current) return;
    const rect = sliderRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setAllocationBps(Math.round(percentage * 100));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    handleSliderInteraction(e.clientX);
    const onMouseMove = (moveEvent: MouseEvent) => handleSliderInteraction(moveEvent.clientX);
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    handleSliderInteraction(e.touches[0].clientX);
  };

  const onSliderKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1000 : 100;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") setAllocationBps((v) => Math.min(10_000, v + step));
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") setAllocationBps((v) => Math.max(0, v - step));
  };

  const handleConfirm = async () => {
    if (!isConnected || !address) {
      setStatusMessage("Connect your wallet to confirm the copy trade.");
      void openModal();
      return;
    }
    if (isWrongNetwork) {
      setStatusMessage("Switch your wallet to Stellar Testnet to place this trade.");
      return;
    }
    if (!trace || !side) {
      setStatusMessage(
        !trace
          ? "There's no reasoning trace to copy, so there's no side to take."
          : "This trace shows no edge, so there's no trade to copy.",
      );
      return;
    }
    if (!onChainMarketId || !market) {
      setStatusMessage("This market isn't on-chain yet, so it can't be traded.");
      return;
    }
    if (!onChainMarket.data) {
      setStatusMessage("Checking the on-chain market and ledger time…");
      return;
    }
    if (!marketCanTrade) {
      setStatusMessage("This market is closed or too close to its deadline to safely place a trade.");
      return;
    }
    if (!trustlineReady) {
      setStatusMessage(
        trustlineMissing
          ? "Enable your USDC trustline before copying this trade."
          : trustline.data?.kind === "present"
            ? "The issuer hasn't authorized your USDC trustline."
            : "Checking your USDC trustline…",
      );
      return;
    }
    if (!amountRaw || amountRaw <= 0n) {
      setStatusMessage("Choose an allocation greater than zero. You may need USDC in your wallet first.");
      return;
    }

    setIsSubmitting(true);
    try {
      setStatusMessage("Signing in to OracleDesk…");
      if (!(await ensureSession())) {
        setStatusMessage("You need to sign in with your wallet to copy trades.");
        return;
      }

      const freshMarket = await fetchOnChainMarket(onChainMarketId);
      const freshLedgerNow = getLedgerNow();
      if (
        freshLedgerNow === null ||
        freshMarket.market.status.tag !== "Open" ||
        BigInt(Math.floor(freshLedgerNow)) + BigInt(SAFETY_MARGIN_S + MIN_TX_TIMEOUT_S) >= freshMarket.market.close_time
      ) {
        setStatusMessage("This market is closed or too close to its deadline to safely place a trade.");
        return;
      }

      setStatusMessage("Recording your copy trade…");
      const { copyTradeId } = await initiateCopyTrade({
        traceId: trace.id,
        marketId: market.id,
        amountRaw: amountRaw.toString(),
      });

      setStatusMessage(null);
      const result = await buy.mutateAsync({
        marketId: onChainMarketId,
        outcome: side,
        collateralIn: amountRaw,
        slippageBps,
        prepared: prepareBuy.data,
        review: reviewPreparedBuy,
      });

      if (result.txHash) await confirmCopyTrade(copyTradeId, result.txHash).catch(() => undefined);
      setStatusMessage(
        `Done. You received ${formatUsdc(result.sharesOut, { maxDecimals: 2 })} ${side.toUpperCase()} shares.` +
          (result.txHash ? ` Transaction ${result.txHash.slice(0, 10)}…` : ""),
      );
      if (result.txHash) window.open(explorerTx(result.txHash), "_blank", "noopener,noreferrer");
    } catch (error) {
      if (error instanceof ApiError && error.code === "TRACE_LOCKED") {
        setStatusMessage("Unlock this trace before copying it.");
      } else {
        setStatusMessage(error instanceof Error ? error.message : "The trade didn't go through. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnableUsdc = async () => {
    setStatusMessage("Checking XLM reserve, then opening your wallet…");
    try {
      await enableUsdc.mutateAsync();
      setStatusMessage("USDC is enabled. Click Confirm Copy Trade when you're ready.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Couldn't enable USDC.");
    }
  };

  return (
    <div className="bg-background text-on-surface min-h-screen flex flex-col">
      <style jsx global>{`
        .ai-shimmer {
          background: linear-gradient(
            90deg,
            rgba(145, 215, 238, 0.1) 0%,
            rgba(145, 215, 238, 0.2) 50%,
            rgba(145, 215, 238, 0.1) 100%
          );
          background-size: 200% 100%;
          animation: shimmer 3s infinite linear;
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <main className="flex-grow flex items-center justify-center p-4 sm:p-margin relative">
        <div className="fixed inset-0 bg-on-background/10 backdrop-blur-sm z-[55]"></div>

        <div className="relative bg-surface border border-outline-variant w-full max-w-[640px] shadow-xl rounded-xl overflow-hidden z-[60] animate-in fade-in zoom-in duration-300">
          <div className="px-6 py-4 border-b border-outline-variant flex justify-between items-center bg-white">
            <div>
              <h2 className="font-headline-md text-headline-md text-on-surface">Confirm Copy Trade</h2>
              <p className="font-body-md text-body-md text-on-surface-variant text-sm">Copy the agent&apos;s side on this market</p>
            </div>
            <button 
              className="material-symbols-outlined p-2 hover:bg-surface-container rounded-full transition-colors" 
              type="button"
              aria-label="Close"
              onClick={() => router.back()}
            >
              close
            </button>
          </div>

          <div className="bg-[#f0f9fa] border-b border-outline-variant p-6 relative overflow-hidden ai-shimmer text-xs sm:text-sm">
            <div className="flex items-start gap-4">
              <div className="bg-primary-container p-2 rounded-lg flex-shrink-0">
                <span className="material-symbols-outlined text-on-primary-container" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
              </div>
              <div>
                <span className="font-label-caps text-label-caps text-primary-container mb-1 block">
                  ORACLE INSIGHTS{trace ? ` • ${Math.round(trace.probabilityEstimate * 100)}% ESTIMATE` : ""}
                </span>
                <p className="font-body-md text-body-md text-on-primary-fixed-variant leading-relaxed">
                  {trace?.market?.question ? (
                    <>Agent analysis for <span className="font-bold">{trace.market.question}</span>.</>
                  ) : traceError ? (
                    <>{traceError}</>
                  ) : traceId ? (
                    <>Loading the reasoning trace…</>
                  ) : (
                    <>Open this page from a reasoning trace to copy its trade.</>
                  )}
                </p>
              </div>
            </div>
          </div>

          <div className="p-6 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 border border-outline-variant rounded-lg bg-white">
                <span className="font-label-caps text-label-caps text-on-surface-variant block mb-2 uppercase text-[10px]">Proposed Side</span>
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-full ${side === 'No' ? 'bg-tertiary' : side === 'Yes' ? 'bg-secondary' : 'bg-outline-variant'}`}></span>
                  <span className={`font-headline-sm text-headline-sm text-base sm:text-lg ${side === 'No' ? 'text-tertiary' : side === 'Yes' ? 'text-secondary' : 'text-on-surface-variant'}`}>
                    {side === 'No' ? 'NO / SHORT' : side === 'Yes' ? 'YES / LONG' : 'No trade'}
                  </span>
                </div>
              </div>
              <div className="p-4 border border-outline-variant rounded-lg bg-white">
                <span className="font-label-caps text-label-caps text-on-surface-variant block mb-2 uppercase text-[10px]">Probability</span>
                <div className="flex items-center gap-2">
                  <span className="font-headline-sm text-headline-sm text-on-surface text-base sm:text-lg">
                    {trace ? `${(trace.probabilityEstimate * 100).toFixed(1)}%` : "—"}
                  </span>
                  {trace && (
                    <span className="text-[10px] text-secondary font-bold px-1 bg-secondary-container rounded">
                      {`${trace.edge > 0 ? "+" : ""}${(trace.edge * 100).toFixed(1)}% Δ`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-end flex-wrap gap-2">
                <label className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px]">Share of your USDC balance (%)</label>
                <span className="font-data-mono text-data-mono text-primary font-bold text-xs sm:text-sm">
                  {allocation.toFixed(2)}% ({amountRaw !== null ? `${formatUsdc(amountRaw, { maxDecimals: 2, minDecimals: 2, grouping: true })} USDC` : isConnected ? "loading balance…" : "connect a wallet"})<PendingValue state={balanceState.data} />
                </span>
              </div>
              <div
                ref={sliderRef}
                className="relative h-2 bg-surface-container rounded-full cursor-pointer touch-none focus:outline-none focus:ring-2 focus:ring-primary"
                role="slider"
                tabIndex={0}
                aria-label="Share of your USDC balance"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Number(allocation.toFixed(2))}
                onKeyDown={onSliderKey}
                onMouseDown={onMouseDown}
                onTouchStart={(e) => handleSliderInteraction(e.touches[0].clientX)}
                onTouchMove={onTouchMove}
              >
                <div className="absolute inset-y-0 left-0 bg-primary-container rounded-full" style={{ width: `${allocation}%` }}></div>
                <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary border-2 border-white rounded-full shadow-md" style={{ left: `calc(${allocation}% - 8px)` }}></div>
              </div>
              <div className="flex justify-between text-[10px] font-medium text-on-surface-variant px-1">
                <span>0%</span>
                <span>25%</span>
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
              </div>
            </div>

            <div className="p-4 bg-surface-container-low rounded-lg space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-outline text-sm">settings</span>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px]">Slippage Tolerance</span>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  {[0.5, 1.0, 3.0].map((val) => (
                    <button
                      key={val}
                      onClick={() => setSlippage(val)}
                      className={`flex-1 sm:flex-none px-3 py-1 text-[11px] font-bold border rounded transition-all ${
                        slippage === val
                          ? "border-primary border-2 bg-white text-primary"
                          : "border-outline-variant bg-white hover:border-primary text-on-surface-variant"
                      }`}
                    >
                      {val}%
                    </button>
                  ))}
                </div>
              </div>
              <div className="pt-4 border-t border-outline-variant flex justify-between items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-outline text-sm">query_stats</span>
                  <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px]">Expected shares</span>
                </div>
                <div className="text-right font-data-mono text-xs">
                  {quote.data !== undefined && minShares !== null ? (
                    <>
                      <span className="text-on-surface font-bold">{formatUsdc(quote.data, { maxDecimals: 2 })}</span>
                      <span className="block text-[10px] text-on-surface-variant">
                        at least {formatUsdc(minShares, { maxDecimals: 2 })} after slippage
                        {fees && (
                          <span
                            className="block text-[10px] text-on-surface-variant mt-1"
                            title={`Inclusion: ${formatXlm(fees.inclusionFee)} XLM · Resource: ${formatXlm(fees.resourceFee)} XLM (assumes the network base reserve of 0.5 XLM)`}
                          >
                            Network fee ≈ {formatXlm(fees.totalFee)} XLM ·{" "}
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
                        )}
                      </span>
                    </>
                  ) : quote.isFetching ? (
                    <span className="text-on-surface-variant">Quoting…</span>
                  ) : quote.error ? (
                    <span className="text-error">{quote.error.message}</span>
                  ) : (
                    <span className="text-on-surface-variant">—</span>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              {/* Blocking warnings */}
              {isConnected && isUnfunded && (
                <div className="rounded-2xl border border-error/20 bg-error-container/10 p-3 text-xs text-error font-medium" role="alert">
                  Fund this account with XLM first.
                </div>
              )}
              {isConnected && isInsufficientXlm && xlmDeficit !== null && (
                <div className="rounded-2xl border border-error/20 bg-error-container/10 p-3 text-xs text-error font-medium" role="alert">
                  You need about {formatXlm(xlmDeficit)} more XLM to pay the network fee.
                </div>
              )}

              {/* Tx phase tracking */}
              {buy.isPending && (
                <div className="rounded-2xl border border-outline-variant bg-surface p-4 text-sm text-on-surface-variant flex items-center justify-between" role="status">
                  <span>{renderTxPhase(buy.phase) ?? statusMessage ?? "Processing copy trade…"}</span>
                  {"hash" in buy.phase && buy.phase.hash && (
                    <a
                      href={explorerTx(buy.phase.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-data-mono text-xs"
                    >
                      View: {buy.phase.hash.slice(0, 8)}…
                    </a>
                  )}
                </div>
              )}

              {/* Status message when not pending */}
              {!buy.isPending && statusMessage && (
                <div className="rounded-2xl border border-outline-variant bg-surface p-4 text-sm text-on-surface-variant">
                  {waitingForBuy ? "Waiting for your previous transaction to finish…" : statusMessage}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  className="flex-1 border border-outline text-on-surface py-4 rounded-lg font-headline-sm text-headline-sm hover:bg-surface-variant transition-all"
                  onClick={() => router.back()}
                  type="button"
                >
                  Go Back
                </button>
                <button
                  className="flex-[2] bg-[#005f73] text-primary-foreground py-4 rounded-lg font-headline-sm text-headline-sm shadow-lg shadow-primary-container/20 hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleConfirm}
                  type="button"
                  disabled={
                    isSubmitting ||
                    buy.isPending ||
                    !side ||
                    (isConnected && isUnfunded) ||
                    (isConnected && isInsufficientXlm)
                  }
                >
                  <span className="material-symbols-outlined text-xl">bolt</span>
                  {isSubmitting || buy.isPending
                    ? (buy.phase.name === "awaiting-signature" ? "Signing…" : "Submitting…")
                    : isUnfunded
                    ? "Fund Account"
                    : isInsufficientXlm
                    ? "Insufficient XLM"
                    : "Confirm Copy Trade"}
                </button>
              </div>
              <p className="text-center font-body-md text-body-md text-on-surface-variant text-xs">
                Your wallet signs a buy on the OracleDesk market contract on Stellar Testnet. The trade fails instead of filling below the slippage limit.
              </p>
              <div className="text-center">
                <TxReviewPreferenceControl />
              </div>
            </div>
          </div>
        </div>
      </main>
      {reviewModel && (
        <TxReview
          model={reviewModel.model}
          changedFrom={reviewModel.changedFrom}
          onConfirm={() => closeReview(true)}
          onCancel={() => closeReview(false)}
        />
      )}
    </div>
  );
}

export default function CopyTradePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading Copy Trade...</div>}>
      <CopyTradeContent />
    </Suspense>
  );
}
