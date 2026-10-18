"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useRealtimeBatch, type ReasoningPublishedPayload, type TradeExecutedPayload } from "@/lib/realtime/RealtimeProvider";
import { useTxTracker } from "@/lib/stellar/tx-tracker";
import { marketCore } from "@/lib/stellar/clients";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import type { Position } from "@/lib/stellar/generated/market-core";
import type { Stamped } from "@/lib/stellar/optimistic";
import { read } from "@/lib/stellar/typed-call";
import {
  decodeRedeemed,
  decodeResolved,
  fetchEventsSince,
  redeemedTopicFilter,
  resolvedTopicFilter,
} from "@/lib/stellar/events";
import { classifyRedeemed, classifyResolved, classifyTrace, classifyTrade, classifyTx } from "./classify";
import { MAX_ITEMS, openInbox, type Inbox, type InboxItem } from "./store";

const POLL_MS = 60_000;
/** RPC allows at most 5 topic filters per event filter. */
const TOPICS_PER_FILTER = 5;
const LAST_LEDGER_KEY = "lastLedger";

export interface InboxApi {
  /** Owner the items belong to; null when disconnected. */
  owner: string | null;
  items: InboxItem[];
  unread: number;
  status: "disconnected" | "loading" | "ready";
  /** False when IndexedDB is unavailable and items live in memory only. */
  persistent: boolean;
  markRead: (ids: string[]) => void;
  markAllRead: () => void;
  /** Record the user's own failed transaction (rejections are ignored). */
  recordTx: (tx: { hash: string | null; kind: string; marketId?: string; errorKind?: string; message?: string }) => void;
}

const InboxContext = createContext<InboxApi | null>(null);

const EMPTY: InboxApi = {
  owner: null,
  items: [],
  unread: 0,
  status: "disconnected",
  persistent: true,
  markRead: () => {},
  markAllRead: () => {},
  recordTx: () => {},
};

