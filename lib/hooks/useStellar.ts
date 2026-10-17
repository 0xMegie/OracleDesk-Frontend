"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { useWallet } from "@/lib/contexts/WalletContext";
import { marketCore, reasoningRegistry, token, Outcomes, rpcServer, type OutcomeTag, type Signer } from "@/lib/stellar/clients";
import { describeError, UserFacingError, type ContractName } from "@/lib/stellar/errors";
import { BPS, priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Market as OnChainMarket, Position } from "@/lib/stellar/generated/market-core";
import { fetchAndVerifyTrace, type TraceCheck } from "@/lib/stellar/trace";
import { maxIn, minOut } from "@/lib/stellar/units";
import { assertSigningDeadline, deadlineFor, type TransactionDeadline } from "@/lib/stellar/deadline";
import { getLedgerNow, useLedgerNow } from "@/lib/stellar/ledger-clock";
import { enableUsdcTrustline, getTrustlineState, usdcClassicAsset, type TrustlineState } from "@/lib/stellar/trustline";
import { minCollateralForShares } from "@/lib/stellar/quote";
import { reconcileWithQuote, solveSellForShares } from "@/lib/stellar/sell-solver";

export { useLedgerNow };

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit: number) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  trustline: (owner: string) => ["stellar", "usdcTrustline", owner] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  exactBuy: (id: string, outcome: OutcomeTag, target: string) => ["stellar", "exactBuy", id, outcome, target] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};

const toId = (id: bigint | string | number) => BigInt(id);

async function trustlineFor(address: string): Promise<TrustlineState> {
  return getTrustlineState(address, await usdcClassicAsset());
}

async function requireUsdcTrustline(address: string): Promise<TrustlineState> {
  const state = await trustlineFor(address);
  if (state.kind === "missing") {
    throw new UserFacingError({
      kind: "no-trustline",
      message: "Enable your USDC trustline before using USDC.",
      action: "enable-usdc",
    });
  }
  if (state.kind === "account-missing") {
    throw new UserFacingError({ kind: "unknown", message: "Your Stellar account is not funded yet. Fund it before continuing." });
  }
  if (state.kind === "present" && !state.authorized) {
    throw new UserFacingError({ kind: "no-trustline", message: "The issuer hasn't authorized your USDC trustline." });
  }
  return state;
}

function signerUntil(signer: Signer, deadline: TransactionDeadline): Signer {
  return {
    publicKey: signer.publicKey,
    signTransaction: async (xdr, options) => {
      const signed = await signer.signTransaction(xdr, options);
      try {
        assertSigningDeadline(deadline, getLedgerNow());
      } catch (error) {
        throw new UserFacingError(
          { kind: "contract", message: error instanceof Error ? error.message : "Signing took too long; try again." },
          error,
        );
      }
      return signed;
    },
  };
}

function writeDeadline(kind: "buy" | "sell" | "redeem" | "transfer", market?: OnChainMarket): TransactionDeadline {
  const now = getLedgerNow();
  try {
    return deadlineFor(kind, now, market?.close_time);
  } catch (error) {
    throw new UserFacingError(
      {
        kind: "contract",
        message: error instanceof Error ? error.message : "Stellar ledger time is unavailable.",
      },
      error,
    );
  }
}

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

