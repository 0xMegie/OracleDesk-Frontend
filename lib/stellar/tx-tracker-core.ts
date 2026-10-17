import type { rpc } from "@stellar/stellar-sdk";
import { describeError, type ContractName } from "./errors";

export type TrackedKind = "buy" | "sell" | "redeem" | "usdc-transfer";

export interface TrackedTx {
  /** Lowercase 64-char hex transaction hash */
  hash: string;
  kind: TrackedKind;
  /** G-address of the account that signed */
  holder: string;
  marketId?: string;
  outcome?: "Yes" | "No";
  /** Bigint amounts represented as base-10 decimal strings */
  amounts: Record<string, string>;
  networkPassphrase: string;
  /** Epoch milliseconds at submit time */
  submittedAt: number;
  state: "pending" | "confirmed" | "failed" | "expired";
  ledger?: number;
  maxTime?: number;
  mayNotHaveBeenSent?: boolean;
  error?: { kind: string; message: string; code?: string };
  followUp?: { type: "unlock-daily-pass"; traceId: string; amountRaw: string };
}

export const STORAGE_KEY = "oracledesk_pending_txs";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Computes the query keys to invalidate when a trade confirms. */
export function tradeInvalidationKeys(marketId: string, holder: string) {
  return [
    ["stellar", "market", marketId] as const,
    ["stellar", "markets"] as const,
    ["stellar", "position", marketId, holder] as const,
    ["stellar", "usdcBalance", holder] as const,
  ];
}

/** Converts bigint values into decimal strings for serialization. */
export function toRecord(amounts: Record<string, bigint>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(amounts)) {
    result[key] = val.toString(10);
  }
  return result;
}

/** Converts serialized decimal strings back into bigints without precision loss. */
export function fromRecord(amounts: Record<string, string>): Record<string, bigint> {
  const result: Record<string, bigint> = {};
  for (const [key, val] of Object.entries(amounts)) {
    result[key] = BigInt(val);
  }
  return result;
}

/** Validates that a parsed item matches TrackedTx shape and is within the 24h validity window. */
export function isValidRecord(item: unknown, currentNetworkPassphrase: string, now = Date.now()): item is TrackedTx {
  if (!item || typeof item !== "object") return false;
  const o = item as Partial<TrackedTx>;

  if (typeof o.hash !== "string" || !/^[a-f0-9]{64}$/i.test(o.hash)) return false;
  if (!["buy", "sell", "redeem", "usdc-transfer"].includes(o.kind as string)) return false;
  if (typeof o.holder !== "string" || o.holder.length < 50) return false;
  if (!o.amounts || typeof o.amounts !== "object") return false;
  for (const val of Object.values(o.amounts)) {
    if (typeof val !== "string" || !/^-?\d+$/.test(val)) return false;
  }
  if (o.networkPassphrase !== currentNetworkPassphrase) return false;
  if (typeof o.submittedAt !== "number" || isNaN(o.submittedAt)) return false;
  if (now - o.submittedAt > TWENTY_FOUR_HOURS_MS || o.submittedAt - now > 60_000) return false;
  if (!["pending", "confirmed", "failed", "expired"].includes(o.state as string)) return false;

  return true;
}

/** Safely reads records from storage, filtering out stale/invalid entries. */
export function loadRecords(storage: Storage | null, networkPassphrase: string, now = Date.now()): TrackedTx[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TrackedTx => isValidRecord(item, networkPassphrase, now));
  } catch {
    return [];
  }
}

/** Safely writes records to storage. */
export function saveRecords(storage: Storage | null, records: TrackedTx[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // SessionStorage full or unavailable
  }
}

/** Merges records from multiple writers/tabs by transaction hash. */
export function mergeRecords(existing: TrackedTx[], incoming: TrackedTx[]): TrackedTx[] {
  const map = new Map<string, TrackedTx>();

  for (const r of existing) {
    map.set(r.hash.toLowerCase(), r);
  }

  for (const r of incoming) {
    const key = r.hash.toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
    } else {
      // Final states take precedence over pending
      const isFinal = (s: TrackedTx["state"]) => s === "confirmed" || s === "failed" || s === "expired";
      const state = isFinal(r.state) ? r.state : prev.state;
      map.set(key, {
        ...prev,
        ...r,
        state,
        ledger: r.ledger ?? prev.ledger,
        error: r.error ?? prev.error,
        followUp: r.followUp ?? prev.followUp,
        mayNotHaveBeenSent: r.mayNotHaveBeenSent ?? prev.mayNotHaveBeenSent,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.submittedAt - a.submittedAt);
}

/** Evaluates a single transaction's updated state from an RPC getTransaction response. */
export function evaluateTxStatus(
  record: TrackedTx,
  res: rpc.Api.GetTransactionResponse,
  contract: ContractName = "marketCore",
): TrackedTx {
  if (res.status === "SUCCESS") {
    return {
      ...record,
      state: "confirmed",
      ledger: res.ledger ?? res.latestLedger,
    };
  }

  if (res.status === "FAILED") {
    const fullErr = `${res.resultXdr ? String(res.resultXdr) : ""} ${res.resultMetaXdr ? String(res.resultMetaXdr) : ""}`;
    const described = describeError(fullErr || "Transaction failed", contract);
    return {
      ...record,
      state: "failed",
      error: { kind: described.kind, message: described.message, code: described.code },
    };
  }

  if (res.status === "NOT_FOUND") {
    // If transaction had a time bound and latest ledger close time is past it
    if (record.maxTime && res.latestLedgerCloseTime && res.latestLedgerCloseTime > record.maxTime) {
      return {
        ...record,
        state: "expired",
        mayNotHaveBeenSent: true,
        error: {
          kind: "expired",
          message: "Transaction expired without landing on-chain (may not have been sent).",
        },
      };
    }
  }

  return record;
}
