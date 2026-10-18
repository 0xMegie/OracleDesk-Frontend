"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useInbox } from "@/lib/notifications/InboxProvider";
import type { InboxItem, InboxKind } from "@/lib/notifications/store";
import { explorerTx, NETWORK_LABEL } from "@/lib/stellar/config";
import { formatUsdc } from "@/lib/stellar/units";

type Filter = "all" | "trades" | "redemptions" | "reasoning" | "transactions";

const FILTER_OF: Record<InboxKind, Exclude<Filter, "all">> = {
  fill: "trades",
  redeemable: "redemptions",
  redeemed: "redemptions",
  trace: "reasoning",
  "tx-failed": "transactions",
  "tx-pending": "transactions",
};

const FILTERS: { type: Filter; label: string; icon: string }[] = [
  { type: "all", label: "All", icon: "dashboard" },
  { type: "trades", label: "Trades", icon: "payments" },
  { type: "redemptions", label: "Redemptions", icon: "redeem" },
  { type: "reasoning", label: "Reasoning", icon: "psychology" },
  { type: "transactions", label: "Transactions", icon: "receipt_long" },
];

/** Live items rendered at once; the store itself keeps up to 500 per wallet. */
const RENDER_CAP = 200;
/** An item counts as read after this long fully in view. 0 disables it. */
const AUTO_READ_MS = 1_000;

const usdc = (raw: string | undefined) => {
  if (!raw || !/^\d+$/.test(raw)) return "—";
  return formatUsdc(BigInt(raw), { maxDecimals: 2, grouping: true });
};

interface View {
  title: string;
  message: string;
  icon: string;
  tone: string;
  border: string;
}

function describe(item: InboxItem): View {
  const market = item.data.marketQuestion ? `"${item.data.marketQuestion}"` : `market #${item.marketId}`;
  switch (item.kind) {
    case "fill":
      return {
        title: item.data.side === "buy" ? "Buy filled" : "Sell filled",
        message: `${item.data.side === "buy" ? "Bought" : "Sold"} ${usdc(item.data.sharesRaw)} ${item.data.direction} shares on ${market} for ${usdc(item.data.collateralRaw)} USDC.`,
        icon: "check_circle",
        tone: "text-secondary",
        border: "border-l-secondary",
      };
    case "redeemable":
      return {
        title: item.data.outcome === "void" ? "Market voided — redeemable" : "Market resolved — redeemable",
        message:
          item.data.outcome === "void"
            ? `Market #${item.marketId} was voided. Each side redeems at half value.`
            : `Market #${item.marketId} resolved ${String(item.data.outcome).toUpperCase()}. You hold ${usdc(item.data.yes)} YES · ${usdc(item.data.no)} NO.`,
        icon: "redeem",
        tone: "text-primary",
        border: "border-l-primary",
      };
    case "redeemed":
      return {
        title: "Redeemed",
        message: `Redeemed market #${item.marketId} for ${usdc(item.data.payoutRaw)} USDC.`,
        icon: "savings",
        tone: "text-secondary",
        border: "border-l-secondary",
      };
    case "trace":
      return {
        title: "New agent reasoning",
        message: `Trace #${item.data.onChainTraceId} (${item.data.action || "update"}) was published on market #${item.marketId}, which you hold.`,
        icon: "psychology",
        tone: "text-primary",
        border: "border-l-primary",
      };
    case "tx-failed":
      return {
        title: "Transaction failed",
        message: `Your ${item.data.action} ${item.marketId ? `on market #${item.marketId} ` : ""}failed${item.data.message ? `: ${item.data.message}` : "."}`,
        icon: "error",
        tone: "text-tertiary",
        border: "border-l-tertiary",
      };
    case "tx-pending":
      return {
        title: "Transaction pending",
        message: `Your ${item.data.action} ${item.marketId ? `on market #${item.marketId} ` : ""}is waiting for a ledger.`,
        icon: "hourglass_top",
        tone: "text-on-surface-variant",
        border: "border-l-outline",
      };
  }
}

