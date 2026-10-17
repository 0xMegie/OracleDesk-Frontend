"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { useWallet } from "@/lib/contexts/WalletContext";
import { marketCore, reasoningRegistry, token, Outcomes, rpcServer, type OutcomeTag, type Signer } from "@/lib/stellar/clients";
import { UserFacingError, type ContractName } from "@/lib/stellar/errors";
import { collateralOutForShares, priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Market as OnChainMarket, Position } from "@/lib/stellar/generated/market-core";
import { fetchAndVerifyTrace, type TraceCheck } from "@/lib/stellar/trace";
import { maxIn, minOut } from "@/lib/stellar/units";
import {
  feeBreakdown,
  fetchBaseReserve,
  spendableXlm,
  type AccountReserve,
  type FeeBreakdown,
} from "@/lib/stellar/fees";
import {
  simulated,
  TxLifecycle,
  type TxPhase,
} from "@/lib/stellar/tx-lifecycle";
import { useTxTracker } from "@/lib/stellar/tx-tracker";
import { tradeInvalidationKeys } from "@/lib/stellar/tx-tracker-core";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";

export { simulated };
export { tradeInvalidationKeys };

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit = 20) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  account: (addr: string) => ["stellar", "account", addr] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};

const toId = (id: bigint | string | number) => BigInt(id);

// ─── Reads ──────────────────────────────────────────────────────────────────

export function useMarketCount() {
  return useQuery({
    queryKey: stellarKeys.marketCount,
    queryFn: async () => simulated<bigint>(await marketCore().market_count()),
    staleTime: 30_000,
  });
}

export interface OnChainMarketView {
  id: string;
  market: OnChainMarket;
  /** YES price in bps, from the contract's own FPMM math. */
  yesBps: number;
}

export async function fetchOnChainMarket(id: bigint | string): Promise<OnChainMarketView> {
  const market = simulated<OnChainMarket>(await marketCore().get_market({ market_id: toId(id) }));
  return { id: String(id), market, yesBps: Number(priceYesBps(market.reserve_yes, market.reserve_no)) };
}

export function useOnChainMarket(id: bigint | string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.market(String(id)),
    queryFn: () => fetchOnChainMarket(id as string),
    enabled: id !== null && id !== undefined && id !== "",
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/**
 * Newest first: ids count-1 … count-limit. One RPC read per market; an
 * indexer-backed endpoint should replace this (backlog).
 */
export function useOnChainMarkets(limit = 20) {
  const count = useMarketCount();
  const total = count.data;
  return useQuery({
    queryKey: [...stellarKeys.markets(limit), total?.toString() ?? "?"],
    enabled: total !== undefined,
    queryFn: async () => {
      const ids: bigint[] = [];
      for (let i = (total as bigint) - 1n; i >= 0n && ids.length < limit; i--) ids.push(i);
      const settled = await Promise.allSettled(ids.map((id) => fetchOnChainMarket(id)));
      return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    },
    staleTime: 30_000,
  });
}

export function usePosition(id: bigint | string | null | undefined, holder: string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.position(String(id), holder ?? ""),
    enabled: id !== null && id !== undefined && Boolean(holder),
    queryFn: async () =>
      simulated<Position>(await marketCore().get_position({ market_id: toId(id as string), holder: holder as string })),
    staleTime: 15_000,
  });
}

