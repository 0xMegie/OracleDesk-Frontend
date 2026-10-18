import type { Position } from "@/lib/stellar/generated/market-core";
import type { RedeemedEvent, ResolvedEvent } from "@/lib/stellar/events";
import type { InboxItem } from "./store";

/**
 * Pure classifiers that turn validated socket payloads or decoded contract
 * events into inbox items for one owner (issue #42). Anything that is not
 * about the owner, or fails validation, returns null.
 */

const UINT = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

interface Ctx {
  owner: string;
  network: string;
  now?: number;
}

const base = (ctx: Ctx, rest: Omit<InboxItem, "owner" | "network" | "readAt" | "createdAt"> & { createdAt?: number }): InboxItem => ({
  owner: ctx.owner,
  network: ctx.network,
  readAt: null,
  createdAt: rest.createdAt ?? ctx.now ?? Date.now(),
  ...rest,
});

/** A TRADE_EXECUTED payload becomes a fill only when the owner is the trader. */
export function classifyTrade(payload: unknown, ctx: Ctx): InboxItem | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.trader !== ctx.owner) return null;
  if (!isStr(p.eventId) || !isStr(p.onChainMarketId) || !UINT.test(p.onChainMarketId)) return null;
  if (!isStr(p.collateralRaw) || !UINT.test(p.collateralRaw)) return null;
  if (!isStr(p.sharesRaw) || !UINT.test(p.sharesRaw)) return null;
  if (!isStr(p.txHash) || !HEX64.test(p.txHash)) return null;
  if (p.direction !== "YES" && p.direction !== "NO") return null;
  if (typeof p.isBuy !== "boolean") return null;
  return base(ctx, {
    id: `fill:${p.eventId}`,
    kind: "fill",
    marketId: p.onChainMarketId,
    txHash: p.txHash.toLowerCase(),
    ledger: typeof p.ledger === "number" ? p.ledger : undefined,
    data: {
      direction: p.direction,
      side: p.isBuy ? "buy" : "sell",
      collateralRaw: p.collateralRaw,
      sharesRaw: p.sharesRaw,
      ...(isStr(p.marketQuestion) ? { marketQuestion: p.marketQuestion } : {}),
    },
  });
}

/** A REASONING_PUBLISHED payload becomes a trace item only for held markets. */
export function classifyTrace(payload: unknown, heldMarketIds: ReadonlySet<string>, ctx: Ctx): InboxItem | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!isStr(p.onChainMarketId) || !UINT.test(p.onChainMarketId)) return null;
  if (!heldMarketIds.has(p.onChainMarketId)) return null;
  if (!isStr(p.onChainTraceId) || !UINT.test(p.onChainTraceId)) return null;
  return base(ctx, {
    id: `trace:${p.onChainTraceId}`,
    kind: "trace",
    marketId: p.onChainMarketId,
    txHash: isStr(p.txHash) && HEX64.test(p.txHash) ? p.txHash.toLowerCase() : undefined,
    ledger: typeof p.ledger === "number" ? p.ledger : undefined,
    data: {
      onChainTraceId: p.onChainTraceId,
      action: isStr(p.action) ? p.action : "",
      ...(isStr(p.traceId) ? { traceId: p.traceId } : {}),
    },
  });
}

/** A resolved (or voided) market is redeemable if the owner still holds shares. */
export function classifyResolved(decoded: ResolvedEvent, position: Position, ctx: Ctx): InboxItem | null {
  if (position.yes + position.no <= 0n) return null;
  return base(ctx, {
    id: `redeemable:${decoded.marketId}`,
    kind: "redeemable",
    marketId: decoded.marketId,
    ledger: decoded.ledger,
    createdAt: Date.parse(decoded.closedAt) || undefined,
    data: {
      outcome: decoded.outcome ?? "void",
      yes: position.yes.toString(),
      no: position.no.toString(),
    },
  });
}

/** A Redeemed event is the owner's only when they are the holder. */
export function classifyRedeemed(decoded: RedeemedEvent, ctx: Ctx): InboxItem | null {
  if (decoded.holder !== ctx.owner) return null;
  return base(ctx, {
    id: `redeemed:${decoded.marketId}`,
    kind: "redeemed",
    marketId: decoded.marketId,
    txHash: decoded.txHash,
    ledger: decoded.ledger,
    createdAt: Date.parse(decoded.closedAt) || undefined,
    data: { payoutRaw: decoded.payout.toString() },
  });
}

/** The owner's own failed or pending transaction. Rejections are not recorded. */
export function classifyTx(
  tx: { hash: string | null; kind: string; state: "pending" | "failed"; marketId?: string; errorKind?: string; message?: string },
  ctx: Ctx,
): InboxItem | null {
  if (tx.errorKind === "rejected") return null;
  const ref = tx.hash ?? `${tx.kind}:${tx.marketId ?? ""}:${ctx.now ?? Date.now()}`;
  return base(ctx, {
    id: `tx-${tx.state}:${ref}`,
    kind: tx.state === "failed" ? "tx-failed" : "tx-pending",
    marketId: tx.marketId,
    txHash: tx.hash ?? undefined,
    data: { action: tx.kind, ...(tx.message ? { message: tx.message } : {}) },
  });
}
