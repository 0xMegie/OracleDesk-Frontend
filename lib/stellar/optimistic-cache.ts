import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { applyBuy, applySell, applyRedeem, balanceDelta, type Stamped, type TradeKind } from "./optimistic";
import type { Position } from "./generated/market-core";
import type { OutcomeTag } from "./clients";

export const positionKey = (id: string, holder: string) => ["stellar", "position", id, holder] as const;
export const balanceKey = (holder: string) => ["stellar", "usdcBalance", holder] as const;
interface ReconcileJob { timer?: ReturnType<typeof setTimeout>; stop(): void }
const timers = new WeakMap<QueryClient, Map<string, ReconcileJob>>();

/** One retry schedule per key. Replacements and disconnects dispose timers and subscriptions. */
export function scheduleReconcile(client: QueryClient, key: QueryKey) {
  let jobs = timers.get(client);
  if (!jobs) { jobs = new Map(); timers.set(client, jobs); }
  const id = JSON.stringify(key);
  jobs.get(id)?.stop();
  const expectedQuery = client.getQueryCache().find({ queryKey: key, exact: true });
  if (!expectedQuery) return;
  let attempt = 0;
  const job: ReconcileJob = { stop() { clearTimeout(job.timer); unsubscribe(); if (jobs.get(id) === job) jobs.delete(id); } };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type === "removed" && event.query === expectedQuery) job.stop();
  });
  jobs.set(id, job);
  async function retry() {
    if (jobs!.get(id) !== job || client.getQueryCache().find({ queryKey: key, exact: true }) !== expectedQuery) { job.stop(); return; }
    await client.invalidateQueries({ queryKey: key, exact: true });
    if (jobs!.get(id) !== job) return;
    const current = client.getQueryData<Stamped<unknown>>(key);
    if (!current?.provisional) { job.stop(); return; }
    attempt++;
    if (attempt < 3) job.timer = setTimeout(retry, [1000, 2000, 5000][attempt]);
    else {
      client.setQueryData(key, { ...current, provisional: undefined, awaitingRpc: current.provisional });
      job.stop();
    }
  }
  job.timer = setTimeout(retry, 1000);
}

export async function cancelTradeReads(client: QueryClient, marketId: string, holder: string) {
  const keys = [positionKey(marketId, holder), balanceKey(holder)];
  await Promise.all(keys.map(queryKey => client.cancelQueries({ queryKey, exact: true })));
  // No speculative changes happen before confirmation, so rejection needs no rollback.
  return { holder, position: client.getQueryData<Stamped<Position>>(keys[0]), balance: client.getQueryData<Stamped<bigint>>(keys[1]) };
}

export function confirmTrade(client: QueryClient, params: {
  kind: TradeKind; marketId: string; holder: string; ledger: number | null; txHash: string | null;
  outcome?: OutcomeTag; sharesOut?: bigint; sharesSold?: bigint; collateralIn?: bigint; collateralOut?: bigint; payout?: bigint;
}) {
  const { marketId, holder, ledger, txHash, kind } = params;
  const keys = [positionKey(marketId, holder), balanceKey(holder)];
  if (ledger === null) { keys.forEach(queryKey => { void client.invalidateQueries({ queryKey }); }); return; }
  const provisional = { ledger, txHash, kind };
  // Reading the current cache composes concurrent confirmations. A cache already
  // stamped at this ledger includes this transaction and must not receive it twice.
  const update = <T>(key: QueryKey, apply: (v: T) => T) => {
    client.setQueryData<Stamped<T>>(key, previous => {
      const pending = previous?.provisional ?? previous?.awaitingRpc;
      if (pending?.txHash && pending.txHash === txHash) return previous;
      if (!previous || (previous.ledger >= ledger && !previous.provisional && !previous.awaitingRpc)) return previous;
      if (previous.ledger > ledger) return previous;
      try { return { value: apply(previous.value), ledger, provisional }; }
      catch { void client.invalidateQueries({ queryKey: key }); return previous; }
    });
    scheduleReconcile(client, key);
  };
  update<Position>(keys[0], p => kind === "buy" ? applyBuy(p, params.outcome!, params.sharesOut!) : kind === "sell" ? applySell(p, params.outcome!, params.sharesSold!) : applyRedeem());
  update<bigint>(keys[1], value => {
    const next = value + balanceDelta(kind, params);
    if (next < 0n) throw new Error("Insufficient cached balance");
    return next;
  });
}
