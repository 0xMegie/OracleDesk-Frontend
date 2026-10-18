"use client";

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useTxTracker } from "@/lib/stellar/tx-tracker";
import { marketCore, rpcServer } from "@/lib/stellar/clients";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import { read } from "@/lib/stellar/typed-call";
import { decodeEvent, eventTopicFilter, fetchEventRange, type ChainEvent } from "@/lib/stellar/events";
import type { Position } from "@/lib/stellar/generated/market-core";
import type { Stamped } from "@/lib/stellar/optimistic";
import { useRealtimeBatch } from "@/lib/realtime/RealtimeProvider";
import { classifyTrade, classifyTrace, classifyResolved, classifyRedeemed, classifyTracked } from "./classify";
import { openInbox, type Inbox, type InboxItem } from "./store";

interface InboxView {
  items: readonly InboxItem[]; unread: number; status: "disconnected" | "loading" | "saved" | "memory";
  error: string | null; burst: { count: number; overflow: number } | null;
  markRead(ids: string[]): Promise<void>; markAllRead(): Promise<void>;
}
const empty: InboxView = { items: [], unread: 0, status: "disconnected", error: null, burst: null, markRead: async () => {}, markAllRead: async () => {} };
const Context = createContext<InboxView>(empty);
export const useInbox = () => useContext(Context);

