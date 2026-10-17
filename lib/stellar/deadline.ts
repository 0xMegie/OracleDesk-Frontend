export const DEFAULT_TX_TIMEOUT_S = 60;
export const SAFETY_MARGIN_S = 10;
export const MIN_TX_TIMEOUT_S = 15;

export type WriteKind = "buy" | "sell" | "redeem" | "transfer";

export interface TransactionDeadline {
  timeoutInSeconds: number;
  maxTime: number;
}

export function deadlineFor(
  kind: WriteKind,
  ledgerNow: number | null,
  closeTime?: bigint,
): TransactionDeadline {
  if (ledgerNow === null || !Number.isFinite(ledgerNow) || ledgerNow < 0) {
    throw new Error("Stellar ledger time is unavailable.");
  }

  if ((kind === "buy" || kind === "sell") && closeTime !== undefined) {
    const now = Math.floor(ledgerNow);
    const lastSafeSecond = closeTime - BigInt(SAFETY_MARGIN_S);
    const remaining = lastSafeSecond - BigInt(now);
    if (remaining < BigInt(MIN_TX_TIMEOUT_S)) {
      throw new Error("This market closes in under 25 seconds, too soon to safely place a trade.");
    }
    const timeoutInSeconds = Math.min(DEFAULT_TX_TIMEOUT_S, Number(remaining));
    return { timeoutInSeconds, maxTime: now + timeoutInSeconds };
  }

  const now = Math.floor(ledgerNow);
  return { timeoutInSeconds: DEFAULT_TX_TIMEOUT_S, maxTime: now + DEFAULT_TX_TIMEOUT_S };
}

export function assertSigningDeadline(deadline: TransactionDeadline, ledgerNow: number | null): void {
  if (ledgerNow === null || Math.floor(ledgerNow) >= deadline.maxTime - 5) {
    throw new Error("Signing took too long; the transaction would expire. Try again.");
  }
}
