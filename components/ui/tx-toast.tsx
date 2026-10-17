"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/contexts/WalletContext";
import { explorerTx } from "@/lib/stellar/config";
import { formatUsdc } from "@/lib/stellar/units";
import { useTxTracker, type TrackedTx } from "@/lib/stellar/tx-tracker";
import { unlockDailyPass } from "@/lib/api/traces";

export function TxToastContainer() {
  const { list, dismiss } = useTxTracker();
  const { address } = useWallet();
  const [showAll, setShowAll] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [unlockingHash, setUnlockingHash] = useState<string | null>(null);
  const [unlockSuccess, setUnlockSuccess] = useState<Record<string, boolean>>({});
  const [unlockError, setUnlockError] = useState<Record<string, string>>({});

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const visibleList = list.filter((tx) => (showAll || !address ? true : tx.holder === address));

  if (!isOpen || visibleList.length === 0) return null;

  const handleUnlock = async (tx: TrackedTx) => {
    if (!tx.followUp || tx.followUp.type !== "unlock-daily-pass") return;
    setUnlockingHash(tx.hash);
    setUnlockError((prev) => ({ ...prev, [tx.hash]: "" }));
    try {
      await unlockDailyPass(tx.followUp.traceId, tx.hash, tx.followUp.amountRaw);
      setUnlockSuccess((prev) => ({ ...prev, [tx.hash]: true }));
    } catch (err: unknown) {
      setUnlockError((prev) => ({
        ...prev,
        [tx.hash]: err instanceof Error ? err.message : "Failed to activate pass",
      }));
    } finally {
      setUnlockingHash(null);
    }
  };

  return (
    <aside
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full px-4 sm:px-0 pointer-events-none"
      role="status"
      aria-live="polite"
      aria-label="Transaction Notifications"
    >
      <div className="flex justify-between items-center bg-surface-container-lowest/90 backdrop-blur-md px-3 py-1.5 rounded-lg border border-outline-variant shadow-md pointer-events-auto text-xs">
        <span className="font-label-caps font-bold text-on-surface">
          Transactions ({visibleList.length})
        </span>
        <div className="flex items-center gap-2">
          {address && (
            <button
              onClick={() => setShowAll((prev) => !prev)}
              className="text-[10px] text-primary hover:underline font-semibold"
            >
              {showAll ? "My txs only" : "Show all"}
            </button>
          )}
          <button
            onClick={() => setIsOpen(false)}
            aria-label="Close transactions drawer"
            className="text-on-surface-variant hover:text-on-surface text-sm p-0.5"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-[70vh] overflow-y-auto pointer-events-auto">
        {visibleList.map((tx) => {
          const amountRaw =
            tx.amounts.collateralIn ?? tx.amounts.amount ?? tx.amounts.collateralOut ?? tx.amounts.shares ?? "0";
          let formattedAmount = "";
          try {
            formattedAmount = formatUsdc(BigInt(amountRaw), { grouping: true });
          } catch {
            formattedAmount = amountRaw;
          }

          const stateColor =
            tx.state === "confirmed"
              ? "text-emerald-600 bg-emerald-500/10 border-emerald-500/20"
              : tx.state === "failed"
              ? "text-rose-600 bg-rose-500/10 border-rose-500/20"
              : tx.state === "expired"
              ? "text-amber-600 bg-amber-500/10 border-amber-500/20"
              : "text-primary bg-primary/10 border-primary/20";

          return (
            <div
              key={tx.hash}
              className={`p-3.5 rounded-xl border bg-white shadow-lg transition-all text-xs flex flex-col gap-2 ${stateColor}`}
            >
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[11px]">
                  <span>{tx.kind.replace("-", " ")}</span>
                  {tx.marketId && <span className="text-on-surface-variant font-normal">#{tx.marketId}</span>}
                  {tx.outcome && <span>({tx.outcome})</span>}
                </div>
                <button
                  onClick={() => dismiss(tx.hash)}
                  aria-label="Dismiss transaction"
                  className="text-on-surface-variant hover:text-on-surface p-0.5 text-xs"
                >
                  ✕
                </button>
              </div>

              <div className="flex justify-between items-center font-data-mono text-[11px] text-on-surface">
                <span>Amount: {formattedAmount} USDC</span>
                <span className="font-semibold capitalize flex items-center gap-1">
                  {tx.state === "pending" && (
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                  )}
                  {tx.state}
                </span>
              </div>

              {tx.error && (
                <p className="text-[10px] text-rose-600 leading-tight">
                  {tx.error.message}
                </p>
              )}

              {tx.mayNotHaveBeenSent && (
                <p className="text-[10px] text-amber-600">
                  May not have been broadcast before deadline.
                </p>
              )}

              {tx.followUp?.type === "unlock-daily-pass" && tx.state === "confirmed" && (
                <div className="pt-1.5 border-t border-outline-variant flex flex-col gap-1">
                  {unlockSuccess[tx.hash] ? (
                    <span className="text-emerald-600 font-bold text-[11px]">Pass activated!</span>
                  ) : (
                    <>
                      <span className="text-on-surface-variant text-[10px]">
                        Payment confirmed. Finish activating your pass:
                      </span>
                      <button
                        onClick={() => handleUnlock(tx)}
                        disabled={unlockingHash === tx.hash}
                        className="bg-primary text-primary-foreground font-semibold px-2.5 py-1 rounded-md text-[11px] hover:opacity-90 transition-opacity flex items-center justify-center gap-1 w-full"
                      >
                        {unlockingHash === tx.hash ? "Activating…" : "Activate Pass"}
                      </button>
                      {unlockError[tx.hash] && (
                        <span className="text-rose-600 text-[10px]">{unlockError[tx.hash]}</span>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 pt-1 text-[10px] font-label-caps">
                <Link
                  href={`/tx?hash=${tx.hash}`}
                  className="text-primary hover:underline font-bold"
                >
                  Details
                </Link>
                <a
                  href={explorerTx(tx.hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-on-surface-variant hover:text-on-surface hover:underline"
                >
                  Explorer ↗
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