export function InboxProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet();
  return address ? <ConnectedInbox key={`${NETWORK_PASSPHRASE}:${address}`} owner={address}>{children}</ConnectedInbox>
    : <Context.Provider value={empty}>{children}</Context.Provider>;
}
function ConnectedInbox({ owner, children }: { owner: string; children: ReactNode }) {
  const client = useQueryClient();
  const tracker = useTxTracker();
  const [view, setView] = useState<Omit<InboxView, "markRead" | "markAllRead">>({ ...empty, status: "loading" });
  const store = useRef<Inbox | null>(null);
  const ready = useRef<Promise<Inbox> | null>(null);
  const held = useRef(new Set<string>());
  const known = useRef(new Set<string>());
  const active = useRef(false);
  const operations = useRef(Promise.resolve());
  const refresh = useCallback(async (inbox: Inbox) => {
    const [items, unread] = await Promise.all([inbox.list({ limit: 200 }), inbox.unreadCount()]);
    if (active.current && !document.hidden) setView(v => ({ ...v, items, unread, status: inbox.persistent ? "saved" : "memory" }));
  }, []);
  const enqueue = useCallback((operation: (inbox: Inbox) => Promise<void>) => {
    operations.current = operations.current.then(async () => {
      const inbox = await ready.current;
      if (inbox && active.current) await operation(inbox);
    }).catch(error => {
      if (active.current && !document.hidden) setView(v => ({ ...v, error: error instanceof Error ? error.message : "Inbox unavailable" }));
    });
    return operations.current;
  }, []);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    ready.current = openInbox(owner, NETWORK_PASSPHRASE).then(async inbox => {
      if (cancelled) { inbox.close(); return inbox; }
      store.current = inbox;
      const saved = await inbox.list();
      const ids = await inbox.getMeta("knownMarkets");
      try { for (const id of JSON.parse(ids ?? "[]")) if (typeof id === "string" && /^\d+$/.test(id)) known.current.add(id); } catch { /* Older malformed metadata is ignored. */ }
      saved.forEach(item => { if (item.marketId && item.kind === "fill") known.current.add(item.marketId); });
      await refresh(inbox);
      return inbox;
    });
    const visibility = () => { if (!document.hidden) void enqueue(refresh); };
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelled = true; active.current = false; store.current?.close(); store.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, [owner, enqueue, refresh]);

  useRealtimeBatch(batch => {
    // A fill earlier in this batch can make a later trace relevant immediately.
    const items: InboxItem[] = [];
    for (const event of batch) {
      if (event.type === "TRADE_EXECUTED") {
        const item = classifyTrade(event.payload, owner, event.receivedAt);
        if (item) { items.push(item); known.current.add(item.marketId!); if (event.payload.isBuy) held.current.add(item.marketId!); }
      } else {
        const item = classifyTrace(event.payload, held.current, owner, event.receivedAt);
        if (item) items.push(item);
      }
    }
    if (batch.length > 10 || batch.resumed) setView(v => ({ ...v, burst: { count: batch.length + batch.overflow, overflow: batch.overflow } }));
    if (items.length) void enqueue(async inbox => {
      await inbox.put(items); await inbox.prune(500);
      await inbox.setMeta("knownMarkets", JSON.stringify([...known.current]));
      await refresh(inbox);
    });
  });

  const recordTransactions = useEffectEvent(() => {
    const own = tracker.list.filter(tx => tx.holder === owner && tx.networkPassphrase === NETWORK_PASSPHRASE);
    void enqueue(async inbox => {
      const items = own.flatMap(tx => { const item = classifyTracked(tx, owner); return item ? [item] : []; });
      await inbox.put(items);
      await inbox.remove(own.filter(tx => tx.state !== "pending").map(tx => `tx-pending:${tx.hash}`));
      await inbox.prune(500); await refresh(inbox);
    });
  });
  useEffect(() => { recordTransactions(); }, [tracker.list]);

  useEffect(() => {
    let running = false, cancelled = false;
    const controller = new AbortController();
    async function poll() {
      if (running || cancelled || document.hidden) return;
      running = true;
      try {
        const inbox = await ready.current;
        if (!inbox || cancelled) return;
        // Discover only positions already read by this wallet, plus its own fill history.
        for (const [key, data] of client.getQueriesData<Stamped<Position>>({ queryKey: ["stellar", "position"] })) {
          if (key[3] === owner && data?.value && (data.value.yes > 0n || data.value.no > 0n)) known.current.add(String(key[2]));
        }
        const server = rpcServer();
        const health = await server.getHealth();
        const last = Number(await inbox.getMeta("lastLedger"));
        const start = Math.max(health.oldestLedger, Number.isSafeInteger(last) && last > 0 ? last + 1 : health.oldestLedger);
        const positions = new Map<string, Position>();
        const synthetic: InboxItem[] = [];
        for (const id of known.current) {
          if (cancelled || document.hidden) return;
          const position = read(await marketCore().get_position({ market_id: BigInt(id), holder: owner }));
          positions.set(id, position);
          if (position.yes + position.no > 0n) {
            held.current.add(id);
            const marketTx = await marketCore().get_market({ market_id: BigInt(id) });
            const market = read(marketTx);
            if (market.status.tag === "Resolved" || market.status.tag === "Void") {
              // Current decoded contract status catches resolutions beyond event retention.
              const item = classifyResolved({ id: `status:${id}`, name: "MarketResolved", ledger: marketTx.simulation!.latestLedger,
                closedAt: new Date().toISOString(), txHash: "", data: { market_id: BigInt(id), outcome: market.status.tag === "Void" ? undefined : market.status.values[0] } }, owner, position);
              if (item) synthetic.push(item);
            }
          } else held.current.delete(id);
        }
        const topics = [eventTopicFilter("Redeemed", { holder: owner }), ...[...held.current].map(id => eventTopicFilter("MarketResolved", { market_id: BigInt(id) }))];
        const events: ChainEvent[] = [];
        for (let i = 0; i < topics.length; i += 5) {
          const page = await fetchEventRange(server, topics.slice(i, i + 5), start, health.latestLedger + 1, controller.signal);
          for (const raw of page.events) { const event = decodeEvent(raw); if (event) events.push(event); }
        }
        if (cancelled) return;
        await enqueue(async current => {
          await current.put([...synthetic, ...events.flatMap(event => {
            const item = event.name === "Redeemed" ? classifyRedeemed(event, owner)
              : classifyResolved(event, owner, positions.get(String(event.data.market_id)) ?? { yes: 0n, no: 0n });
            return item ? [item] : [];
          })]);
          await current.setMeta("knownMarkets", JSON.stringify([...known.current]));
          await current.setMeta("lastLedger", String(health.latestLedger));
          await current.prune(500); await refresh(current);
          if (!document.hidden) setView(v => ({ ...v, error: null }));
        });
      } catch (error) {
        if (!cancelled && !document.hidden) setView(v => ({ ...v, error: `Chain inbox refresh failed: ${error instanceof Error ? error.message : "RPC unavailable"}` }));
      } finally { running = false; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 60_000);
    const visibility = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [owner, client, enqueue, refresh]);

  const value = useMemo<InboxView>(() => ({ ...view,
    markRead: ids => enqueue(async inbox => { await inbox.markRead(ids); await refresh(inbox); }),
    markAllRead: () => enqueue(async inbox => { await inbox.markAllRead(); await refresh(inbox); }),
  }), [view, enqueue, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
