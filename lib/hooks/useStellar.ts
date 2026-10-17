"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { useWallet } from "@/lib/contexts/WalletContext";
import { marketCore, reasoningRegistry, token, Outcomes, type OutcomeTag, type Signer } from "@/lib/stellar/clients";
import { CONTRACTS, RPC_URL } from "@/lib/stellar/config";
import { describeError, UserFacingError, type ContractName } from "@/lib/stellar/errors";
import { collateralOutForShares, priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Config, Market as OnChainMarket, Position } from "@/lib/stellar/generated/market-core";
import { fetchAndVerifyTrace, type TraceCheck } from "@/lib/stellar/trace";
import { maxIn, minOut } from "@/lib/stellar/units";
import { preflightBuy, preflightRedeem, preflightSell, type Preflight, type PreflightFailure, type PreflightInput } from "@/lib/stellar/preflight";
import { getSubmitQueue } from "@/lib/stellar/submit-queue";
import { assertIntentMatches, describeAssembled, type ReviewModel } from "@/lib/stellar/tx-decode";
import {
  discoverRedeemable,
  loadRedeemAllResume,
  saveRedeemAllResume,
  type ItemState,
  type RedeemAllResume,
  type RedeemDiscovery,
} from "@/lib/stellar/redeem-all";

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  config: ["stellar", "config"] as const,
  ledgerNow: ["stellar", "ledgerNow"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit: number) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};

const toId = (id: bigint | string | number) => BigInt(id);
const rpcServer = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

async function fetchLedgerNow(): Promise<bigint> {
  const latest = await rpcServer.getLatestLedger();
  const response = await rpcServer.getTransactions({
    startLedger: latest.sequence,
    pagination: { limit: 1 },
  });
  return BigInt(response.latestLedgerCloseTimestamp);
}

async function fetchMarketConfig(): Promise<Config> {
  return simulated<Config>(await marketCore().get_config());
}

async function fetchUsdcBalanceIfAvailable(owner: string): Promise<bigint | undefined> {
  try {
    return simulated<bigint>(await token.balance(owner));
  } catch (error) {
    if (describeError(error).kind === "no-trustline") return undefined;
    throw error;
  }
}

function throwPreflight(preflight: Preflight): void {
  if (preflight.ok !== false) return;
  const first = preflight.failures[0] as PreflightFailure;
  throw new UserFacingError({
    kind: first.code === "InsufficientBalance" ? "insufficient-balance" : "contract",
    code: first.code,
    message: first.message,
  });
}

