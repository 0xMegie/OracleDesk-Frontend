"use client";

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useAccountReserve, useEnableUsdc, useRpcNetwork, useUsdcBalance, useUsdcTrustline, useUsdcBalanceState } from "@/lib/hooks/useStellar";
import { NETWORK_LABEL, NETWORK_PASSPHRASE, TESTNET_PASSPHRASE, explorerAccount } from "@/lib/stellar/config";
import { PendingValue } from "@/components/pending-value";
import { formatUsdc, formatXlm, shortAddress } from "@/lib/stellar/units";

const WalletDropdown = () => {
  const { address, isConnected, isConnecting, isWrongNetwork, openModal, disconnect, error } = useWallet();
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const balance = useUsdcBalance(address);
  const balanceState = useUsdcBalanceState(address);
  const trustline = useUsdcTrustline(address);
  const enableUsdc = useEnableUsdc();
  const reserve = useAccountReserve(address);
  const rpcNetwork = useRpcNetwork();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!isConnected || !address) {
    return (
      <button
        onClick={() => openModal()}
        disabled={isConnecting}
        title={error ?? undefined}
        className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-label-caps text-label-caps uppercase tracking-wider hover:opacity-90 transition-all active:scale-95 disabled:opacity-60"
      >
        {isConnecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  const truncatedAddress = shortAddress(address, 6, 4);
  const trustlineMissing = !isWrongNetwork && trustline.data?.kind === "missing";
  const unauthorized = trustline.data?.kind === "present" && !trustline.data.authorized;
  const balanceText = trustlineMissing
    ? "USDC not enabled"
    : balance.data !== undefined
    ? formatUsdc(balance.data, { maxDecimals: 2, minDecimals: 2, grouping: true })
    : balance.isError ? "—" : "…";
  const notActivated = !isWrongNetwork && reserve.data?.funded === false;
  const xlmText = reserve.data?.funded
    ? formatXlm(reserve.data.balance, { maxDecimals: 2, minDecimals: 2, grouping: true })
    : reserve.isError ? "—" : "…";
  // Friendbot exists only on testnet; the RPC says where it is.
  const friendbotUrl =
    NETWORK_PASSPHRASE === TESTNET_PASSPHRASE && rpcNetwork.data?.friendbotUrl
      ? `${rpcNetwork.data.friendbotUrl}?addr=${encodeURIComponent(address)}`
      : null;

  const handleEnableUsdc = async () => {
    try {
      await enableUsdc.mutateAsync();
    } catch {
      // The mutation error is rendered in the wallet menu below.
    }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the address is still visible in the menu.
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Wallet menu"
        aria-expanded={isOpen}
        className="flex items-center gap-3 px-3 py-1.5 bg-surface-container-low border border-outline-variant rounded-lg hover:bg-surface-container transition-colors active:scale-95"
      >
        <div className="flex flex-col items-end hidden sm:flex">
          <span className={`text-[10px] font-bold leading-none uppercase ${isWrongNetwork ? "text-error" : "text-on-surface-variant"}`}>
            {isWrongNetwork ? "Wrong network" : NETWORK_LABEL}
          </span>
          <span className="text-sm font-data-mono font-bold text-on-surface">
            {truncatedAddress}
          </span>
        </div>
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>
        </div>
        <span className={`material-symbols-outlined text-on-surface-variant transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {/* Dropdown Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 mt-2 w-64 bg-white border border-outline-variant rounded-xl shadow-xl z-[100] overflow-hidden"
          >
            {/* Balance Section */}
            <div className="p-4 bg-surface-container-low border-b border-outline-variant">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
                Available Balance
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold text-on-surface font-data-mono">
                  {balanceText}<PendingValue state={balanceState.data} />
                </span>
                <span className="text-xs font-bold text-on-surface-variant uppercase">
                  USDC
                </span>
              </div>
              {!isWrongNetwork && (
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-sm font-bold text-on-surface font-data-mono">{xlmText}</span>
                  <span className="text-xs font-bold text-on-surface-variant uppercase">XLM</span>
                  <span className="ml-1 text-[10px] text-on-surface-variant">(fees and reserve)</span>
                </div>
              )}
              {notActivated && (
                <div role="status" className="mt-3 rounded-md border border-outline-variant bg-white p-2">
                  <span className="block text-xs font-bold text-on-surface">Account not activated</span>
                  <p className="mt-1 text-[11px] text-on-surface-variant">
                    This Stellar account needs a little XLM before it can trade. Fund it to continue.
                  </p>
                  {friendbotUrl && (
                    <a
                      href={friendbotUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground"
                    >
                      Fund with Friendbot
                    </a>
                  )}
                </div>
              )}
              {trustlineMissing && !isWrongNetwork && (
                <button
                  type="button"
                  onClick={handleEnableUsdc}
                  disabled={enableUsdc.isPending}
                  className="mt-2 rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                >
                  {enableUsdc.isPending ? "Enabling…" : "Enable USDC"}
                </button>
              )}
              {unauthorized && (
                <p className="mt-2 text-[11px] text-error">The issuer hasn&apos;t authorized your USDC trustline.</p>
              )}
              {enableUsdc.error && (
                <p className="mt-2 text-[11px] text-error">{enableUsdc.error.message}</p>
              )}
              {isWrongNetwork && (
                <p className="mt-2 text-[11px] text-error">Your wallet is on a different network. Switch it to Stellar Testnet.</p>
              )}
            </div>

            {/* Menu Items */}
            <div className="p-2">
              <button
                onClick={copyAddress}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-container rounded-lg transition-colors group"
              >
                <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary">
                  {copied ? "check" : "content_copy"}
                </span>
                <div className="text-left">
                  <span className="block text-sm font-bold text-on-surface">{copied ? "Copied" : "Copy address"}</span>
                  <span className="block text-[10px] text-on-surface-variant font-data-mono">{truncatedAddress}</span>
                </div>
              </button>

              <a
                href={explorerAccount(address)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setIsOpen(false)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-container rounded-lg transition-colors group"
              >
                <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary">
                  open_in_new
                </span>
                <div className="text-left">
                  <span className="block text-sm font-bold text-on-surface">View on Stellar Expert</span>
                  <span className="block text-[10px] text-on-surface-variant uppercase">Account history</span>
                </div>
              </a>

              <div className="h-px bg-outline-variant my-2 mx-2"></div>

              <button
                onClick={() => {
                  setIsOpen(false);
                  void disconnect();
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-error-container text-on-surface hover:text-on-error-container rounded-lg transition-colors group"
              >
                <span className="material-symbols-outlined text-on-surface-variant group-hover:text-error">
                  logout
                </span>
                <div className="text-left">
                  <span className="block text-sm font-bold">Disconnect</span>
                  <span className="block text-[10px] opacity-70 uppercase">Log out of session</span>
                </div>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default WalletDropdown;
