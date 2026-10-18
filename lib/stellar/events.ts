import { nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { marketCore, rpcServer, type OutcomeTag } from "./clients";
import { CONTRACTS } from "./config";
import { priceYesBps } from "./generated/fpmm";

/**
 * Contract event helpers backed by Stellar RPC getEvents (issues #40, #42).
 *
 * Topic layout for market-core events: [<event name symbol>, ...indexed fields].
 * The name symbol comes from the contract spec, not a hard-coded string.
 */

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The prefix topic symbol for a market-core event, read from the shipped spec. */
export function eventPrefix(eventName: "Trade" | "Redeemed" | "MarketResolved"): string {
  try {
    const entries = (marketCore().spec as unknown as { entries: xdr.ScSpecEntry[] }).entries;
    for (const entry of entries) {
      if (entry.switch().value !== xdr.ScSpecEntryKind.scSpecEntryEventV0().value) continue;
      const ev = entry.eventV0();
      if (ev.name().toString() !== eventName) continue;
      const prefix = ev.prefixTopics();
      if (prefix.length > 0) return prefix[0].toString();
    }
  } catch {
    // Fall through to the #[contractevent] default (snake_case struct name).
  }
  return snake(eventName);
}

const symbolTopic = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
const u64Topic = (n: bigint) => nativeToScVal(n, { type: "u64" }).toXDR("base64");
const addressTopic = (a: string) => nativeToScVal(a, { type: "address" }).toXDR("base64");

export function tradeTopicFilter(marketId: bigint): string[] {
  return [symbolTopic(eventPrefix("Trade")), u64Topic(marketId), "*"];
}

export function resolvedTopicFilter(marketId: bigint): string[] {
  return [symbolTopic(eventPrefix("MarketResolved")), u64Topic(marketId)];
}

export function redeemedTopicFilter(holder: string): string[] {
  return [symbolTopic(eventPrefix("Redeemed")), "*", addressTopic(holder)];
}

export interface RawEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

export interface TradeRow {
  id: string;
  ledger: number;
  closedAt: string;
  txHash: string;
  marketId: string;
  trader: string;
  outcome: OutcomeTag;
  isBuy: boolean;
  collateral: bigint;
  shares: bigint;
  fee: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  yesBpsAfter: number;
  origin?: "rpc" | "socket";
}

const outcomeTag = (v: unknown): OutcomeTag => {
  const tag = Array.isArray(v) ? v[0] : (v as { tag?: string })?.tag ?? v;
  if (tag !== "Yes" && tag !== "No") throw new Error(`Unexpected outcome ${String(tag)}`);
  return tag;
};

const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as number | string));

function fields(value: xdr.ScVal): Record<string, unknown> {
  const native = scValToNative(value) as unknown;
  if (native && typeof native === "object" && !Array.isArray(native)) return native as Record<string, unknown>;
  throw new Error("Expected a map-shaped event body");
}

export function decodeTrade(ev: RawEvent): TradeRow {
  const marketId = big(scValToNative(ev.topic[1])).toString();
  const trader = String(scValToNative(ev.topic[2]));
  const f = fields(ev.value);
  const reserveYes = big(f.reserve_yes);
  const reserveNo = big(f.reserve_no);
  return {
    id: ev.id,
    ledger: ev.ledger,
    closedAt: ev.ledgerClosedAt,
    txHash: ev.txHash,
    marketId,
    trader,
    outcome: outcomeTag(f.outcome),
    isBuy: Boolean(f.is_buy),
    collateral: big(f.collateral),
    shares: big(f.shares),
    fee: big(f.fee),
    reserveYes,
    reserveNo,
    yesBpsAfter: Number(priceYesBps(reserveYes, reserveNo)),
    origin: "rpc",
  };
}

export interface ResolvedEvent {
  id: string;
  ledger: number;
  closedAt: string;
  marketId: string;
  /** null = voided (still redeemable at half of each side). */
  outcome: OutcomeTag | null;
}

export function decodeResolved(ev: RawEvent): ResolvedEvent {
  const marketId = big(scValToNative(ev.topic[1])).toString();
  const f = fields(ev.value);
  const raw = f.outcome;
  return {
    id: ev.id,
    ledger: ev.ledger,
    closedAt: ev.ledgerClosedAt,
    marketId,
    outcome: raw === undefined || raw === null ? null : outcomeTag(raw),
  };
}

export interface RedeemedEvent {
  id: string;
  ledger: number;
  closedAt: string;
  txHash: string;
  marketId: string;
  holder: string;
  payout: bigint;
}

export function decodeRedeemed(ev: RawEvent): RedeemedEvent {
  const f = fields(ev.value);
  return {
    id: ev.id,
    ledger: ev.ledger,
    closedAt: ev.ledgerClosedAt,
    txHash: ev.txHash,
    marketId: big(scValToNative(ev.topic[1])).toString(),
    holder: String(scValToNative(ev.topic[2])),
    payout: big(f.payout),
  };
}