function NotificationRow({ item, onRead }: { item: InboxItem; onRead: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const unread = item.readAt === null;
  const view = describe(item);

  // Mark read only after the item has been fully visible for AUTO_READ_MS.
  useEffect(() => {
    const el = ref.current;
    if (!unread || !el || AUTO_READ_MS <= 0 || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.99) {
          timer ??= setTimeout(() => onRead(item.id), AUTO_READ_MS);
        } else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [unread, item.id, onRead]);

  return (
    <div
      ref={ref}
      className={`group bg-surface-container-lowest border-l-4 ${view.border} border-y border-r border-outline-variant p-4 rounded-r flex gap-4 shadow-sm ${unread ? "" : "opacity-75"}`}
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-surface-container flex items-center justify-center">
        <span className={`material-symbols-outlined ${view.tone}`} aria-hidden="true">{view.icon}</span>
      </div>
      <div className="flex-grow min-w-0">
        <div className="flex justify-between items-start gap-2">
          <h3 className={`font-headline-sm text-headline-sm ${view.tone}`}>
            {unread && <span className="sr-only">Unread: </span>}
            {view.title}
          </h3>
          <span className="font-data-mono text-data-mono text-on-surface-variant text-[12px] whitespace-nowrap" title={item.ledger ? `Ledger ${item.ledger}` : "Receipt time"}>
            {new Date(item.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <p className="text-body-md mt-1 text-on-surface break-words">{view.message}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {item.marketId && (
            <Link href={`/markets/quick-view?onChainId=${item.marketId}`} className="text-xs text-primary font-bold hover:underline">
              {item.kind === "redeemable" ? "Redeem" : "Open market"}
            </Link>
          )}
          {item.txHash && (
            <a href={explorerTx(item.txHash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:opacity-80">
              <span className="text-xs font-data-mono bg-surface-container px-2 py-0.5 rounded text-on-surface-variant">TX: {item.txHash.substring(0, 10)}…</span>
              <span className="material-symbols-outlined text-xs text-primary" aria-hidden="true">open_in_new</span>
            </a>
          )}
          {unread && (
            <button type="button" onClick={() => onRead(item.id)} className="text-xs text-on-surface-variant hover:text-primary hover:underline">
              Mark read
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  const inbox = useInbox();
  const [filter, setFilter] = useState<Filter>("all");
  const { markRead } = inbox;
  const onRead = useMemo(() => (id: string) => markRead([id]), [markRead]);

  // One pass for all filter counts.
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, trades: 0, redemptions: 0, reasoning: 0, transactions: 0 };
    for (const item of inbox.items) {
      c.all++;
      c[FILTER_OF[item.kind]]++;
    }
    return c;
  }, [inbox.items]);

  const visible = useMemo(
    () => inbox.items.filter((i) => filter === "all" || FILTER_OF[i.kind] === filter).slice(0, RENDER_CAP),
    [inbox.items, filter],
  );

  return (
    <main className="flex-grow pt-8 pb-12 px-gutter max-w-container-max-width mx-auto w-full">
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-3 space-y-6">
          <div className="bg-surface-container-lowest border border-outline-variant p-4 rounded shadow-sm">
            <h2 className="font-headline-sm text-headline-sm mb-4">Inbox</h2>
            <div className="space-y-1">
              {FILTERS.map((btn) => (
                <button
                  key={btn.type}
                  type="button"
                  onClick={() => setFilter(btn.type)}
                  aria-pressed={filter === btn.type}
                  className={`w-full flex items-center justify-between p-2 rounded transition-all duration-200 cursor-pointer ${
                    filter === btn.type ? "text-primary bg-surface-container-low font-bold" : "text-on-surface-variant hover:bg-surface-container"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{btn.icon}</span>
                    {btn.label}
                  </span>
                  <span className="text-xs bg-surface-container-high px-2 py-0.5 rounded-full">{counts[btn.type]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="bg-surface-container-low border border-outline-variant p-4 rounded bg-gradient-to-br from-[#f0f9fa] to-[#e0f2f4]">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden="true">
                info
              </span>
              <span className="font-label-caps text-label-caps text-primary">WHAT SHOWS UP HERE</span>
            </div>
            <p className="text-body-md text-on-surface-variant leading-relaxed">
              Only events for your connected wallet on {NETWORK_LABEL}: your own fills, markets you hold resolving or being voided,
              your redemptions, new agent reasoning on markets you hold, and your failed or pending transactions. Read state is
              saved in this browser.
            </p>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-9 space-y-4">
          <div className="flex justify-between items-center mb-2">
            <h1 className="font-headline-md text-headline-md">Notifications</h1>
            {inbox.owner && (
              <button
                type="button"
                onClick={inbox.markAllRead}
                disabled={inbox.unread === 0}
                className="text-primary font-label-caps text-label-caps hover:underline cursor-pointer disabled:opacity-50 disabled:no-underline"
              >
                Mark all read
              </button>
            )}
          </div>

          {inbox.owner && !inbox.persistent && (
            <p className="text-xs text-on-surface-variant bg-surface-container px-3 py-2 rounded" role="status">
              Notifications won&apos;t be saved in this browser.
            </p>
          )}

          {inbox.status === "disconnected" ? (
            <div className="text-center py-12 bg-white border border-dashed border-outline-variant rounded-lg">
              <p className="text-on-surface-variant">Connect your wallet (top right) to see notifications for your address.</p>
            </div>
          ) : inbox.status === "loading" ? (
            <div className="text-center py-12 bg-white border border-dashed border-outline-variant rounded-lg" aria-busy="true">
              <p className="text-on-surface-variant">Loading your inbox…</p>
            </div>
          ) : (
            <div className="space-y-3">
              {visible.map((item) => (
                <NotificationRow key={item.id} item={item} onRead={onRead} />
              ))}
              {visible.length === 0 && (
                <div className="text-center py-12 bg-white border border-dashed border-outline-variant rounded-lg">
                  <p className="text-on-surface-variant">Nothing here yet. Your fills, redemptions and transactions will show up here.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
