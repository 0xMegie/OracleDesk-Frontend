"use client";

import { TxReview, TxReviewPreferenceControl, shouldSkipTxReview } from "@/components/tx-review";
import type { ReviewModel } from "@/lib/stellar/tx-decode";
import { useSubmitQueueState } from "@/lib/stellar/submit-queue";


import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { useWallet } from "@/lib/contexts/WalletContext";
import { useUsdcTransfer, useAccountReserve, usePrepareUsdcTransfer } from "@/lib/hooks/useStellar";
import { useUnlockTrace } from "@/lib/hooks/useTraces";
import { PAYMENTS_RECIPIENT, explorerTx } from "@/lib/stellar/config";
import { formatUsdc, formatXlm, parseUsdc } from "@/lib/stellar/units";
import { TxPhase } from "@/lib/stellar/tx-lifecycle";

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

/**
 * Price of the backend's daily pass (its DAILY_PASS_PRICE_RAW). The backend
 * verifies the transfer on-chain and rejects anything below its own price,
 * so this must not be lower than the backend's value.
 */
const DAILY_PASS_PRICE_RAW = parseUsdc(process.env.NEXT_PUBLIC_DAILY_PASS_PRICE_USDC || "0.5");

/** The backend unlock route needs a trace id in the path; a daily pass covers every trace. */
const DAILY_PASS_TRACE_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

interface Tier {
  name: string;
  /** null: not purchasable yet. */
  priceRaw: bigint | null;
  priceStr: string;
  period: string;
  description: string;
  features: { text: string; included: boolean }[];
  buttonText: string;
  featured?: boolean;
}

const tiers: Tier[] = [
  {
    name: "Free",
    priceRaw: 0n,
    priceStr: "$0",
    period: "",
    description: "Standard market access for retail observers.",
    buttonText: "CURRENT PLAN",
    features: [
      { text: "Basic Market View", included: true },
      { text: "100 Trace Depth", included: true },
      { text: "Priority Latency", included: false },
      { text: "Advanced API Access", included: false },
    ],
  },
  {
    name: "Pro",
    priceRaw: DAILY_PASS_PRICE_RAW,
    priceStr: `${formatUsdc(DAILY_PASS_PRICE_RAW, { minDecimals: 2 })} USDC`,
    period: "/24 hours",
    description: "Full reasoning traces for 24 hours, paid in USDC on Stellar.",
    buttonText: "GET A DAILY PASS",
    featured: true,
    features: [
      { text: "Full Market Depth", included: true },
      { text: "5,000 Trace Depth", included: true },
      { text: "Priority Data Routing", included: true },
      { text: "Read-Only API Access", included: true },
    ],
  },
  {
    name: "Institutional",
    priceRaw: null,
    priceStr: "—",
    period: "",
    description: "The terminal for firms and high-volume funds. Not available to buy yet.",
    buttonText: "NOT AVAILABLE YET",
    features: [
      { text: "Unlimited Market Depth", included: true },
      { text: "50,000 Trace Depth", included: true },
      { text: "Zero-Latency Dedicated Relay", included: true },
      { text: "Full Read/Write API", included: true },
    ],
  },
];

const features = [
  { name: "Trace Depth (Nodes)", free: "100", pro: "5,000", institutional: "50,000" },
  { name: "Latency Priority", free: "Standard (Shared)", pro: "High (Priority Queue)", institutional: "Ultra (Dedicated Relay)" },
  { name: "API Endpoints", free: "None", pro: "Read-only (Standard)", institutional: "Read/Write (Websockets)" },
  { name: "AI Insights (Oracle)", free: "Daily Summaries", pro: "Real-time Reasoning", institutional: "Predictive Modeling" },
];