function queueId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function assertSignerCurrent(guard: () => Signer, expectedAddress: string): Signer {
  const current = guard();
  if (current.publicKey !== expectedAddress) {
    throw new UserFacingError({ kind: "disconnected", message: "Your wallet changed before this transaction could be signed." });
  }
  return current;
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

export function useMarketConfig() {
  return useQuery({
    queryKey: stellarKeys.config,
    queryFn: fetchMarketConfig,
    staleTime: 60_000,
  });
}

export function useLedgerNow() {
  return useQuery({
    queryKey: stellarKeys.ledgerNow,
    queryFn: fetchLedgerNow,
    staleTime: 5_000,
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
  confirmBoundsChanged?: (previous: bigint, next: bigint) => Promise<boolean>;
  review?: PreparedWriteReview;
}

export interface PreparedWrite {
  tx: AssembledTransaction<unknown>;
  kind: "buy" | "sell" | "redeem" | "usdc-transfer";
  contract: ContractName | "usdc";
  derived: Record<string, { value: bigint; from: string }>;
  intent: Record<string, string>;
  builtAt: number;
  quote?: bigint;
}

export type PreparedWriteReview = (
  prepared: PreparedWrite,
  model: ReviewModel,
  changedFrom?: ReviewModel,
  forceReview?: boolean,
) => Promise<boolean>;

export async function prepareBuy(signer: Signer, params: Omit<BuyParams, "confirmBoundsChanged">): Promise<PreparedWrite> {
  const id = toId(params.marketId);
  const quote = simulated<bigint>(
    await marketCore().quote_buy({ market_id: id, outcome: Outcomes[params.outcome], collateral_in: params.collateralIn }),
  );
  const minSharesOut = minOut(quote, params.slippageBps);
  const tx = await marketCore(signer).buy({
    trader: signer.publicKey,
    market_id: id,
    outcome: Outcomes[params.outcome],
    collateral_in: params.collateralIn,
    min_shares_out: minSharesOut,
  });
  simulated<bigint>(tx);
  return {
    tx,
    kind: "buy",
    contract: "marketCore",
    derived: { min_shares_out: { value: minSharesOut, from: `quote ${quote.toString()} shares, ${params.slippageBps / 100}% slippage` } },
    intent: {
      trader: signer.publicKey,
      market_id: id.toString(),
      outcome: params.outcome,
      collateral_in: params.collateralIn.toString(),
      min_shares_out: minSharesOut.toString(),
    },
    builtAt: Date.now(),
    quote,
  };
}

export async function prepareSell(
  signer: Signer,
  params: { marketId: bigint | string; outcome: OutcomeTag; collateralOut: bigint; maxSharesIn: bigint },
): Promise<PreparedWrite> {
  const id = toId(params.marketId);
  const tx = await marketCore(signer).sell({
    trader: signer.publicKey,
    market_id: id,
    outcome: Outcomes[params.outcome],
    collateral_out: params.collateralOut,
    max_shares_in: params.maxSharesIn,
  });
  simulated<bigint>(tx);
  return {
    tx,
    kind: "sell",
    contract: "marketCore",
    derived: { max_shares_in: { value: params.maxSharesIn, from: "quote and slippage limit" } },
    intent: {
      trader: signer.publicKey,
      market_id: id.toString(),
      outcome: params.outcome,
      collateral_out: params.collateralOut.toString(),
      max_shares_in: params.maxSharesIn.toString(),
    },
    builtAt: Date.now(),
  };
}

export async function prepareRedeem(signer: Signer, marketId: bigint | string): Promise<PreparedWrite> {
  const id = toId(marketId);
  const tx = await marketCore(signer).redeem({ holder: signer.publicKey, market_id: id });
  simulated<bigint>(tx);
  return {
    tx,
    kind: "redeem",
    contract: "marketCore",
    derived: {},
    intent: { holder: signer.publicKey, market_id: id.toString() },
    builtAt: Date.now(),
  };
}

export async function redeemOnce(
  signer: Signer,
  marketId: bigint | string,
  onSubmitting?: () => void,
  review?: PreparedWriteReview,
  attempt: 0 | 1 = 0,
): Promise<{ payout: bigint; txHash: string | null; holder: string }> {
  const id = toId(marketId);
  const view = await fetchOnChainMarket(id);
  const position = simulated<Position>(await marketCore().get_position({ market_id: id, holder: signer.publicKey }));
  throwPreflight(preflightRedeem({ market: view.market, position }));
  const initial = await prepareRedeem(signer, id);
  const reviewed = await reviewPreparedWrite(initial, review, () => prepareRedeem(signer, id), undefined, attempt === 1);
  const prepared = reviewed.prepared;
  onSubmitting?.();
  const { value, txHash } = await submitPrepared<bigint>(prepared);
  return { payout: value, txHash, holder: signer.publicKey };
}

export async function prepareUsdcTransfer(
  signer: Signer,
  params: { to: string; amount: bigint },
): Promise<PreparedWrite> {
  const tx = await token.transfer({ from: signer.publicKey, to: params.to, amount: params.amount }, signer);
  simulated<null>(tx, "marketCore");
  return {
    tx,
    kind: "usdc-transfer",
    contract: "usdc",
    derived: {},
    intent: { from: signer.publicKey, to: params.to, amount: params.amount.toString() },
    builtAt: Date.now(),
  };
}

export async function submitPrepared<T>(
  prepared: PreparedWrite,
): Promise<{ value: T; txHash: string | null }> {
  return send<T>(prepared.tx, prepared.contract === "usdc" ? "marketCore" : prepared.contract);
}

async function reviewPreparedWrite(
  initial: PreparedWrite,
  review: PreparedWriteReview | undefined,
  rebuild: () => Promise<PreparedWrite>,
  changedFrom?: ReviewModel,
  forceInitialReview = false,
): Promise<{ prepared: PreparedWrite; model?: ReviewModel }> {
  if (!review) return { prepared: initial };

  let current = initial;
  let previousModel = changedFrom;
  let forceReview = forceInitialReview || changedFrom !== undefined;
  while (true) {
    const model = describeAssembled(current.tx, current.contract === "usdc" ? "sac" : marketCore().spec, current.derived);
    assertPreparedInvocation(current, model);
    assertIntentMatches(model, current.intent);
    if (!(await review(current, model, previousModel, forceReview))) {
      throw new UserFacingError({ kind: "rejected", message: "You cancelled the transaction review." });
    }
    if (Date.now() - current.builtAt <= 20_000) return { prepared: current, model };

    const beforeRefresh = model;
    const refreshed = await rebuild();
    const freshModel = describeAssembled(
      refreshed.tx,
      refreshed.contract === "usdc" ? "sac" : marketCore().spec,
      refreshed.derived,
    );
    assertPreparedInvocation(refreshed, freshModel);
    assertIntentMatches(freshModel, refreshed.intent);
    current = refreshed;
    previousModel = beforeRefresh;
    forceReview = true;
  }
}

function assertPreparedInvocation(prepared: PreparedWrite, model: ReviewModel): void {
  const expectedContract = prepared.contract === "usdc" ? CONTRACTS.usdc : CONTRACTS[prepared.contract];
  const expectedFunction = {
    buy: "buy",
    sell: "sell",
    redeem: "redeem",
    "usdc-transfer": "transfer",
  }[prepared.kind];
  if (model.contractId !== expectedContract || model.fn !== expectedFunction) {
    throw new Error("The assembled transaction does not match the requested contract action.");
  }
}

function dedupeValue(...values: (string | number | bigint)[]): string {
  return values.map(String).join(":");
}

function runQueuedWrite<T>(
  signer: Signer,
  label: string,
  dedupeKey: string,
  guard: () => Signer,
  run: (attempt: 0 | 1) => Promise<T>,
): Promise<T> {
  return getSubmitQueue().enqueue({
    id: queueId(),
    address: signer.publicKey,
    label,
    dedupeKey,
    run: async ({ attempt, signal }) => {
      if (signal.aborted) throw new DOMException("The queued transaction was cancelled.", "AbortError");
      assertSignerCurrent(guard, signer.publicKey);
      return run(attempt);
    },
  });
}

async function fetchTradePreflightInput(marketId: bigint, holder: string, includeBalance: boolean): Promise<PreflightInput> {
  const [view, config, ledgerNow, position, usdcBalance] = await Promise.all([
    fetchOnChainMarket(marketId),
    fetchMarketConfig(),
    fetchLedgerNow(),
    marketCore()
      .get_position({ market_id: marketId, holder })
      .then((tx) => simulated<Position>(tx))
      .catch((error: unknown) => {
        throw new UserFacingError(describeError(error), error);
      }),
    includeBalance ? fetchUsdcBalanceIfAvailable(holder) : Promise.resolve(undefined),
  ]);
  return { market: view.market, config, ledgerNow, position, usdcBalance };
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
    mutationFn: async (params: BuyParams) => {
      const signer = guard();
      const id = toId(params.marketId);
      let firstMinSharesOut: bigint | undefined;
      let previousReview: ReviewModel | undefined;
      return runQueuedWrite(signer, `Buy ${params.outcome} on #${id}`, dedupeValue("buy", id, params.outcome, params.collateralIn, params.slippageBps), guard, async (attempt) => {
        const preflightInput = await fetchTradePreflightInput(id, signer.publicKey, true);
        throwPreflight(preflightBuy(preflightInput, params.outcome, params.collateralIn));
        let prepared = await prepareBuy(signer, params);
        if (prepared.quote === undefined) throw new Error("The buy quote was not recorded with the prepared transaction.");
        let quote = prepared.quote;
        let minSharesOut = prepared.derived.min_shares_out.value;
        if (attempt === 0) firstMinSharesOut = minSharesOut;
        if (
          attempt === 1 &&
          firstMinSharesOut !== undefined &&
          minSharesOut < firstMinSharesOut &&
          (firstMinSharesOut - minSharesOut) * 10_000n > firstMinSharesOut
        ) {
          const accepted = params.review ? true : await params.confirmBoundsChanged?.(firstMinSharesOut, minSharesOut);
          if (!accepted) {
            throw new UserFacingError({
              kind: "rejected",
              message: "The quote changed while the transaction was retried. Review the new minimum and try again.",
            });
          }
        }
        const reviewed = await reviewPreparedWrite(
          prepared,
          params.review,
          () => prepareBuy(signer, params),
          previousReview,
          attempt === 1,
        );
        prepared = reviewed.prepared;
        if (reviewed.model) previousReview = reviewed.model;
        quote = prepared.quote ?? quote;
        minSharesOut = prepared.derived.min_shares_out.value;
        const { value, txHash } = await submitPrepared<bigint>(prepared);
        return { sharesOut: value, quotedShares: quote, minSharesOut, txHash, holder: signer.publicKey };
      });
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
  review?: PreparedWriteReview;
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
    mutationFn: async ({ marketId, outcome, shares, slippageBps, review }: SellParams) => {
      const signer = guard();
      const id = toId(marketId);
      let previousReview: ReviewModel | undefined;
      return runQueuedWrite(signer, `Sell ${outcome} on #${id}`, dedupeValue("sell", id, outcome, shares, slippageBps), guard, async (attempt) => {
        const prepareFresh = async () => {
          const input = await fetchTradePreflightInput(id, signer.publicKey, false);
          const market = input.market;
          if (!market) {
            throwPreflight(preflightSell(input, outcome, 0n, shares));
            throw new Error("Market preflight unexpectedly succeeded without a market.");
          }
          const [rSold, rOther] =
            outcome === "Yes"
              ? [market.reserve_yes, market.reserve_no]
              : [market.reserve_no, market.reserve_yes];
          const collateralOut = collateralOutForShares(rSold, rOther, shares, BigInt(market.fee_bps));
          const maxSharesIn = maxIn(shares, slippageBps) + 1n;
          throwPreflight(preflightSell(input, outcome, collateralOut, shares));
          return prepareSell(signer, { marketId: id, outcome, collateralOut, maxSharesIn });
        };
        const initial = await prepareFresh();
        const reviewed = await reviewPreparedWrite(initial, review, prepareFresh, previousReview, attempt === 1);
        if (reviewed.model) previousReview = reviewed.model;
        const prepared = reviewed.prepared;
        const collateralOut = prepared.derived.collateral_out.value;
        const maxSharesIn = prepared.derived.max_shares_in.value;
        const { value, txHash } = await submitPrepared<bigint>(prepared);
        return { sharesSold: value, collateralOut, maxSharesIn, txHash, holder: signer.publicKey };
      });
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export function useRedeem() {
  const guard = useWriteGuard();
  const invalidate = useInvalidateAfterTrade();
  return useMutation({
    mutationFn: async ({ marketId, review }: { marketId: bigint | string; review?: PreparedWriteReview }) => {
      const signer = guard();
      const id = toId(marketId);
      return runQueuedWrite(signer, `Redeem market #${id}`, dedupeValue("redeem", id), guard, async (attempt) => {
        return redeemOnce(signer, id, undefined, review, attempt);
      });
    },
    onSuccess: (d, v) => invalidate(String(v.marketId), d.holder),
  });
}

export interface RedeemAllController {
  discovery: RedeemDiscovery | null;
  states: Record<string, ItemState>;
  scanning: boolean;
  running: boolean;
  error: string | null;
  scan: () => Promise<void>;
  redeemAll: (review?: PreparedWriteReview) => Promise<void>;
  retryFailed: (review?: PreparedWriteReview) => Promise<void>;
  skip: (marketId: string) => void;
  cancel: () => void;
}

export function useRedeemAll(): RedeemAllController {
  const { address } = useWallet();
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  const [discoveryState, setDiscovery] = useState<RedeemDiscovery | null>(null);
  const [discoveryHolder, setDiscoveryHolder] = useState<string | null>(address);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [statesHolder, setStatesHolder] = useState<string | null>(address);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statesRef = useRef(states);
  const holderRef = useRef<string | null>(address);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const discovery = discoveryHolder === address ? discoveryState : null;
  const visibleStates = statesHolder === address ? states : {};

  useEffect(() => {
    holderRef.current = address;
    runningRef.current = false;
    cancelRef.current = true;
    let restored: Record<string, ItemState> = {};
    let restoreError: string | null = null;
    try {
      if (address) {
        const resume = loadRedeemAllResume(address);
        restored = Object.fromEntries(
          Object.entries(resume?.states ?? {}).map(([id, state]) => [
            id,
            state.s === "signing"
              ? { s: "queued" as const }
              : state.s === "submitting"
                ? {
                    s: "failed" as const,
                    error: state.hash
                      ? `Transaction ${state.hash} was submitted before this tab closed. Verify it on Stellar before retrying.`
                      : "The tab closed while the transaction was submitting. Verify the ledger before retrying.",
                  }
                : state,
          ]),
        );
      }
    } catch (cause) {
      restoreError = describeError(cause).message;
    }
    statesRef.current = restored;
    const reset = window.setTimeout(() => {
      setDiscovery(null);
      setDiscoveryHolder(address);
      setError(restoreError);
      setRunning(false);
      setScanning(false);
      setStates(restored);
      setStatesHolder(address);
    }, 0);
    return () => window.clearTimeout(reset);
  }, [address]);

  const commitStates = (holder: string, next: Record<string, ItemState>) => {
    if (holderRef.current !== holder) return;
    statesRef.current = next;
    setStates(next);
    setStatesHolder(holder);
    const resume: RedeemAllResume = { holder, ids: Object.keys(next), states: next };
    saveRedeemAllResume(resume);
  };

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const signer = guard();
      const holder = signer.publicKey;
      const count = simulated<bigint>(await marketCore().market_count());
      const result = await discoverRedeemable(holder, count);
      if (holderRef.current !== holder) return;
      const next = { ...statesRef.current };
      for (const item of result.redeemables) {
        const id = item.marketId.toString();
        if (!next[id] || next[id].s === "failed") next[id] = { s: "queued" };
      }
      setDiscovery(result);
      setDiscoveryHolder(holder);
      commitStates(holder, next);
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      setScanning(false);
    }
  };

  const processItems = async (ids: string[], review?: PreparedWriteReview) => {
    if (runningRef.current) return;
    let signer: Signer;
    try {
      signer = guard();
      if (holderRef.current !== signer.publicKey) {
        throw new UserFacingError({ kind: "disconnected", message: "Wait for the connected wallet to finish switching before redeeming." });
      }
    } catch (cause) {
      setError(describeError(cause).message);
      return;
    }
    const holder = signer.publicKey;
    runningRef.current = true;
    cancelRef.current = false;
    setRunning(true);
    setError(null);
    const redeemedIds: string[] = [];
    try {
      for (const id of ids) {
        if (cancelRef.current || holderRef.current !== holder) break;
        const previous = statesRef.current[id];
        if (previous?.s === "redeemed" || previous?.s === "skipped") continue;
        const marketId = BigInt(id);
        try {
          const result = await runQueuedWrite(
            signer,
            `Redeem market #${id}`,
            dedupeValue("redeem", id),
            guard,
            async (attempt) =>
              redeemOnce(
                signer,
                marketId,
                () => commitStates(holder, { ...statesRef.current, [id]: { s: "signing" } }),
                review,
                attempt,
              ),
          );
          commitStates(holder, { ...statesRef.current, [id]: { s: "submitting", hash: result.txHash ?? undefined } });
          commitStates(holder, {
            ...statesRef.current,
            [id]: { s: "redeemed", payout: result.payout, hash: result.txHash },
          });
          redeemedIds.push(id);
        } catch (cause) {
          if (cancelRef.current && cause instanceof DOMException && cause.name === "AbortError") break;
          const failure = cause instanceof UserFacingError ? cause.described : describeError(cause);
          if (failure.kind === "rejected") {
            commitStates(holder, { ...statesRef.current, [id]: { s: "queued" } });
            setError(failure.message);
            cancelRef.current = true;
            break;
          }
          commitStates(holder, { ...statesRef.current, [id]: { s: "failed", error: failure.message } });
        }
      }
      if (holderRef.current === holder && redeemedIds.length) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["stellar", "markets"] }),
          queryClient.invalidateQueries({ queryKey: stellarKeys.balance(holder) }),
          ...redeemedIds.flatMap((id) => [
            queryClient.invalidateQueries({ queryKey: stellarKeys.market(id) }),
            queryClient.invalidateQueries({ queryKey: stellarKeys.position(id, holder) }),
          ]),
        ]);
      }
    } catch (cause) {
      setError(describeError(cause).message);
    } finally {
      runningRef.current = false;
      if (holderRef.current === holder) setRunning(false);
    }
  };

  const redeemAll = async (review?: PreparedWriteReview) => {
    const ids = (discovery?.redeemables ?? []).map((item) => item.marketId.toString());
    await processItems(ids, review);
  };

  const retryFailed = async (review?: PreparedWriteReview) => {
    const ids = Object.entries(statesRef.current)
      .filter(([, item]) => item.s === "failed")
      .map(([id]) => id);
    await processItems(ids, review);
  };

  const skip = (marketId: string) => {
    const holder = address;
    if (!holder || holderRef.current !== holder || runningRef.current) return;
    commitStates(holder, { ...statesRef.current, [marketId]: { s: "skipped" } });
  };

  const cancel = () => {
    cancelRef.current = true;
  };

  return { discovery, states: visibleStates, scanning, running, error, scan, redeemAll, retryFailed, skip, cancel };
}

