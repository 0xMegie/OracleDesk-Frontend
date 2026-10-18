import type { ReactNode } from "react";
import { explorerTx } from "@/lib/stellar/config";
import type { Stamped } from "@/lib/stellar/optimistic";

export function PendingValue({ state, fallback = null }: { state: Stamped<unknown> | undefined; fallback?: ReactNode }) {
  const pending = state?.provisional ?? state?.awaitingRpc;
  if (!pending) return fallback;
  const label = state?.awaitingRpc ? "awaiting RPC" : "pending confirmation";
  return <span className="ml-2 text-xs text-on-surface-variant" role="status">{pending.txHash
    ? <a className="underline" href={explorerTx(pending.txHash)} target="_blank" rel="noreferrer">{label}</a> : label}</span>;
}