export function useUsdcBalance(owner: string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.balance(owner ?? ""),
    enabled: Boolean(owner),
    queryFn: async () => simulated<bigint>(await token.balance(owner as string)),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export interface AccountReserveState extends AccountReserve {
  funded: boolean;
}

/** Reads account entry via getLedgerEntries on the account key. */
export function useAccountReserve(address: string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.account(address ?? ""),
    enabled: Boolean(address),
    queryFn: async (): Promise<AccountReserveState> => {
      if (!address) {
        return {
          funded: false,
          balance: 0n,
          minBalance: 0n,
          sellingLiabilities: 0n,
          spendable: 0n,
          subentries: 0,
          sponsoring: 0,
          sponsored: 0,
        };
      }
      try {
        const kp = Keypair.fromPublicKey(address);
        const key = xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({
            accountId: kp.xdrPublicKey(),
          }),
        );
        const res = await rpcServer().getLedgerEntries(key);
        if (!res.entries || res.entries.length === 0) {
          return {
            funded: false,
            balance: 0n,
            minBalance: 0n,
            sellingLiabilities: 0n,
            spendable: 0n,
            subentries: 0,
            sponsoring: 0,
            sponsored: 0,
          };
        }

        let accountEntry: xdr.AccountEntry | null = null;
        const raw = res.entries[0] as unknown as { val?: xdr.LedgerEntryData; xdr?: string };
        if (raw.val && typeof raw.val.account === "function") {
          accountEntry = raw.val.account();
        } else if (typeof raw.xdr === "string") {
          const ledgerEntryData = xdr.LedgerEntryData.fromXDR(raw.xdr, "base64");
          accountEntry = ledgerEntryData.account();
        }

        if (!accountEntry) {
          return {
            funded: false,
            balance: 0n,
            minBalance: 0n,
            sellingLiabilities: 0n,
            spendable: 0n,
            subentries: 0,
            sponsoring: 0,
            sponsored: 0,
          };
        }

        const baseReserve = await fetchBaseReserve();
        const reserve = spendableXlm(accountEntry, baseReserve);
        return {
          funded: true,
          ...reserve,
        };
      } catch (err) {
        // Fall back gracefully if account fetch fails
        throw err;
      }
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** Shares a buy would return right now. Debounce `collateralIn` at the call site. */
export function useQuoteBuy(id: bigint | string | null | undefined, outcome: OutcomeTag, collateralIn: bigint | null) {
  return useQuery({
    queryKey: stellarKeys.quoteBuy(String(id), outcome, collateralIn?.toString() ?? ""),
    enabled: id !== null && id !== undefined && collateralIn !== null && collateralIn > 0n,
    queryFn: async () =>
      simulated<bigint>(
        await marketCore().quote_buy({ market_id: toId(id as string), outcome: Outcomes[outcome], collateral_in: collateralIn as bigint }),
      ),
    staleTime: 5_000,
  });
}

export interface PreparedBuy {
  tx: AssembledTransaction<unknown>;
  fees: FeeBreakdown;
  quote: bigint;
  minSharesOut: bigint;
  preparedAt: number;
}

/** Pre-builds and simulates a buy transaction to preview fees and min shares. */
export function usePrepareBuy(params: {
  marketId: bigint | string | null | undefined;
  outcome: OutcomeTag;
  collateralIn: bigint | null;
  slippageBps: number;
  holder: string | null | undefined;
}) {
  const { marketId, outcome, collateralIn, slippageBps, holder } = params;
  return useQuery({
    queryKey: [
      "stellar",
      "prepareBuy",
      marketId?.toString() ?? "",
      outcome,
      collateralIn?.toString() ?? "",
      slippageBps,
      holder ?? "",
    ] as const,
    enabled: Boolean(marketId) && Boolean(holder) && collateralIn !== null && collateralIn > 0n,
    queryFn: async (): Promise<PreparedBuy> => {
      const id = toId(marketId!);
      const quote = simulated<bigint>(
        await marketCore().quote_buy({
          market_id: id,
          outcome: Outcomes[outcome],
          collateral_in: collateralIn!,
        }),
      );
      const minSharesOut = minOut(quote, slippageBps);
      const dummySigner: Signer = {
        publicKey: holder!,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
      };
      const tx = await marketCore(dummySigner).buy({
        trader: holder!,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_in: collateralIn!,
        min_shares_out: minSharesOut,
      });
      const fees = feeBreakdown(tx);
      return {
        tx,
        fees,
        quote,
        minSharesOut,
        preparedAt: Date.now(),
      };
    },
    staleTime: 5_000,
  });
}

export interface PreparedUsdcTransfer {
  tx: AssembledTransaction<null>;
  fees: FeeBreakdown;
  amount: bigint;
  preparedAt: number;
}

/** Pre-builds and simulates a SAC transfer to preview network fees. */
export function usePrepareUsdcTransfer(params: {
  to: string | null | undefined;
  amount: bigint | null;
  holder: string | null | undefined;
}) {
  const { to, amount, holder } = params;
  return useQuery({
    queryKey: [
      "stellar",
      "prepareUsdcTransfer",
      to ?? "",
      amount?.toString() ?? "",
      holder ?? "",
    ] as const,
    enabled: Boolean(to) && Boolean(holder) && amount !== null && amount > 0n,
    queryFn: async (): Promise<PreparedUsdcTransfer> => {
      const dummySigner: Signer = {
        publicKey: holder!,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
      };
      const tx = await token.transfer({ from: holder!, to: to!, amount: amount! }, dummySigner);
      const fees = feeBreakdown(tx);
      return {
        tx,
        fees,
        amount: amount!,
        preparedAt: Date.now(),
      };
    },
    staleTime: 5_000,
  });
}

export interface VerifiedTrace {
  onChainTraceId: string;
  marketId: string;
  agent: string;
  action: string;
  ipfsCid: string;
  onChainHash: string;
  publishedAt: number;
  check: TraceCheck;
}

/** Reads the trace from reasoning-registry, then fetches and hash-checks its content. */
export function useVerifiedTrace(onChainTraceId: bigint | string | null | undefined) {
  return useQuery({
    queryKey: stellarKeys.trace(String(onChainTraceId)),
    enabled: onChainTraceId !== null && onChainTraceId !== undefined && onChainTraceId !== "",
    queryFn: async (): Promise<VerifiedTrace> => {
      const trace = simulated<{
        market_id: bigint;
        agent: string;
        action: string;
        trace_hash: Uint8Array;
        ipfs_cid: string;
        published_at: bigint;
      }>(await reasoningRegistry().get_trace({ trace_id: toId(onChainTraceId as string) }), "reasoningRegistry");
      const onChainHash = Array.from(trace.trace_hash, (b) => b.toString(16).padStart(2, "0")).join("");
      return {
        onChainTraceId: String(onChainTraceId),
        marketId: trace.market_id.toString(),
        agent: trace.agent,
        action: trace.action,
        ipfsCid: trace.ipfs_cid,
        onChainHash,
        publishedAt: Number(trace.published_at),
        check: await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash),
      };
    },
    staleTime: 5 * 60_000,
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

function useWriteGuard(): () => Signer {
  const { signer, isWrongNetwork } = useWallet();
  return () => {
    if (!signer) {
      throw new UserFacingError({ kind: "disconnected", message: "Connect your wallet first." });
    }
    if (isWrongNetwork) {
      throw new UserFacingError({ kind: "wrong-network", message: "Switch your wallet to Stellar Testnet and try again." });
    }
    return signer;
  };
}

export function useInvalidateAfterTrade() {
  const queryClient = useQueryClient();
  return (marketId: string, holder: string) => {
    for (const key of tradeInvalidationKeys(marketId, holder)) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function useTxRunner(contract: ContractName) {
  const ref = useRef<TxLifecycle<unknown> | null>(null);
  const phase = useSyncExternalStore(
    useCallback((cb: () => void) => ref.current?.subscribe(cb) ?? (() => {}), []),
    useCallback(() => ref.current?.getSnapshot() ?? ({ name: "building" } as TxPhase), []),
    useCallback(() => ({ name: "building" } as TxPhase), []),
  );

  const start = useCallback(
    <T, R = T>(
      tx: AssembledTransaction<T>,
      parse: (v: xdr.ScVal | undefined) => R,
      onHash?: (hash: string) => void,
    ): Promise<{ value: R; txHash: string }> => {
      const runner = new TxLifecycle<R>({
        server: rpcServer(),
        contract,
        onHash,
      });
      ref.current = runner as TxLifecycle<unknown>;
      return runner.run(tx as unknown as AssembledTransaction<R>, parse);
    },
    [contract],
  );

  return { phase, start };
}

export interface BuyParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  collateralIn: bigint;
  slippageBps: number;
}

/**
 * Re-quotes right before building the transaction and sets
 * min_shares_out = minOut(quote, slippageBps), so slippage is enforced
 * on-chain (SlippageExceeded otherwise).
 *
 * Unmount safety: The underlying TxLifecycle runner keeps polling if the component
 * unmounts so React Query's mutation promise resolves and onSuccess cache invalidations
 * complete reliably.
 */
export function useBuy() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    mutationFn: async ({
      marketId,
      outcome,
      collateralIn,
      slippageBps,
      prepared,
    }: BuyParams & { prepared?: PreparedBuy }) => {
      const signer = guard();
      if (collateralIn <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
      const id = toId(marketId);

      let tx: AssembledTransaction<unknown>;
      let quote: bigint;
      let minSharesOut: bigint;

      const isFresh = prepared && Date.now() - prepared.preparedAt < 15_000;
      if (isFresh && prepared) {
        tx = prepared.tx;
        quote = prepared.quote;
        minSharesOut = prepared.minSharesOut;
      } else {
        quote = simulated<bigint>(
          await marketCore().quote_buy({ market_id: id, outcome: Outcomes[outcome], collateral_in: collateralIn }),
        );
        minSharesOut = minOut(quote, slippageBps);
        tx = await marketCore(signer).buy({
          trader: signer.publicKey,
          market_id: id,
          outcome: Outcomes[outcome],
          collateral_in: collateralIn,
          min_shares_out: minSharesOut,
        });
      }

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "buy",
          holder: signer.publicKey,
          marketId: String(marketId),
          outcome,
          amounts: { collateralIn: collateralIn.toString(), minSharesOut: minSharesOut.toString() },
          networkPassphrase: NETWORK_PASSPHRASE,
        });
      };

      const parse = (val: xdr.ScVal | undefined) => {
        return (val ? scValToNative(val) : quote) as bigint;
      };

      const { value, txHash } = await runner.start(tx, parse, onHash);
      return { sharesOut: value, quotedShares: quote, minSharesOut, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export interface SellParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  /** Exact number of shares to sell. */
  shares: bigint;
  slippageBps: number;
}

export function useSell() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    mutationFn: async ({ marketId, outcome, shares, slippageBps }: SellParams) => {
      const signer = guard();
      const id = toId(marketId);
      const { market } = await fetchOnChainMarket(id);
      const [rSold, rOther] = outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
      let collateralOut: bigint;
      try {
        collateralOut = collateralOutForShares(rSold, rOther, shares, BigInt(market.fee_bps));
      } catch {
        throw new UserFacingError({ kind: "contract", message: "There isn't enough liquidity to sell that many shares." });
      }
      const maxSharesIn = maxIn(shares, slippageBps) + 1n;
      const tx = await marketCore(signer).sell({
        trader: signer.publicKey,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_out: collateralOut,
        max_shares_in: maxSharesIn,
      });

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "sell",
          holder: signer.publicKey,
          marketId: String(marketId),
          outcome,
          amounts: { shares: shares.toString(), maxSharesIn: maxSharesIn.toString() },
          networkPassphrase: NETWORK_PASSPHRASE,
        });
      };

      const parse = (val: xdr.ScVal | undefined) => {
        return (val ? scValToNative(val) : shares) as bigint;
      };

      const { value, txHash } = await runner.start(tx, parse, onHash);
      return { sharesSold: value, collateralOut, maxSharesIn, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export function useRedeem() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    mutationFn: async ({ marketId }: { marketId: bigint | string }) => {
      const signer = guard();
      const tx = await marketCore(signer).redeem({ holder: signer.publicKey, market_id: toId(marketId) });

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "redeem",
          holder: signer.publicKey,
          marketId: String(marketId),
          amounts: {},
          networkPassphrase: NETWORK_PASSPHRASE,
        });
      };

      const parse = (val: xdr.ScVal | undefined) => {
        return (val ? scValToNative(val) : 0n) as bigint;
      };

      const { value, txHash } = await runner.start(tx, parse, onHash);
      return { payout: value, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}

export interface UsdcTransferParams {
  to: string;
  amount: bigint;
  followUp?: { type: "unlock-daily-pass"; traceId: string; amountRaw: string };
  prepared?: PreparedUsdcTransfer;
}

/** SEP-41 transfer on the USDC SAC, signed by the connected wallet. */
export function useUsdcTransfer() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const runner = useTxRunner("marketCore");
  const tracker = useTxTracker();

  const mutation = useMutation({
    mutationFn: async ({ to, amount, followUp, prepared }: UsdcTransferParams) => {
      const signer = guard();
      if (amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });

      const isFresh = prepared && Date.now() - prepared.preparedAt < 15_000;
      const tx = isFresh && prepared
        ? (prepared.tx as unknown as AssembledTransaction<null>)
        : await token.transfer({ from: signer.publicKey, to, amount }, signer);

      const onHash = (hash: string) => {
        tracker.track({
          hash,
          kind: "usdc-transfer",
          holder: signer.publicKey,
          amounts: { amount: amount.toString() },
          networkPassphrase: NETWORK_PASSPHRASE,
          followUp,
        });
      };

      const parse = () => null;

      const { txHash } = await runner.start<null>(tx, parse, onHash);
      if (!txHash) throw new UserFacingError({ kind: "unknown", message: "The payment was sent but no transaction hash came back." });
      return { txHash, holder: signer.publicKey };
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: stellarKeys.balance(d.holder) });
    },
  });

  return {
    ...mutation,
    phase: runner.phase,
  };
}
