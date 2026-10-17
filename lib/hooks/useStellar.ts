"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { useWallet } from "@/lib/contexts/WalletContext";
import { marketCore, reasoningRegistry, token, Outcomes, type OutcomeTag, type Signer } from "@/lib/stellar/clients";
import { describeError, UserFacingError, type ContractName } from "@/lib/stellar/errors";
import { collateralOutForShares, priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Market as OnChainMarket, Position } from "@/lib/stellar/generated/market-core";
import { fetchAndVerifyTrace, type TraceCheck } from "@/lib/stellar/trace";
import { maxIn, minOut } from "@/lib/stellar/units";
import { inspectTransactionAuthorization } from "@/lib/stellar/authorization";

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit: number) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};

const toId = (id: bigint | string | number) => BigInt(id);

/**
 * The value of a simulated call. Contract `Result`s are unwrapped; failures
 * become a UserFacingError named from the simulation's "Error(Contract, #N)".
 */
export function simulated<T>(tx: AssembledTransaction<unknown>, contract: ContractName = "marketCore"): T {
  const sim = tx.simulation as { error?: string } | undefined;
  let raw: unknown;
  try {
    raw = tx.result;
  } catch (err) {
    throw new UserFacingError(describeError(`${sim?.error ?? ""} ${String(err)}`, contract), err);
  }
  if (raw && typeof raw === "object" && "isOk" in raw && typeof (raw as { isOk: unknown }).isOk === "function") {
    const result = raw as { isOk(): boolean; unwrap(): T };
    if (!result.isOk()) throw new UserFacingError(describeError(`${sim?.error ?? ""}`, contract), raw);
    return result.unwrap();
  }
  return raw as T;
}

async function send<T>(tx: AssembledTransaction<unknown>, contract: ContractName = "marketCore"): Promise<{ value: T; txHash: string | null }> {
  // Surface simulation failures before asking the wallet to sign.
  simulated<T>(tx, contract);
  const authorization = inspectTransactionAuthorization(tx);
  if (!authorization.valid) {
    throw new UserFacingError({ kind: "contract", message: "The wallet authorization does not match this transaction." });
  }
  try {
    const sent = await tx.signAndSend();
    const value = sent.result as unknown;
    const unwrapped =
      value && typeof value === "object" && "unwrap" in value ? (value as { unwrap(): T }).unwrap() : (value as T);
    return { value: unwrapped, txHash: sent.sendTransactionResponse?.hash ?? null };
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(describeError(err, contract), err);
  }
}

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

function useInvalidateAfterTrade() {
  const queryClient = useQueryClient();
  return (marketId: string, holder: string) => {
    queryClient.invalidateQueries({ queryKey: stellarKeys.market(marketId) });
    queryClient.invalidateQueries({ queryKey: ["stellar", "markets"] });
    queryClient.invalidateQueries({ queryKey: stellarKeys.position(marketId, holder) });
    queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) });
  };
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
 */
export function useBuy() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  return useMutation({
    mutationFn: async ({ marketId, outcome, collateralIn, slippageBps }: BuyParams) => {
      const signer = guard();
      if (collateralIn <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
      const id = toId(marketId);
      const quote = simulated<bigint>(
        await marketCore().quote_buy({ market_id: id, outcome: Outcomes[outcome], collateral_in: collateralIn }),
      );
      const minSharesOut = minOut(quote, slippageBps);
      const tx = await marketCore(signer).buy({
        trader: signer.publicKey,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_in: collateralIn,
        min_shares_out: minSharesOut,
      });
      const { value, txHash } = await send<bigint>(tx);
      return { sharesOut: value, quotedShares: quote, minSharesOut, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export interface SellParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  /** Exact number of shares to sell. */
  shares: bigint;
  slippageBps: number;
}

/**
 * `sell` takes an exact collateral_out, not a share count. Per the contracts
 * repo's frontend-integration.md: read fresh reserves, compute
 * collateral_out for the share count with the contract's FPMM math, and cap
 * max_shares_in a little above the target.
 */
export function useSell() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  return useMutation({
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
      // +1 covers the off-chain estimate's rounding; slippage covers price moves.
      const maxSharesIn = maxIn(shares, slippageBps) + 1n;
      const tx = await marketCore(signer).sell({
        trader: signer.publicKey,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_out: collateralOut,
        max_shares_in: maxSharesIn,
      });
      const { value, txHash } = await send<bigint>(tx);
      return { sharesSold: value, collateralOut, maxSharesIn, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export function useRedeem() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  return useMutation({
    mutationFn: async ({ marketId }: { marketId: bigint | string }) => {
      const signer = guard();
      const tx = await marketCore(signer).redeem({ holder: signer.publicKey, market_id: toId(marketId) });
      const { value, txHash } = await send<bigint>(tx);
      return { payout: value, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

/** SEP-41 transfer on the USDC SAC, signed by the connected wallet. */
export function useUsdcTransfer() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ to, amount }: { to: string; amount: bigint }) => {
      const signer = guard();
      if (amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
      const tx = await token.transfer({ from: signer.publicKey, to, amount }, signer);
      const { txHash } = await send<null>(tx);
      if (!txHash) throw new UserFacingError({ kind: "unknown", message: "The payment was sent but no transaction hash came back." });
      return { txHash, holder: signer.publicKey };
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: stellarKeys.balance(d.holder) });
    },
  });
}