/** The subset of rpc.Server used here, so tests can fake it. */
export interface EventsServer {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
  getEvents(req: rpc.Server.GetEventsRequest): Promise<{
    events: Array<{ id: string; ledger: number; ledgerClosedAt: string; txHash: string; topic: xdr.ScVal[]; value: xdr.ScVal }>;
    cursor?: string;
    latestLedger: number;
  }>;
}

const defaultServer = (): EventsServer => rpcServer() as unknown as EventsServer;

/** Pages forward from startLedger through all events matching the filter. */
async function collectForward(
  server: EventsServer,
  topics: string[][],
  startLedger: number,
  signal?: AbortSignal,
  pageLimit = 200,
): Promise<{ events: RawEvent[]; latestLedger: number; cursor: string }> {
  const events: RawEvent[] = [];
  let cursor: string | undefined;
  let latestLedger = startLedger;
  for (let page = 0; page < 50; page++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const filters = [{ type: "contract" as const, contractIds: [CONTRACTS.marketCore], topics }];
    const res = await server.getEvents(
      (cursor
        ? { filters, cursor, limit: pageLimit }
        : { filters, startLedger, limit: pageLimit }) as rpc.Server.GetEventsRequest,
    );
    latestLedger = res.latestLedger;
    for (const e of res.events) {
      events.push({ id: e.id, ledger: e.ledger, ledgerClosedAt: e.ledgerClosedAt, txHash: e.txHash, topic: e.topic, value: e.value });
    }
    if (res.events.length < pageLimit || !res.cursor) {
      cursor = res.cursor;
      break;
    }
    cursor = res.cursor;
  }
  return { events, latestLedger, cursor: cursor ?? "" };
}

const PROBE_WINDOWS = [2_000, 8_000, 32_000, 128_000] as const;
export const MAX_TAPE_ROWS = 2_000;

interface TradeCacheEntry {
  trades: TradeRow[];
  fromLedger: number;
  cursor: string;
  reachedRetention: boolean;
  latestLedger: number;
}
const tradeCache = new Map<string, TradeCacheEntry>();

/** Test hook. */
export function clearTradeCache() {
  tradeCache.clear();
}

/**
 * Newest `want` Trade events for one market, newest first. RPC only pages
 * forward, so windows widen backwards from the tip until enough events are
 * found or RPC retention (oldestLedger) is reached.
 */
export async function fetchMarketTrades(
  marketId: bigint,
  opts: { want: number; signal?: AbortSignal; server?: EventsServer },
): Promise<{ trades: TradeRow[]; reachedRetention: boolean; latestLedger: number; cursor: string }> {
  const server = opts.server ?? defaultServer();
  const topics = [tradeTopicFilter(marketId)];
  const key = marketId.toString();
  const cached = tradeCache.get(key);
  if (cached && (cached.trades.length >= opts.want || cached.reachedRetention)) {
    return { ...cached, trades: cached.trades.slice(0, opts.want) };
  }

  let health = await server.getHealth();
  let found: RawEvent[] = [];
  let fromLedger = health.latestLedger;
  let cursor = "";
  let latestLedger = health.latestLedger;
  let reachedRetention = false;

  for (const span of [...PROBE_WINDOWS, Infinity]) {
    fromLedger = Math.max(health.oldestLedger, health.latestLedger - span);
    let res;
    try {
      res = await collectForward(server, topics, fromLedger, opts.signal);
    } catch (err) {
      // Retention moved under us: re-read the window once and retry.
      if (err instanceof DOMException) throw err;
      health = await server.getHealth();
      fromLedger = Math.max(health.oldestLedger, fromLedger);
      res = await collectForward(server, topics, fromLedger, opts.signal);
    }
    found = res.events;
    cursor = res.cursor;
    latestLedger = res.latestLedger;
    reachedRetention = fromLedger <= health.oldestLedger;
    if (found.length >= opts.want || reachedRetention) break;
  }

  const trades: TradeRow[] = [];
  for (let i = found.length - 1; i >= 0 && trades.length < MAX_TAPE_ROWS; i--) {
    try {
      trades.push(decodeTrade(found[i]));
    } catch {
      // Skip events that do not decode with the shipped spec.
    }
  }
  const entry = { trades, fromLedger, cursor, reachedRetention, latestLedger };
  tradeCache.set(key, entry);
  return { trades: trades.slice(0, opts.want), reachedRetention, latestLedger, cursor };
}

/** All events matching `topics` from `startLedger` (clamped to retention). */
export async function fetchEventsSince(
  topics: string[][],
  startLedger: number,
  server: EventsServer = defaultServer(),
): Promise<{ events: RawEvent[]; latestLedger: number }> {
  const health = await server.getHealth();
  const from = Math.max(health.oldestLedger, startLedger || health.latestLedger - 2_000);
  const { events, latestLedger } = await collectForward(server, topics, from);
  return { events, latestLedger };
}
