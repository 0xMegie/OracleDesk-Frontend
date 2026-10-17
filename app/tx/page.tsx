"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { scValToNative } from "@stellar/stellar-sdk";
import { rpcServer } from "@/lib/stellar/clients";
import { explorerTx } from "@/lib/stellar/config";
import { formatXlm } from "@/lib/stellar/units";
import { describeError } from "@/lib/stellar/errors";

export default function TxPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-[calc(100vh-64px)] bg-surface flex items-center justify-center p-6">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </main>
      }
    >
      <TxContent />
    </Suspense>
  );
}

function TxContent() {
  const searchParams = useSearchParams();
  const rawHash = searchParams.get("hash")?.trim() ?? "";
  const isValidHex64 = /^[0-9a-fA-F]{64}$/.test(rawHash);
  const hash = isValidHex64 ? rawHash.toLowerCase() : null;

  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["stellar", "tx", hash],
    enabled: Boolean(hash),
    queryFn: async () => {
      if (!hash) return null;
      return await rpcServer().getTransaction(hash);
    },
    refetchInterval: (query) => {
      // Keep polling if transaction is still pending or not yet found
      if (query.state.data?.status === "NOT_FOUND") {
        return 2000;
      }
      return false;
    },
    staleTime: 10_000,
  });

  const handleCopy = () => {
    if (!hash) return;
    void navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!rawHash || !isValidHex64) {
    return (
      <main className="min-h-[calc(100vh-64px)] bg-surface flex items-center justify-center p-6">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl max-w-lg w-full p-8 text-center space-y-6 shadow-sm">
          <div className="w-16 h-16 bg-error-container text-error rounded-full flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-4xl">error</span>
          </div>
          <div>
            <h1 className="font-headline-md text-headline-md text-on-surface mb-2">Invalid Transaction Hash</h1>
            <p className="font-body-md text-on-surface-variant text-sm">
              {rawHash
                ? "The transaction hash provided is not a valid 64-character hex string."
                : "No transaction hash was provided in the query string."}
            </p>
          </div>
          <Link
            href="/markets"
            className="inline-block bg-primary text-primary-foreground px-6 py-3 rounded-xl font-label-caps text-label-caps font-bold hover:brightness-110 transition-all"
          >
            Back to Markets
          </Link>
        </div>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="min-h-[calc(100vh-64px)] bg-surface flex items-center justify-center p-6">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl max-w-lg w-full p-8 text-center space-y-4 shadow-sm">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Fetching Transaction</h2>
          <p className="font-body-md text-on-surface-variant text-xs font-data-mono break-all">{hash}</p>
        </div>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="min-h-[calc(100vh-64px)] bg-surface flex items-center justify-center p-6">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl max-w-lg w-full p-8 text-center space-y-6 shadow-sm">
          <div className="w-16 h-16 bg-error-container text-error rounded-full flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-4xl">cloud_off</span>
          </div>
          <div>
            <h1 className="font-headline-md text-headline-md text-on-surface mb-2">RPC Query Failed</h1>
            <p className="font-body-md text-on-surface-variant text-sm">
              {error instanceof Error ? error.message : "Unable to reach the Stellar RPC server."}
            </p>
          </div>
          <div className="flex justify-center gap-3">
            <button
              onClick={() => void refetch()}
              className="bg-primary text-primary-foreground px-5 py-2.5 rounded-xl font-label-caps text-label-caps font-bold hover:brightness-110 transition-all"
            >
              Retry Query
            </button>
            <a
              href={explorerTx(hash!)}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-outline px-5 py-2.5 rounded-xl font-label-caps text-label-caps font-bold hover:bg-surface-variant transition-all"
            >
              View on Explorer
            </a>
          </div>
        </div>
      </main>
    );
  }

  const isNotFound = data.status === "NOT_FOUND";
  const isSuccess = data.status === "SUCCESS";
  const isFailed = data.status === "FAILED";

  const settledData = isSuccess || isFailed ? data : null;
  const ledger = settledData?.ledger ?? null;
  const applicationOrder = settledData?.applicationOrder ?? null;

  // Parse result value or failure error
  let parsedResult: string | null = null;
  if (isSuccess && data.returnValue) {
    try {
      const native = scValToNative(data.returnValue);
      parsedResult = typeof native === "bigint" ? native.toString() : JSON.stringify(native);
    } catch {
      parsedResult = null;
    }
  }

  let failureDescription: string | null = null;
  if (isFailed && data.resultXdr) {
    try {
      failureDescription = describeError(data.resultXdr, "marketCore").message;
    } catch {
      failureDescription = "Transaction execution reverted on-chain.";
    }
  }

  const feeCharged = settledData ? formatXlm(BigInt(settledData.resultXdr.feeCharged().toString())) : null;

  return (
    <main className="min-h-[calc(100vh-64px)] bg-surface py-12 px-gutter">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant">
          <Link href="/markets" className="hover:text-primary transition-colors">
            Markets
          </Link>
          <span>/</span>
          <span className="text-on-surface font-bold">Transaction</span>
        </div>

        {/* Main Details Card */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl overflow-hidden shadow-sm">
          {/* Card Header */}
          <div className="p-6 md:p-8 border-b border-outline-variant bg-surface-container-low/40 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center ${
                  isSuccess
                    ? "bg-secondary-container text-on-secondary-container"
                    : isFailed
                    ? "bg-error-container text-error"
                    : "bg-surface-container text-outline"
                }`}
              >
                <span className="material-symbols-outlined text-3xl">
                  {isSuccess ? "check_circle" : isFailed ? "cancel" : "hourglass_top"}
                </span>
              </div>
              <div>
                <h1 className="font-headline-md text-headline-md text-on-surface">
                  {isSuccess
                    ? "Transaction Confirmed"
                    : isFailed
                    ? "Transaction Failed"
                    : "Pending / Expired from RPC"}
                </h1>
                <p className="font-body-md text-on-surface-variant text-xs sm:text-sm">
                  {isSuccess
                    ? `Settled on Stellar ledger #${ledger}`
                    : isFailed
                    ? `Failed on ledger #${ledger ?? "unknown"}`
                    : "Not retained in recent RPC ledgers or still propagating"}
                </p>
              </div>
            </div>

            {/* Live refresh indicator */}
            {isFetching && (
              <span className="text-[10px] font-label-caps text-primary animate-pulse flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">sync</span> Syncing
              </span>
            )}
          </div>

          {/* Details Body */}
          <div className="p-6 md:p-8 space-y-6">
            {/* Hash Row */}
            <div className="space-y-1.5">
              <label className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] font-bold">
                Transaction Hash
              </label>
              <div className="flex items-center gap-2 bg-surface p-3 border border-outline-variant rounded-xl font-data-mono text-xs text-on-surface break-all">
                <span className="flex-1 select-all">{hash}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  title="Copy transaction hash"
                  className="p-1 hover:bg-surface-container rounded transition-colors text-outline hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-base">
                    {copied ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            </div>

            {/* NOT_FOUND State Notice */}
            {isNotFound && (
              <div className="p-4 bg-surface-container-low border border-outline-variant rounded-xl text-xs text-on-surface-variant space-y-2 leading-relaxed">
                <p className="font-bold text-on-surface">Why is this transaction not found?</p>
                <p>
                  Stellar RPC nodes only retain transactions for a limited window of recent ledgers (~100 to 200 ledgers).
                  If this transaction was submitted earlier, it has been committed to the ledger history and can be viewed directly
                  on Stellar Expert block explorer.
                </p>
              </div>
            )}

            {/* Error Message for Failed Tx */}
            {isFailed && failureDescription && (
              <div className="p-4 bg-error-container/10 border border-error/20 rounded-xl text-xs text-error space-y-1">
                <p className="font-bold">Error Reason:</p>
                <p className="font-data-mono leading-relaxed">{failureDescription}</p>
              </div>
            )}

            {/* On-Chain Metrics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="p-4 bg-surface-container-low border border-outline-variant rounded-xl space-y-1">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] block">
                  Status
                </span>
                <span
                  className={`font-data-mono font-bold text-sm ${
                    isSuccess ? "text-secondary" : isFailed ? "text-error" : "text-outline"
                  }`}
                >
                  {data.status}
                </span>
              </div>

              <div className="p-4 bg-surface-container-low border border-outline-variant rounded-xl space-y-1">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] block">
                  Ledger
                </span>
                <span className="font-data-mono text-on-surface font-bold text-sm">
                  {ledger ?? "—"}
                </span>
              </div>

              <div className="p-4 bg-surface-container-low border border-outline-variant rounded-xl space-y-1">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] block">
                  Fee Charged
                </span>
                <span className="font-data-mono text-on-surface font-bold text-sm">
                  {feeCharged ? `${feeCharged} XLM` : "—"}
                </span>
              </div>

              <div className="p-4 bg-surface-container-low border border-outline-variant rounded-xl space-y-1">
                <span className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] block">
                  Application Order
                </span>
                <span className="font-data-mono text-on-surface font-bold text-sm">
                  {applicationOrder ?? "—"}
                </span>
              </div>
            </div>

            {/* Return Value / Result Output */}
            {parsedResult !== null && (
              <div className="space-y-1.5">
                <label className="font-label-caps text-label-caps text-on-surface-variant uppercase text-[10px] font-bold">
                  Decoded Return Value
                </label>
                <div className="p-3 bg-surface border border-outline-variant rounded-xl font-data-mono text-xs text-on-surface break-all">
                  {parsedResult}
                </div>
              </div>
            )}
          </div>

          {/* Action Footer */}
          <div className="p-6 md:p-8 bg-surface-container-low/60 border-t border-outline-variant flex flex-wrap items-center justify-between gap-4">
            <div className="flex gap-3">
              <Link
                href="/markets"
                className="bg-primary text-primary-foreground px-5 py-2.5 rounded-xl font-label-caps text-label-caps font-bold hover:brightness-110 transition-all text-center"
              >
                Explore Markets
              </Link>
              <Link
                href="/portfolio"
                className="border border-outline px-5 py-2.5 rounded-xl font-label-caps text-label-caps font-bold hover:bg-surface-variant transition-all text-center"
              >
                Portfolio
              </Link>
            </div>

            <a
              href={explorerTx(hash!)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-primary hover:underline font-label-caps text-label-caps font-bold text-xs"
            >
              <span>View on Stellar Expert</span>
              <span className="material-symbols-outlined text-sm">open_in_new</span>
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
