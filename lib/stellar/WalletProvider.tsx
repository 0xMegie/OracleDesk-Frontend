"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearAuthSession, getStoredSessionWallet, signInWithWallet } from "@/lib/api/auth";
import { broadcastWalletDisconnect, createCrossTabSync } from "@/lib/api/cross-tab-sync";
import { safeReturnTo } from "@/lib/navigation";
import { NETWORK_PASSPHRASE } from "./config";
import { describeError, UserFacingError } from "./errors";
import type { Signer } from "./clients";
import { loadStellarWalletsKit, type WalletKitAdapter } from "./wallet-kit-adapter";
import { WalletInterpreter } from "./wallet-interpreter";
import { viewOf } from "./wallet-machine";
import { TransactionTrackerProvider } from "./tx-tracker";

export interface OpenModalOptions {
  /**
   * Where to go after a successful connect. Only a same-origin path is used
   * (see safeReturnTo). Without it the user stays on the page they are on.
   */
  returnTo?: string;
}

export interface WalletContextValue {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** Passphrase the wallet reports, or null before it has said. */
  walletNetworkPassphrase: string | null;
  isWrongNetwork: boolean;
  /** Signs as the connected account; null when disconnected. */
  signer: Signer | null;
  /** True when the backend session (JWT) belongs to the connected address. */
  isAuthenticated: boolean;
  /** Last connect/sign-in error, in plain language. */
  error: string | null;
  /** Resolves true if a wallet is connected when the attempt ends. Stays on the current page. */
  openModal: (opts?: OpenModalOptions) => Promise<boolean>;
  /** Runs the backend challenge login if there's no session for this address. */
  ensureSession: () => Promise<boolean>;
  /**
   * Signs in to the backend right before `fn`, which calls a protected endpoint.
   * Throws a readable error if the user declines, so `fn` never runs without a session.
   */
  withSession: <T>(fn: () => Promise<T>, why: string) => Promise<T>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

export interface WalletProviderProps {
  children: ReactNode;
  /** Replaces the real kit in tests. Defaults to loading Stellar Wallets Kit in the browser. */
  kitLoader?: () => Promise<WalletKitAdapter>;
}

export function WalletProvider({ children, kitLoader = loadStellarWalletsKit }: WalletProviderProps) {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 1000 * 60 * 2, refetchOnWindowFocus: false } },
      }),
  );

  // All wallet logic lives in the state machine; this component only renders it.
  // The initializer stores deferred navigation callbacks; it never reads the ref.
  const [interpreter] = useState(
    // eslint-disable-next-line react-hooks/refs
    () =>
      new WalletInterpreter({
        loadKit: kitLoader,
        storedSessionWallet: getStoredSessionWallet,
        clearBackendSession: clearAuthSession,
        signIn: async (address, sign) => {
          const session = await signInWithWallet(address, async (xdr, networkPassphrase) => {
            const { signedTxXdr } = await sign(xdr, { networkPassphrase, address });
            return signedTxXdr;
          });
          return session.walletAddress;
        },
        purgeStellarQueries: () => queryClient.removeQueries({ queryKey: ["stellar"] }),
        navigate: (to) => routerRef.current.replace(to),
        describe: (err) => describeError(err),
        broadcastDisconnect: broadcastWalletDisconnect,
      }),
  );

  // Starts the kit, restores a session the kit persisted (never redirects or
  // prompts), and tears the kit subscriptions down on unmount.
  useEffect(() => interpreter.start(), [interpreter]);

  // Changes made in another tab (disconnect, account switch, login) reach this tab.
  useEffect(() => {
    const sync = createCrossTabSync((msg) => interpreter.applyCrossTab(msg));
    return () => sync.unsubscribe();
  }, [interpreter]);

  const state = useSyncExternalStore(interpreter.subscribe, interpreter.getState, interpreter.getState);
  const view = useMemo(() => viewOf(state), [state]);
  const { address } = view;

  const signer = useMemo<Signer | null>(() => {
    if (!address) return null;
    return {
      publicKey: address,
      signTransaction: (xdr, opts) =>
        interpreter.signTransaction(xdr, { networkPassphrase: opts?.networkPassphrase ?? NETWORK_PASSPHRASE, address }),
    };
  }, [address, interpreter]);

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      isConnected: view.isConnected,
      isConnecting: view.isConnecting,
      walletNetworkPassphrase: view.walletNetworkPassphrase,
      isWrongNetwork: Boolean(view.walletNetworkPassphrase) && view.walletNetworkPassphrase !== NETWORK_PASSPHRASE,
      signer,
      isAuthenticated: view.isAuthenticated,
      error: view.error,
      openModal: (opts) => interpreter.openModal(safeReturnTo(opts?.returnTo)),
      ensureSession: () => interpreter.ensureSession(),
      withSession: async (fn, why) => {
        if (!(await interpreter.ensureSession())) {
          const connected = viewOf(interpreter.getState()).isConnected;
          throw new UserFacingError({
            kind: "disconnected",
            message: connected ? `Sign in with your wallet to ${why}.` : `Connect your wallet to ${why}.`,
          });
        }
        return fn();
      },
      disconnect: async () => interpreter.disconnect(),
    }),
    [address, view, signer, interpreter],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WalletContext.Provider value={value}>
        <TransactionTrackerProvider>{children}</TransactionTrackerProvider>
      </WalletContext.Provider>
    </QueryClientProvider>
  );
}
