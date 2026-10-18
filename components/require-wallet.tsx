"use client";

import type { ReactNode } from "react";
import { useWallet } from "@/lib/contexts/WalletContext";

/**
 * Renders `children` once a wallet is connected. Until then it shows a card
 * with a Connect button that keeps the user on the current page.
 */
export function RequireWallet({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: string;
  description: string;
}) {
  const { isConnected, isConnecting, openModal } = useWallet();
  if (isConnected) return <>{children}</>;

  return (
    <main className="flex-grow flex items-center justify-center p-gutter">
      <div className="max-w-md w-full text-center space-y-6 bg-white p-10 rounded-xl border border-outline-variant shadow-sm">
        <div className="w-20 h-20 bg-primary-container text-primary rounded-full flex items-center justify-center mx-auto">
          <span className="material-symbols-outlined text-4xl">lock</span>
        </div>
        <div className="space-y-2">
          <h2 className="font-headline-md text-headline-md">{title}</h2>
          <p className="text-on-surface-variant">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => void openModal()}
          disabled={isConnecting}
          className="w-full bg-primary text-primary-foreground py-4 rounded-lg font-label-caps text-label-caps hover:brightness-110 transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer disabled:opacity-60"
        >
          <span className="material-symbols-outlined">account_balance_wallet</span>
          {isConnecting ? "CONNECTING…" : "CONNECT WALLET"}
        </button>
      </div>
    </main>
  );
}