/** SEP-41 transfer on the USDC SAC, signed by the connected wallet. */
export interface UsdcTransferParams {
  to: string;
  amount: bigint;
  review?: PreparedWriteReview;
}

export function useUsdcTransfer() {
  const guard = useWriteGuard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ to, amount, review }: UsdcTransferParams) => {
      const signer = guard();
      if (amount <= 0n) throw new UserFacingError({ kind: "contract", message: "Enter an amount greater than zero." });
      let previousReview: ReviewModel | undefined;
      return runQueuedWrite(signer, "USDC transfer", dedupeValue("usdc-transfer", to, amount), guard, async (attempt) => {
        let prepared = await prepareUsdcTransfer(signer, { to, amount });
        const reviewed = await reviewPreparedWrite(
          prepared,
          review,
          () => prepareUsdcTransfer(signer, { to, amount }),
          previousReview,
          attempt === 1,
        );
        prepared = reviewed.prepared;
        if (reviewed.model) previousReview = reviewed.model;
        const { txHash } = await submitPrepared<null>(prepared);
        if (!txHash) throw new UserFacingError({ kind: "unknown", message: "The payment was sent but no transaction hash came back." });
        return { txHash, holder: signer.publicKey };
      });
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: stellarKeys.balance(d.holder) });
    },
  });
}