export function useUsdcTrustline(owner: string | null | undefined) {
  const { isWrongNetwork } = useWallet();
  return useQuery({
    queryKey: stellarKeys.trustline(owner ?? ""),
    enabled: Boolean(owner) && !isWrongNetwork,
    queryFn: () => trustlineFor(owner as string),
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}

export function useEnableUsdc() {
  const signer = useWriteGuard();
  const queryClient = useQueryClient();
  useLedgerNow();
  return useMutation({
    mutationFn: async () => {
      const wallet = signer();
      const asset = await usdcClassicAsset();
      const current = await getTrustlineState(wallet.publicKey, asset);
      if (current.kind === "native" || (current.kind === "present" && current.authorized)) {
        return { hash: null, holder: wallet.publicKey };
      }
      if (current.kind === "present" && !current.authorized) {
        throw new UserFacingError({
          kind: "no-trustline",
          message: "The issuer hasn't authorized your USDC trustline.",
        });
      }
      const { hash } = await enableUsdcTrustline(wallet.publicKey, asset, wallet);
      const deadline = Date.now() + 60_000;
      let delay = 1_000;
      while (Date.now() < deadline) {
        const state = await getTrustlineState(wallet.publicKey, asset);
        if (state.kind === "present" && state.authorized) return { hash, holder: wallet.publicKey };
        if (state.kind === "present") {
          throw new UserFacingError({
            kind: "no-trustline",
            message: "The issuer hasn't authorized your USDC trustline.",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5_000);
      }
      throw new UserFacingError({
        kind: "network",
        message: "The trustline transaction confirmed, but the new trustline is not visible yet. Refresh and check again.",
      });
    },
    onSuccess: ({ holder }) => {
      void queryClient.invalidateQueries({ queryKey: stellarKeys.trustline(holder) });
      void queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) });
    },
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

export function useExactBuyQuote(
  id: bigint | string | null | undefined,
  outcome: OutcomeTag,
  targetShares: bigint | null,
) {
  return useQuery({
    queryKey: stellarKeys.exactBuy(String(id), outcome, targetShares?.toString() ?? ""),
    enabled: id !== null && id !== undefined && targetShares !== null && targetShares > 0n,
    queryFn: async () => {
      const view = await fetchOnChainMarket(id as string);
      const local = minCollateralForShares(view.market, outcome, targetShares as bigint);
      if (!local.ok) {
        const message =
          local.reason === "market-too-large"
            ? "This target exceeds the market's remaining size limit."
            : local.reason === "invalid-target"
              ? "Enter a share amount greater than zero."
              : "The requested share amount is too large.";
        throw new UserFacingError({ kind: "contract", message });
      }
      const quotedShares = simulated<bigint>(
        await marketCore().quote_buy({
          market_id: toId(id as string),
          outcome: Outcomes[outcome],
          collateral_in: local.collateralIn,
        }),
      );
      if (quotedShares < (targetShares as bigint)) {
        throw new UserFacingError({ kind: "contract", message: "The price moved; refresh the quote and try again." });
      }
      return { ...local, quotedShares, market: view.market };
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

function useInvalidateAfterTrade() {
  const queryClient = useQueryClient();
  return (marketId: string, holder: string) => {
    queryClient.invalidateQueries({ queryKey: stellarKeys.market(marketId) });
    queryClient.invalidateQueries({ queryKey: ["stellar", "markets"] });
    queryClient.invalidateQueries({ queryKey: stellarKeys.position(marketId, holder) });
    queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) });
  };
}

export type BuyParams = {
  marketId: bigint | string;
  outcome: OutcomeTag;
  slippageBps: number;
} & (
  | { collateralIn: bigint; mode?: "usdc" }
  | { mode: "shares"; targetShares: bigint; maxCollateralIn?: bigint }
);

/**
 * Re-quotes right before building the transaction and sets
 * min_shares_out = minOut(quote, slippageBps), so slippage is enforced
 * on-chain (SlippageExceeded otherwise).
 */
export function useBuy() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  useLedgerNow();
  return useMutation({
    mutationFn: async (params: BuyParams) => {
      const { marketId, outcome, slippageBps } = params;
      const signer = guard();
      await requireUsdcTrustline(signer.publicKey);
      const id = toId(marketId);
      let collateralIn: bigint;
      let quote: bigint;
      let targetShares: bigint | undefined;
      let market: OnChainMarket;

      if (params.mode === "shares") {
        if (params.targetShares <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter a share amount greater than zero." });
        targetShares = params.targetShares;
        let solved = false;
        let lastQuote = 0n;
        market = (await fetchOnChainMarket(id)).market;
        for (let attempt = 0; attempt < 2; attempt++) {
          const exact = minCollateralForShares(market, outcome, targetShares);
          if (!exact.ok) {
            const message =
              exact.reason === "market-too-large"
                ? "This target exceeds the market's remaining size limit."
                : exact.reason === "invalid-target"
                  ? "Enter a share amount greater than zero."
                  : "The requested share amount is too large.";
            throw new UserFacingError({ kind: "contract", message });
          }
          collateralIn = exact.collateralIn;
          if (params.maxCollateralIn !== undefined && collateralIn > maxIn(params.maxCollateralIn, slippageBps)) {
            throw new UserFacingError({
              kind: "contract",
              message: "The cost moved beyond your slippage limit. Review the new quote before buying.",
            });
          }
          lastQuote = simulated<bigint>(
            await marketCore().quote_buy({ market_id: id, outcome: Outcomes[outcome], collateral_in: collateralIn }),
          );
          if (lastQuote >= targetShares) {
            solved = true;
            break;
          }
          if (attempt === 0) market = (await fetchOnChainMarket(id)).market;
        }
        if (!solved) throw new UserFacingError({ kind: "contract", message: "The price moved; review the new cost and try again." });
        quote = lastQuote;
      } else {
        collateralIn = params.collateralIn;
        if (collateralIn <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
        market = (await fetchOnChainMarket(id)).market;
        quote = simulated<bigint>(
          await marketCore().quote_buy({ market_id: id, outcome: Outcomes[outcome], collateral_in: collateralIn }),
        );
      }

      const deadline = writeDeadline("buy", market);
      const minSharesOut = minOut(targetShares ?? quote, slippageBps);
      const tx = await marketCore(signerUntil(signer, deadline)).buy({
        trader: signer.publicKey,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_in: collateralIn,
        min_shares_out: minSharesOut,
      }, { timeoutInSeconds: deadline.timeoutInSeconds });
      const { value, txHash } = await send<bigint>(tx);
      return { sharesOut: value, quotedShares: quote, minSharesOut, targetShares, collateralIn, txHash, holder: signer.publicKey };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export type SellParams = {
  marketId: bigint | string;
  outcome: OutcomeTag;
  slippageBps: number;
} & (
  | { mode: "all"; shares?: never }
  | { mode?: "exact-shares"; shares: bigint }
);

/**
 * `sell` takes collateral_out rather than shares. The local solver searches
 * using the contract's exact ceiling-rounded math; quote_sell confirms the
 * required shares before submission. The slippage bound is capped at the
 * wallet's held position, so "sell all" can never authorize spending shares
 * the account does not own.
 */
export function useSell() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  useLedgerNow();
  return useMutation({
    mutationFn: async ({ marketId, outcome, slippageBps, ...params }: SellParams) => {
      const signer = guard();
      await requireUsdcTrustline(signer.publicKey);
      const id = toId(marketId);
      let { market } = await fetchOnChainMarket(id);
      const position = simulated<Position>(
        await marketCore().get_position({ market_id: id, holder: signer.publicKey }),
      );
      const heldShares = outcome === "Yes" ? position.yes : position.no;
      const shares = params.mode === "all" ? heldShares : params.shares;
      if (shares <= 0n) {
        throw new UserFacingError({ kind: "contract", code: "InvalidAmount", message: "Enter a share amount greater than zero." });
      }
      if (shares > heldShares) {
        throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
      }
      const [rSold, rOther] = outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
      const feeBps = BigInt(market.fee_bps);
      let local = solveSellForShares(rSold, rOther, shares, feeBps);
      if ("error" in local) {
        throw new UserFacingError({
          kind: "contract",
          code: local.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
          message: local.error === "too-small"
            ? "That's too few shares to sell after fees."
            : "There isn't enough liquidity to sell that many shares.",
        });
      }

      const quoteAt = async (collateralOut: bigint) =>
        simulated<bigint>(
          await marketCore().quote_sell({ market_id: id, outcome: Outcomes[outcome], collateral_out: collateralOut }),
        );
      let confirmed = await reconcileWithQuote(local, quoteAt);
      if (confirmed.sharesIn !== local.sharesIn) {
        market = (await fetchOnChainMarket(id)).market;
        const [freshSold, freshOther] =
          outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
        const refreshed = solveSellForShares(freshSold, freshOther, shares, BigInt(market.fee_bps));
        if ("error" in refreshed) {
          throw new UserFacingError({
            kind: "contract",
            code: refreshed.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
            message: refreshed.error === "too-small"
              ? "That's too few shares to sell after fees."
              : "There isn't enough liquidity to sell that many shares.",
          });
        }
        local = refreshed;
        confirmed = await reconcileWithQuote(local, quoteAt);
        if (confirmed.sharesIn !== local.sharesIn) {
          const maxOut = ((freshOther - 1n) * (BPS - BigInt(market.fee_bps))) / BPS;
          let low = 0n;
          let high = maxOut + 1n;
          let lowQuote = 0n;
          let probes = 0;
          let pivot = confirmed.collateralOut;
          let pivotQuote = confirmed.sharesIn;
          if (pivotQuote <= shares) {
            low = pivot;
            lowQuote = pivotQuote;
          } else {
            high = pivot;
          }

          let step = 1n;
          while ((low === 0n || high === maxOut + 1n) && probes < 4) {
            probes++;
            if (low === 0n) {
              pivot = high > maxOut ? maxOut : high;
              const candidate = pivot > step ? pivot - step : 1n;
              pivotQuote = await quoteAt(candidate);
              if (pivotQuote <= shares) {
                low = candidate;
                lowQuote = pivotQuote;
              } else high = candidate;
            } else {
              const candidate = low + step;
              if (candidate > maxOut) break;
              pivotQuote = await quoteAt(candidate);
              if (pivotQuote > shares) high = candidate;
              else {
                low = candidate;
                lowQuote = pivotQuote;
              }
            }
            step *= 2n;
          }
          while (high - low > 1n && probes < 8) {
            probes++;
            const mid = (low + high) / 2n;
            const midQuote = await quoteAt(mid);
            if (midQuote <= shares) {
              low = mid;
              lowQuote = midQuote;
            } else high = mid;
          }
          if (low === 0n || high - low > 1n) {
            throw new UserFacingError({
              kind: "network",
              message: "The market changed while preparing your sale. Refresh the quote and try again.",
            });
          }
          confirmed = { collateralOut: low, sharesIn: lowQuote, dust: shares - lowQuote, iterations: probes };
        }
      }

      if (confirmed.sharesIn > shares) {
        throw new UserFacingError({ kind: "contract", code: "InsufficientShares", message: "You don't have enough shares for this sale." });
      }
      const deadline = writeDeadline("sell", market);
      const maxSharesIn = [maxIn(confirmed.sharesIn, slippageBps), heldShares].reduce((a, b) => a < b ? a : b);
      const tx = await marketCore(signerUntil(signer, deadline)).sell({
        trader: signer.publicKey,
        market_id: id,
        outcome: Outcomes[outcome],
        collateral_out: confirmed.collateralOut,
        max_shares_in: maxSharesIn,
      }, { timeoutInSeconds: deadline.timeoutInSeconds });
      const { value, txHash } = await send<bigint>(tx);
      return {
        sharesSold: value,
        sharesQuoted: confirmed.sharesIn,
        dust: confirmed.dust,
        collateralOut: confirmed.collateralOut,
        maxSharesIn,
        txHash,
        holder: signer.publicKey,
      };
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export function useRedeem() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  useLedgerNow();
  return useMutation({
    mutationFn: async ({ marketId }: { marketId: bigint | string }) => {
      const signer = guard();
      await requireUsdcTrustline(signer.publicKey);
      const deadline = writeDeadline("redeem");
      const tx = await marketCore(signerUntil(signer, deadline)).redeem(
        { holder: signer.publicKey, market_id: toId(marketId) },
        { timeoutInSeconds: deadline.timeoutInSeconds },
      );
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
  useLedgerNow();
  return useMutation({
    mutationFn: async ({ to, amount }: { to: string; amount: bigint }) => {
      const signer = guard();
      if (amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
      await requireUsdcTrustline(signer.publicKey);
      const deadline = writeDeadline("transfer");
      const tx = await token.transfer({ from: signer.publicKey, to, amount }, signerUntil(signer, deadline), undefined, {
        timeoutInSeconds: deadline.timeoutInSeconds,
      });
      const { txHash } = await send<null>(tx);
      if (!txHash) throw new UserFacingError({ kind: "unknown", message: "The payment was sent but no transaction hash came back." });
      return { txHash, holder: signer.publicKey };
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: stellarKeys.balance(d.holder) });
    },
  });
}