export default function PremiumPage() {
  const { address, isConnected, isWrongNetwork, openModal, ensureSession } = useWallet();
  const transfer = useUsdcTransfer();
  const submitQueue = useSubmitQueueState(address);
  const unlock = useUnlockTrace();
  const reserve = useAccountReserve(address);

  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"usdc" | "card">("usdc");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [reviewModel, setReviewModel] = useState<{ model: ReviewModel; changedFrom?: ReviewModel } | null>(null);
  const reviewResolver = useRef<((approved: boolean) => void) | null>(null);
  const waitingForTransfer =
    submitQueue.waiting.some((job) => job.label === "USDC transfer") ||
    (submitQueue.lockWaiting && submitQueue.running?.label === "USDC transfer");

  const reviewPreparedTransfer = useCallback(async (_prepared: unknown, model: ReviewModel, changedFrom?: ReviewModel, forceReview = false) => {
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

  const prepareTransfer = usePrepareUsdcTransfer({
    to: PAYMENTS_RECIPIENT,
    amount: selectedTier?.priceRaw ?? null,
    holder: address,
  });

  const fees = prepareTransfer.data?.fees;
  const isUnfunded = Boolean(reserve.data && !reserve.data.funded);
  const isInsufficientXlm = Boolean(
    reserve.data?.funded &&
    fees &&
    reserve.data.spendable < fees.totalFee
  );
  const xlmDeficit = (reserve.data?.funded && fees && fees.totalFee > reserve.data.spendable)
    ? fees.totalFee - reserve.data.spendable
    : null;

  const openCheckout = async (tier: Tier) => {
    if (!tier.priceRaw) return;
    // Connecting stays on this page; keep the chosen tier if the wallet connects.
    if (!isConnected && !(await openModal())) return;
    setStatusMessage(null);
    setSelectedTier(tier);
  };

  const handlePayment = async () => {
    if (!selectedTier?.priceRaw) return;

    if (paymentMethod === "card") {
      setStatusMessage("Card payments aren't available. Pay with USDC instead.");
      return;
    }
    if (isWrongNetwork) {
      setStatusMessage("Switch your wallet to Stellar Testnet to complete the purchase.");
      return;
    }

    setIsSubmitting(true);
    try {
      setStatusMessage("One more signature: this logs you in to OracleDesk and doesn't move funds.");
      if (!(await ensureSession())) {
        setStatusMessage("You need to sign in with your wallet before paying.");
        return;
      }

      setStatusMessage(null);
      const { txHash } = await transfer.mutateAsync({
        to: PAYMENTS_RECIPIENT,
        amount: selectedTier.priceRaw,
        prepared: prepareTransfer.data,
        review: reviewPreparedTransfer,
        followUp: {
          type: "unlock-daily-pass",
          traceId: DAILY_PASS_TRACE_PLACEHOLDER,
          amountRaw: selectedTier.priceRaw.toString(),
        },
      });

      setStatusMessage("Payment sent. Waiting for OracleDesk to verify it on-chain…");
      await unlock.mutateAsync({
        traceId: DAILY_PASS_TRACE_PLACEHOLDER,
        txHash,
        amountRaw: selectedTier.priceRaw.toString(),
      });

      setStatusMessage(`Your daily pass is active for 24 hours. Transaction: ${explorerTx(txHash)}`);
      setTimeout(() => setSelectedTier(null), 4000);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Payment failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex-grow">
      {/* Hero Section */}
      <section className="py-16 bg-surface-container-low border-b border-outline-variant">
        <div className="max-w-container-max-width mx-auto px-gutter text-center">
          <span className="font-label-caps text-label-caps text-primary tracking-widest bg-primary-container/10 px-3 py-1 rounded-full mb-6 inline-block">
            INSTITUTIONAL GRADE
          </span>
          <h1 className="font-display-lg text-display-lg mb-4 text-4xl md:text-5xl">Elevate Your Analytical Edge</h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mx-auto">
            Access institutional-grade market prediction tools, sub-millisecond data latency, and advanced AI reasoning for high-stakes decision making.
          </p>
        </div>
      </section>

      {/* Pricing & Tier Selection */}
      <section className="py-12 px-gutter max-w-container-max-width mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 pt-8">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`bg-white border rounded-xl p-8 flex flex-col transition-all duration-300 relative ${
                tier.featured
                  ? "border-primary border-2 shadow-lg md:scale-105 z-10"
                  : "border-outline-variant hover:border-primary/50 shadow-sm"
              }`}
            >
              {tier.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-on-primary px-3 py-1 rounded-full font-label-caps text-label-caps text-[10px]">
                  MOST POPULAR
                </div>
              )}
              <div className="mb-8">
                <h3 className="font-headline-sm text-headline-sm mb-2">{tier.name}</h3>
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="font-display-lg text-display-lg text-4xl">{tier.priceStr}</span>
                  {tier.period && <span className="text-on-surface-variant font-body-md">{tier.period}</span>}
                </div>
                <p className="text-on-surface-variant font-body-md h-12">{tier.description}</p>
              </div>
              <ul className="space-y-4 flex-grow mb-8">
                {tier.features.map((feature, idx) => (
                  <li
                    key={idx}
                    className={`flex items-center gap-3 font-body-md ${
                      !feature.included ? "opacity-40" : ""
                    }`}
                  >
                    <span className="material-symbols-outlined text-primary text-lg">
                      {feature.included ? "check_circle" : "cancel"}
                    </span>
                    {feature.text}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => openCheckout(tier)}
                disabled={tier.priceRaw === null}
                className={`w-full py-3 rounded-lg font-label-caps text-label-caps transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  tier.name === "Free"
                    ? "border border-outline hover:bg-surface-container"
                    : tier.featured
                    ? "bg-primary text-on-primary hover:brightness-110"
                    : "border border-primary text-primary hover:bg-primary/5"
                }`}
              >
                {tier.buttonText}
              </button>
            </div>
          ))}
        </div>

        {/* Features Comparison Table */}
        <div className="mb-24">
          <h2 className="font-headline-md text-headline-md mb-8 text-center">Feature Breakdown</h2>
          <div className="overflow-x-auto border border-outline-variant rounded-xl bg-white shadow-sm">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr className="bg-surface-container-low border-b border-outline-variant">
                  <th className="p-4 font-label-caps text-label-caps">Features</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Free</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Pro</th>
                  <th className="p-4 font-label-caps text-label-caps text-center">Institutional</th>
                </tr>
              </thead>
              <tbody className="font-body-md divide-y divide-outline-variant">
                {features.map((f, i) => (
                  <tr key={i} className="hover:bg-surface-container-low/50 transition-colors">
                    <td className="p-4 font-medium">{f.name}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.free}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.pro}</td>
                    <td className="p-4 text-center text-on-surface-variant">{f.institutional}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* AI Reasoning Section */}
        <div className="bg-white border border-outline-variant rounded-2xl overflow-hidden mb-24 flex flex-col md:flex-row shadow-sm">
          <div className="md:w-1/2 p-8 md:p-12 bg-surface-container-low flex flex-col justify-center">
            <h2 className="font-display-lg text-display-lg mb-6 leading-tight text-3xl md:text-4xl">
              Powered by Oracle AI Reasoning
            </h2>
            <p className="font-body-lg text-body-lg text-on-surface-variant mb-8 leading-relaxed">
              Our proprietary reasoning engine analyzes billions of on-chain data points to provide &quot;Oracle Insights&quot;—AI-generated predictive narratives that distinguish raw data from market noise.
            </p>
            <div className="flex flex-wrap gap-4">
              <div className="bg-white p-4 border border-outline-variant rounded-lg flex-1 min-w-[140px]">
                <span className="font-label-caps text-label-caps text-primary block mb-2">ACCURACY</span>
                <span className="font-headline-sm text-headline-sm">94.2%</span>
              </div>
              <div className="bg-white p-4 border border-outline-variant rounded-lg flex-1 min-w-[140px]">
                <span className="font-label-caps text-label-caps text-primary block mb-2">UPTIME</span>
                <span className="font-headline-sm text-headline-sm">99.99%</span>
              </div>
            </div>
          </div>
          <div className="md:w-1/2 relative h-64 md:h-auto overflow-hidden">
            <img
              className="absolute inset-0 w-full h-full object-cover grayscale opacity-80"
              alt="AI Reasoning Visualization"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuAa6_iBtnOn_m37HN9i8iSM2WGtLI2O7724tEV1Lwtbv-GGPQ23M_8Ng5x56bioNBpuHpLU5pnYBL3d8-em8tJDo4E1MGMdaCxefcsadvDMXYBr7fBmUYgX9aeZNQ_Hmx2d7KN57E8mUefZU9FDAW7Dprf7vIVrX3lK4CuZXz1njfkdn9pfaRe2ujTB9rsBD_BZUXUbRwNAkdVh9-cGODrXj8J5pggMpgxMrCUHFsylQTCEbzk7CM0sJVfddH4ugiek22UZ3yMKNA"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-surface-container-low via-transparent to-transparent md:block hidden"></div>
          </div>
        </div>
      </section>

      {/* Checkout Modal */}
      <AnimatePresence>
        {selectedTier && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-on-background/40 backdrop-blur-sm"
              onClick={() => setSelectedTier(null)}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden z-10"
            >
              <div className="p-6 md:p-8 border-b border-outline-variant flex justify-between items-center">
                <h2 className="font-headline-md text-headline-md">Confirm Subscription</h2>
                <button
                  className="material-symbols-outlined text-on-surface-variant hover:text-error transition-colors cursor-pointer"
                  aria-label="Close"
                  onClick={() => setSelectedTier(null)}
                >
                  close
                </button>
              </div>
              <div className="p-6 md:p-8">
                <div className="bg-surface-container-low p-4 rounded-xl mb-8 flex justify-between items-center border border-outline-variant">
                  <div>
                    <p className="font-label-caps text-label-caps text-primary font-bold">
                      {selectedTier.name.toUpperCase()} TIER
                    </p>
                    <p className="font-body-md text-on-surface-variant">One payment, 24 hours of access</p>
                  </div>
                  <p className="font-headline-md text-headline-md text-on-surface text-2xl">
                    {selectedTier.priceStr}
                  </p>
                </div>

                <div className="space-y-6">
                  <h4 className="font-label-caps text-label-caps text-on-surface-variant border-b border-outline-variant pb-2">
                    PAYMENT METHOD
                  </h4>
                  
                  {/* USDC Option */}
                  <label 
                    className={`relative flex items-center p-4 border-2 rounded-xl cursor-pointer transition-all ${
                      paymentMethod === 'usdc' ? "border-primary bg-primary-container/5" : "border-outline-variant hover:bg-surface-container-low"
                    }`}
                    onClick={() => setPaymentMethod('usdc')}
                  >
                    <div className="w-10 h-10 bg-surface rounded-full flex items-center justify-center mr-4 border border-outline-variant overflow-hidden p-2">
                      <img
                        alt="USDC"
                        className="w-full h-full object-contain"
                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuBBvpQJwosd2Frufdsjv33xmFEaqtUyhsE7FZ71B5HnGDdKxuZG6lxUBHLUN_72b5kg8Agl5q3-hEH2fEuAb-_pLcvFyXnM2K9saaM5DGU8S2lDvNZOLVEDFLm5SZ9m-oysbN474n7-m_f-fQPvR6m4aDDh2HeL4e_wKmfjwe5QkDRKk08h6N-QM6DBGHrMYIomFLujEFtdcTyccMq0i3ccnRBg7U4tC0Ig0D_KgAfB-bt_2ZdSeXk_I5gkzYAQszAvYnfg5lpgPA"
                      />
                    </div>
                    <div className="flex-grow">
                      <p className="font-body-md font-bold">Pay with USDC</p>
                      <p className="text-xs text-on-surface-variant">From your wallet on Stellar Testnet</p>
                    </div>
                    {paymentMethod === 'usdc' && (
                      <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                        check_circle
                      </span>
                    )}
                  </label>

                  {/* Credit Card Option */}
                  <label 
                    className={`relative flex items-center p-4 border-2 rounded-xl cursor-pointer transition-all ${
                      paymentMethod === 'card' ? "border-primary bg-primary-container/5" : "border-outline-variant hover:bg-surface-container-low"
                    }`}
                    onClick={() => setPaymentMethod('card')}
                  >
                    <div className="w-10 h-10 bg-surface rounded-full flex items-center justify-center mr-4 border border-outline-variant">
                      <span className="material-symbols-outlined text-on-surface-variant">credit_card</span>
                    </div>
                    <div className="flex-grow">
                      <p className="font-body-md font-bold">Credit / Debit Card</p>
                      <p className="text-xs text-on-surface-variant">Not available yet</p>
                    </div>
                    {paymentMethod === 'card' && (
                      <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                        check_circle
                      </span>
                    )}
                  </label>
                </div>

                <div className="mt-8 space-y-4">
                  <div
                    className="flex justify-between font-body-md text-on-surface-variant text-sm"
                    title={fees ? `Inclusion: ${formatXlm(fees.inclusionFee)} XLM · Resource: ${formatXlm(fees.resourceFee)} XLM (assumes the network base reserve of 0.5 XLM)` : "assumes the network base reserve of 0.5 XLM"}
                  >
                    <span>Network fee</span>
                    <span className="font-data-mono text-xs">
                      {fees ? `≈ ${formatXlm(fees.totalFee)} XLM` : prepareTransfer.isLoading ? "calculating…" : "Paid in XLM"} ·{" "}
                      {reserve.isLoading
                        ? "checking…"
                        : reserve.isError
                        ? "couldn't check XLM balance"
                        : reserve.data && !reserve.data.funded
                        ? "unfunded"
                        : reserve.data
                        ? `spendable ${formatXlm(reserve.data.spendable, { maxDecimals: 1 })} XLM`
                        : "spendable —"}
                    </span>
                  </div>

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

                  <div className="flex justify-between font-headline-sm text-headline-sm pt-4 border-t border-outline-variant">
                    <span>Total Due</span>
                    <span className="text-primary">{selectedTier.priceStr}</span>
                  </div>

                  {/* Live Tx phase */}
                  {transfer.isPending && (
                    <div className="p-3 bg-primary-container/10 border border-primary/20 rounded text-primary text-xs font-bold flex items-center justify-between" role="status">
                      <span>{renderTxPhase(transfer.phase) ?? statusMessage ?? "Processing payment…"}</span>
                      {"hash" in transfer.phase && transfer.phase.hash && (
                        <a
                          href={explorerTx(transfer.phase.hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline font-data-mono"
                        >
                          View: {transfer.phase.hash.slice(0, 8)}…
                        </a>
                      )}
                    </div>
                  )}

                  {/* Final or error status */}
                  {!transfer.isPending && statusMessage && (
                    <div className="p-3 bg-primary-container/10 border border-primary/20 rounded text-primary text-xs font-bold break-all" role="status">
                      {waitingForTransfer ? "Waiting for your previous transaction to finish…" : statusMessage}
                    </div>
                  )}

                  <button 
                    className="w-full py-4 bg-primary text-on-primary font-headline-sm text-headline-sm rounded-xl mt-4 hover:shadow-lg active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50"
                    onClick={handlePayment}
                    disabled={
                      isSubmitting ||
                      transfer.isPending ||
                      (isConnected && isUnfunded) ||
                      (isConnected && isInsufficientXlm)
                    }
                  >
                    {isSubmitting || transfer.isPending
                      ? (transfer.phase.name === "awaiting-signature" ? "Signing…" : "Processing...")
                      : isUnfunded
                      ? "Fund Account"
                      : isInsufficientXlm
                      ? "Insufficient XLM"
                      : paymentMethod === 'usdc' ? "Pay with Wallet" : "Proceed to Payment"}
                  </button>
                  <p className="text-center text-[10px] text-on-surface-variant uppercase tracking-widest mt-4">
                    Verified on-chain by OracleDesk before access is granted
                  </p>
                  <div className="text-center">
                    <TxReviewPreferenceControl />
                  </div>
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