export function useInbox(): InboxApi {
  return useContext(InboxContext) ?? EMPTY;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Inbox scoped to the connected address and network (issue #42). The store
 * is reopened on every address change and the previous handle closed, so no
 * items leak across wallets.
 */
export function InboxProvider({ children }: { children: React.ReactNode }) {
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const tracker = useTxTracker();
  const network = NETWORK_PASSPHRASE;

  const [state, setState] = useState<{ owner: string | null; inbox: Inbox | null; items: InboxItem[] }>({
    owner: null,
    inbox: null,
    items: [],
  });
  const inboxRef = useRef<Inbox | null>(null);
  inboxRef.current = state.owner === address ? state.inbox : null;

  // Open the store for the current address; clear state first.
  useEffect(() => {
    setState({ owner: address, inbox: null, items: [] });
    if (!address) return;
    let cancelled = false;
    let opened: Inbox | null = null;
    openInbox(address, network).then(async (inbox) => {
      if (cancelled) {
        inbox.close();
        return;
      }
      opened = inbox;
      const items = await inbox.list().catch(() => []);
      if (!cancelled) setState({ owner: address, inbox, items });
    });
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [address, network]);

  const refresh = useCallback(async (inbox: Inbox, owner: string) => {
    const items = await inbox.list().catch(() => []);
    setState((prev) => (prev.owner === owner && prev.inbox === inbox ? { ...prev, items } : prev));
  }, []);

  const putItems = useCallback(
    async (list: (InboxItem | null)[]) => {
      const inbox = inboxRef.current;
      const owner = address;
      const items = list.filter((i): i is InboxItem => i !== null);
      if (!inbox || !owner || items.length === 0) return;
      try {
        await inbox.put(items);
        await inbox.prune(MAX_ITEMS);
      } catch {
        // Storage failure: keep going with what is already in memory.
      }
      await refresh(inbox, owner);
    },
    [address, refresh],
  );

  // Held markets: own fills plus non-zero positions already read into the cache.
  const heldMarketIds = useMemo(() => {
    const held = new Set<string>();
    for (const it of state.items) if (it.kind === "fill" && it.marketId) held.add(it.marketId);
    if (address) {
      for (const [key, data] of queryClient.getQueriesData<Stamped<Position>>({ queryKey: ["stellar", "position"] })) {
        const [, , id, holder] = key as [string, string, string, string];
        const pos = data?.value;
        if (holder === address && pos && pos.yes + pos.no > 0n) held.add(id);
      }
    }
    return held;
  }, [state.items, address, queryClient]);

  const heldRef = useRef(heldMarketIds);
  heldRef.current = heldMarketIds;

  const ctx = useMemo(() => (address ? { owner: address, network } : null), [address, network]);

  useRealtimeBatch(
    "TRADE_EXECUTED",
    useCallback((batch: readonly TradeExecutedPayload[]) => {
      if (!ctx) return;
      void putItems(batch.map((p) => classifyTrade(p, ctx)));
    }, [ctx, putItems]),
  );

  useRealtimeBatch(
    "REASONING_PUBLISHED",
    useCallback((batch: readonly ReasoningPublishedPayload[]) => {
      if (!ctx) return;
      void putItems(batch.map((p) => classifyTrace(p, heldRef.current, ctx)));
    }, [ctx, putItems]),
  );

  // Own transactions from the pending-transaction tracker (issue #3).
  useEffect(() => {
    if (!ctx) return;
    const mine = tracker.list.filter((t) => t.holder === ctx.owner && t.networkPassphrase === ctx.network);
    const items = mine
      .filter((t) => t.state === "pending" || t.state === "failed")
      .map((t) =>
        classifyTx(
          { hash: t.hash, kind: t.kind, state: t.state as "pending" | "failed", marketId: t.marketId, errorKind: t.error?.kind, message: t.error?.message },
          { ...ctx, now: t.submittedAt },
        ),
      );
    void putItems(items);
    // A pending item that settled is marked read so it stops counting.
    const settled = mine.filter((t) => t.state !== "pending").map((t) => `tx-pending:${t.hash}`);
    if (settled.length > 0 && inboxRef.current) {
      const inbox = inboxRef.current;
      void inbox.markRead(settled).then(() => refresh(inbox, ctx.owner)).catch(() => {});
    }
  }, [tracker.list, ctx, putItems, refresh, state.inbox]);

  // Resolution / redemption poller for held markets only.
  useEffect(() => {
    const inbox = state.inbox;
    if (!ctx || !inbox || state.owner !== ctx.owner) return;
    let cancelled = false;

    const positionOf = async (marketId: string): Promise<Position> =>
      read(await marketCore().get_position({ market_id: BigInt(marketId), holder: ctx.owner }));

    // Covers resolutions older than RPC retention: check status directly.
    const checkStatuses = async () => {
      const found: (InboxItem | null)[] = [];
      for (const id of heldRef.current) {
        try {
          const market = read(await marketCore().get_market({ market_id: BigInt(id) }));
          if (market.status.tag === "Open") continue;
          const outcome = market.status.tag === "Resolved" ? market.status.values[0].tag : null;
          found.push(
            classifyResolved(
              { id: `status:${id}`, ledger: 0, closedAt: new Date().toISOString(), marketId: id, outcome },
              await positionOf(id),
              ctx,
            ),
          );
        } catch {
          // Unreachable market or RPC error: try again next poll.
        }
      }
      if (!cancelled) await putItems(found);
    };

    const poll = async () => {
      if (document.hidden) return;
      try {
        const last = Number((await inbox.getMeta(LAST_LEDGER_KEY)) ?? 0);
        const held = [...heldRef.current];
        const found: (InboxItem | null)[] = [];
        let latest = last;

        for (const ids of chunk(held, TOPICS_PER_FILTER)) {
          const res = await fetchEventsSince(ids.map((id) => resolvedTopicFilter(BigInt(id))), last + 1);
          latest = Math.max(latest, res.latestLedger);
          for (const ev of res.events) {
            const decoded = decodeResolved(ev);
            found.push(classifyResolved(decoded, await positionOf(decoded.marketId), ctx));
          }
        }
        const redeemed = await fetchEventsSince([redeemedTopicFilter(ctx.owner)], last + 1);
        latest = Math.max(latest, redeemed.latestLedger);
        for (const ev of redeemed.events) found.push(classifyRedeemed(decodeRedeemed(ev), ctx));

        if (cancelled) return;
        await putItems(found);
        if (latest > last) await inbox.setMeta(LAST_LEDGER_KEY, String(latest));
      } catch {
        // RPC hiccup: the stored ledger is unchanged, so the next poll resumes.
      }
    };

    void checkStatuses().then(poll);
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ctx, state.inbox, state.owner, putItems]);

  const api = useMemo<InboxApi>(() => {
    if (!address) return EMPTY;
    const owned = state.owner === address;
    const items = owned ? state.items : [];
    const inbox = owned ? state.inbox : null;
    return {
      owner: address,
      items,
      unread: items.reduce((n, i) => (i.readAt === null ? n + 1 : n), 0),
      status: inbox ? "ready" : "loading",
      persistent: inbox?.persistent ?? true,
      markRead: (ids) => {
        if (!inbox || ids.length === 0) return;
        void inbox.markRead(ids).then(() => refresh(inbox, address)).catch(() => {});
      },
      markAllRead: () => {
        if (!inbox) return;
        void inbox.markAllRead().then(() => refresh(inbox, address)).catch(() => {});
      },
      recordTx: (tx) => {
        void putItems([classifyTx({ ...tx, state: "failed" }, { owner: address, network })]);
      },
    };
  }, [address, network, state, refresh, putItems]);

  return <InboxContext.Provider value={api}>{children}</InboxContext.Provider>;
}
