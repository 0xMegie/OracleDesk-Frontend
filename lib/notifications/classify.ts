import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import type { Position } from "@/lib/stellar/generated/market-core";
import type { ChainEvent } from "@/lib/stellar/events";
import type { TrackedTx } from "@/lib/stellar/tx-tracker-core";
import { isTradeEvent, isTraceEvent, isRaw, isHash } from "@/lib/realtime/types";
import type { InboxItem } from "./store";

const base = (owner: string, kind: InboxItem["kind"], id: string, createdAt: number): InboxItem => ({ owner, network: NETWORK_PASSPHRASE, kind, id: `${kind}:${id}`, createdAt, readAt: null, data: {} });
const eventTime = (event: ChainEvent) => Date.parse(event.closedAt);
export function classifyTrade(payload: unknown, owner: string, receivedAt = Date.now()): InboxItem | null {
  if (!isTradeEvent(payload) || payload.trader !== owner) return null;
  return { ...base(owner, "fill", payload.eventId, payload.closedAt ? Date.parse(payload.closedAt) : receivedAt),
    marketId: payload.onChainMarketId, txHash: payload.txHash, ledger: payload.ledger,
    data: { collateralRaw: payload.collateralRaw, sharesRaw: payload.sharesRaw, direction: payload.direction, action: payload.isBuy ? "Bought" : "Sold", question: payload.marketQuestion ?? "" } };
}
export function classifyTrace(payload: unknown, heldMarketIds: ReadonlySet<string>, owner: string, receivedAt = Date.now()): InboxItem | null {
  if (!isTraceEvent(payload) || !heldMarketIds.has(payload.onChainMarketId)) return null;
  return { ...base(owner, "trace", payload.onChainTraceId, payload.closedAt ? Date.parse(payload.closedAt) : receivedAt),
    marketId: payload.onChainMarketId, txHash: payload.txHash, ledger: payload.ledger,
    data: { traceId: payload.traceId ?? "", onChainTraceId: payload.onChainTraceId, action: payload.action } };
}
export function classifyResolved(event: ChainEvent, owner: string, position: Position): InboxItem | null {
  if (event.name !== "MarketResolved" || typeof event.data.market_id !== "bigint" || position.yes + position.no <= 0n || !Number.isFinite(eventTime(event))) return null;
  const outcome = event.data.outcome as { tag?: unknown } | undefined;
  if (outcome !== undefined && outcome !== null && outcome.tag !== "Yes" && outcome.tag !== "No") return null;
  const marketId = event.data.market_id.toString();
  return { ...base(owner, "redeemable", marketId, eventTime(event)), marketId, ledger: event.ledger,
    ...(isHash(event.txHash) ? { txHash: event.txHash } : {}), data: { outcome: outcome?.tag ? String(outcome.tag) : "Void" } };
}
export function classifyRedeemed(event: ChainEvent, owner: string): InboxItem | null {
  if (event.name !== "Redeemed" || event.data.holder !== owner || typeof event.data.market_id !== "bigint" ||
    typeof event.data.payout !== "bigint" || !isRaw(String(event.data.payout)) || !Number.isFinite(eventTime(event)) || !isHash(event.txHash)) return null;
  return { ...base(owner, "redeemed", event.id, eventTime(event)), marketId: event.data.market_id.toString(), txHash: event.txHash,
    ledger: event.ledger, data: { payoutRaw: String(event.data.payout) } };
}
export function classifyTracked(tx: TrackedTx, owner: string): InboxItem | null {
  if (tx.holder !== owner || tx.networkPassphrase !== NETWORK_PASSPHRASE || !isHash(tx.hash)) return null;
  if (tx.state !== "pending" && tx.state !== "failed" && tx.state !== "expired") return null;
  const kind = tx.state === "pending" ? "tx-pending" : "tx-failed";
  return { ...base(owner, kind, tx.hash, tx.submittedAt), txHash: tx.hash, marketId: tx.marketId, ledger: tx.ledger,
    data: { action: tx.kind, message: tx.error?.message ?? (tx.state === "expired" ? "Transaction expired" : "Awaiting confirmation") } };
}
