"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useInbox } from "@/lib/notifications/InboxProvider";
import type { InboxItem } from "@/lib/notifications/store";
import { useWallet } from "@/lib/contexts/WalletContext";
import { explorerTx, NETWORK_LABEL } from "@/lib/stellar/config";
import { formatUsdc } from "@/lib/stellar/units";

type Filter = "all" | "trades" | "redemptions" | "reasoning" | "transactions";
const group = (item: InboxItem): Exclude<Filter, "all"> => item.kind === "fill" ? "trades" : item.kind === "trace" ? "reasoning" : item.kind === "redeemable" || item.kind === "redeemed" ? "redemptions" : "transactions";
const labels: Record<Filter, string> = { all: "All", trades: "Trades", redemptions: "Redemptions", reasoning: "Reasoning", transactions: "Transactions" };
const title: Record<InboxItem["kind"], string> = { fill: "Trade confirmed", redeemable: "Ready to redeem", redeemed: "Shares redeemed", trace: "New market reasoning", "tx-failed": "Transaction failed", "tx-pending": "Transaction pending" };
function message(item: InboxItem) {
  const d = item.data;
  switch (item.kind) {
    case "fill": return `${d.action} ${formatUsdc(BigInt(d.sharesRaw), { maxDecimals: 2 })} ${d.direction} shares for ${formatUsdc(BigInt(d.collateralRaw), { maxDecimals: 7, grouping: true })} USDC.`;
    case "redeemable": return `Market #${item.marketId} ${d.outcome === "Void" ? "was voided" : `resolved ${d.outcome}`}. Review your payout and redeem your shares.`;
    case "redeemed": return `${formatUsdc(BigInt(d.payoutRaw), { maxDecimals: 7, grouping: true })} USDC paid to your wallet.`;
    case "trace": return `New reasoning on market #${item.marketId}: ${d.action}.`;
    default: return `${d.action}: ${d.message}`;
  }
}
export default function NotificationsPage() {
  const inbox = useInbox();
  const { address, openModal, isConnecting } = useWallet();
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => {
    const next: Record<Filter, number> = { all: inbox.items.length, trades: 0, redemptions: 0, reasoning: 0, transactions: 0 };
    inbox.items.forEach(item => next[group(item)]++);
    return next;
  }, [inbox.items]);
  const items = inbox.items.filter(item => filter === "all" || group(item) === filter);
  return <main className="flex-grow py-8 px-gutter max-w-container-max-width mx-auto w-full">
    <div className="flex flex-wrap gap-4 justify-between items-center mb-6">
      <div><h1 className="font-headline-md text-headline-md">Notifications</h1><p className="text-sm text-on-surface-variant mt-1">Your wallet activity on {NETWORK_LABEL}.</p></div>
      {address && <button type="button" onClick={() => void inbox.markAllRead()} disabled={!inbox.unread} className="text-primary text-sm underline disabled:opacity-50">Mark all read</button>}
    </div>
    {!address ? <section className="border border-outline-variant rounded-lg p-8 bg-surface-container-lowest">
      <h2 className="font-headline-sm text-headline-sm mb-2">Connect to see your inbox</h2>
      <p className="text-on-surface-variant text-sm mb-4">Your fills, redemptions, pending transactions, and reasoning on markets you hold appear here.</p>
      <button onClick={() => void openModal()} disabled={isConnecting} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{isConnecting ? "Connecting…" : "Connect wallet"}</button>
    </section> : <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside>
        <nav aria-label="Notification filters" className="space-y-1">{(Object.keys(labels) as Filter[]).map(key => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)} className={`w-full flex justify-between text-sm p-3 rounded ${key === filter ? "bg-surface-container-high text-primary font-bold" : "text-on-surface-variant hover:bg-surface-container"}`}><span>{labels[key]}</span><span>{counts[key]}</span></button>)}</nav>
        <p className="text-xs text-on-surface-variant leading-relaxed mt-6">Only your wallet&apos;s activity is shown. Read state is saved in this browser for this address and network. Showing the newest 200 items; up to 500 are saved.</p>
      </aside>
      <section aria-label="Wallet inbox" className="space-y-3">
        {inbox.status === "memory" && <p role="status" className="p-3 border border-outline-variant text-sm">Notifications won&apos;t be saved in this browser.</p>}
        {inbox.error && <p role="status" className="text-error text-sm">{inbox.error} Retrying while this tab is visible.</p>}
        {inbox.burst && <p className="text-xs text-on-surface-variant">{inbox.burst.count} network events received in a batch.{inbox.burst.overflow > 0 && ` ${inbox.burst.overflow} more events while this tab was hidden; open a market to refresh its history.`}</p>}
        {inbox.status === "loading" && <div role="status" className="p-6 bg-surface-container-low motion-safe:animate-pulse">Loading your inbox…</div>}
        {inbox.status !== "loading" && items.length === 0 && <p className="p-8 border border-dashed border-outline-variant rounded-lg text-sm text-on-surface-variant">No {filter === "all" ? "notifications" : labels[filter].toLowerCase()} yet. Your wallet&apos;s next activity will appear here.</p>}
        {items.map(item => <article key={item.id} className={`border rounded-lg p-4 ${item.readAt === null ? "border-primary bg-surface-container-lowest" : "border-outline-variant bg-surface"}`}>
          <div className="flex flex-wrap justify-between gap-2"><h2 className="font-bold text-sm">{title[item.kind]}{item.readAt === null && <span className="text-primary text-xs ml-2">Unread</span>}</h2><time dateTime={new Date(item.createdAt).toISOString()} className="text-xs text-on-surface-variant">{new Date(item.createdAt).toLocaleString()}</time></div>
          <p className="text-sm mt-2">{message(item)}</p>
          <div className="flex flex-wrap gap-4 mt-3 text-xs text-primary">
            {item.marketId && <Link className="underline" href={`/markets/quick-view?onChainId=${item.marketId}`}>View market #{item.marketId}</Link>}
            {item.kind === "trace" && item.data.traceId && <Link className="underline" href={`/reasoning/detail?traceId=${encodeURIComponent(item.data.traceId)}`}>Read reasoning</Link>}
            {item.txHash && <a className="underline" href={explorerTx(item.txHash)} target="_blank" rel="noreferrer">View transaction</a>}
            {item.readAt === null && <button type="button" onClick={() => void inbox.markRead([item.id])} className="underline">Mark read</button>}
          </div>
        </article>)}
      </section>
    </div>}
  </main>;
}
