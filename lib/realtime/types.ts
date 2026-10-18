import { StrKey } from "@stellar/stellar-sdk";

export interface TradeEvent {
  eventId: string; onChainMarketId: string; trader: string; direction: "YES" | "NO"; isBuy: boolean;
  collateralRaw: string; sharesRaw: string; feeRaw: string; priceYesBps: number;
  txHash: string; ledger: number; marketQuestion: string | null; closedAt?: string;
}
export interface TraceEvent {
  onChainTraceId: string; onChainMarketId: string; traceId: string | null;
  agent: string; action: string; ledger: number; txHash: string; closedAt?: string;
}
export type RealtimeEvent =
  | { type: "TRADE_EXECUTED"; payload: TradeEvent; receivedAt: number }
  | { type: "REASONING_PUBLISHED"; payload: TraceEvent; receivedAt: number };

export const isHash = (v: unknown): v is string => typeof v === "string" && /^[a-f\d]{64}$/i.test(v);
export const isRaw = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,38})$/.test(v) && BigInt(v) <= (1n << 127n) - 1n;
export const isMarketId = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) < 1n << 64n;
export const isAddress = (v: unknown): v is string => typeof v === "string" && (StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v));
const isLedger = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validTime = (v: unknown) => v === undefined || (typeof v === "string" && Number.isFinite(Date.parse(v)));

export function isTradeEvent(v: unknown): v is TradeEvent {
  return object(v) && typeof v.eventId === "string" && v.eventId.length > 0 && v.eventId.length < 150 &&
    isMarketId(v.onChainMarketId) && isAddress(v.trader) && (v.direction === "YES" || v.direction === "NO") &&
    typeof v.isBuy === "boolean" && isRaw(v.collateralRaw) && isRaw(v.sharesRaw) && isRaw(v.feeRaw) &&
    Number.isInteger(v.priceYesBps) && (v.priceYesBps as number) >= 0 && (v.priceYesBps as number) <= 10000 &&
    isHash(v.txHash) && isLedger(v.ledger) && (v.marketQuestion === null || typeof v.marketQuestion === "string") && validTime(v.closedAt);
}
export function isTraceEvent(v: unknown): v is TraceEvent {
  return object(v) && isMarketId(v.onChainTraceId) && isMarketId(v.onChainMarketId) && isAddress(v.agent) &&
    typeof v.action === "string" && v.action.length > 0 && v.action.length < 200 &&
    (v.traceId === null || typeof v.traceId === "string") && isHash(v.txHash) && isLedger(v.ledger) && validTime(v.closedAt);
}
export const eventKey = (event: RealtimeEvent) => event.type === "TRADE_EXECUTED" ? `trade:${event.payload.eventId}` : `trace:${event.payload.onChainTraceId}`;
