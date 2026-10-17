import { Errors as MarketCoreErrors } from "./generated/market-core";
import { Errors as TreasuryErrors } from "./generated/treasury";
import { Errors as ResolverErrors } from "./generated/resolver";
import { Errors as ReasoningRegistryErrors } from "./generated/reasoning-registry";

export type ContractName = "marketCore" | "treasury" | "resolver" | "reasoningRegistry";

const TABLES: Record<ContractName, Record<number, { message: string }>> = {
  marketCore: MarketCoreErrors,
  treasury: TreasuryErrors,
  resolver: ResolverErrors,
  reasoningRegistry: ReasoningRegistryErrors,
};

/** Plain-language messages for contract error names, from the user's point of view. */
const FRIENDLY: Record<string, string> = {
  // market-core
  Paused: "Trading is paused right now. Try again later.",
  InvalidAmount: "Enter an amount greater than zero.",
  MarketNotFound: "This market doesn't exist on-chain.",
  MarketNotOpen: "This market is no longer open for trading.",
  MarketClosed: "This market has closed. Trading has stopped.",
  NotClosedYet: "This market hasn't closed yet.",
  NotFinal: "This market hasn't been resolved yet.",
  SlippageExceeded: "The price moved before your trade went through. Try again or allow more slippage.",
  InsufficientShares: "You don't have enough shares for this sale.",
  InsufficientLiquidity: "There isn't enough liquidity in this market for that amount.",
  MarketTooLarge: "This trade would take the market past its size limit.",
  NothingToRedeem: "You have nothing to redeem in this market.",
  AlreadyClaimed: "This has already been claimed.",
  Overflow: "That amount is too large.",
  // treasury
  TradeCapExceeded: "This trade is above the treasury's per-trade limit.",
  MarketCapExceeded: "The treasury has reached its limit for this market.",
  DailyCapExceeded: "The treasury has reached its daily limit.",
  InsufficientBalance: "The treasury doesn't have enough funds for this.",
  // resolver
  MarketNotConfigured: "This market's resolution rule hasn't been revealed yet.",
  SpecHashMismatch: "That resolution rule doesn't match what this market committed to.",
  DisputeWindowOpen: "The dispute window is still open.",
  // reasoning-registry
  TraceNotFound: "This reasoning trace isn't on-chain.",
  Unauthorized: "Your wallet isn't allowed to do this.",
};

export interface DescribedError {
  kind: "rejected" | "insufficient-balance" | "no-trustline" | "low-reserve" | "contract" | "wrong-network" | "disconnected" | "network" | "unknown";
  message: string;
  action?: "enable-usdc";
  /** Contract error name, e.g. "SlippageExceeded", when known. */
  code?: string;
}

function textOf(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return `${err.message} ${(err as Error & { cause?: unknown }).cause ?? ""}`;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    // Stellar Wallets Kit errors are { code, message }; SDK Err is { error: { message } }.
    return [o.message, (o.error as { message?: string } | undefined)?.message, safeJson(err)].filter(Boolean).join(" ");
  }
  return String(err);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Turns anything thrown by the SDK, a binding or a wallet into a message for the user. */
export function describeError(err: unknown, contract: ContractName = "marketCore"): DescribedError {
  const text = textOf(err);

  if (/user (rejected|declined|denied)|rejected by (the )?user|request (was )?rejected|declined|cancell?ed by user|user closed/i.test(text)) {
    return { kind: "rejected", message: "You cancelled the request in your wallet." };
  }
  if (/trustline entry is missing|TrustlineMissing|trustline.*(missing|not found)|op_no_trust/i.test(text)) {
    return {
      kind: "no-trustline",
      message: "Your account has no USDC trustline. Add the USDC asset in your wallet first.",
      action: "enable-usdc",
    };
  }
  if (/op_low_reserve|opLowReserve|txInsufficientBalance|tx_insufficient_balance/i.test(text)) {
    return { kind: "low-reserve", message: "Your account needs more spendable XLM to add the USDC trustline." };
  }
  if (/balance is not sufficient|resulting balance is not within the allowed range|insufficient (balance|funds)|BalanceError|op_underfunded/i.test(text)) {
    return { kind: "insufficient-balance", message: "You don't have enough USDC for this." };
  }
  if (/wrong network|network mismatch/i.test(text)) {
    return { kind: "wrong-network", message: "Switch your wallet to Stellar Testnet and try again." };
  }

  const code = /Error\(Contract, #(\d+)\)/.exec(text);
  if (code) {
    const name = TABLES[contract][Number(code[1])]?.message;
    if (name) return { kind: "contract", code: name, message: FRIENDLY[name] ?? `The contract rejected this (${name}).` };
    return { kind: "contract", message: `The contract rejected this (error ${code[1]}).` };
  }
  // A binding Err may carry just the name.
  const named = Object.keys(FRIENDLY).find((n) => new RegExp(`\\b${n}\\b`).test(text));
  if (named) return { kind: "contract", code: named, message: FRIENDLY[named] };

  if (/Failed to fetch|NetworkError|ECONNREFUSED|timed? ?out|ETIMEDOUT/i.test(text)) {
    return { kind: "network", message: "Couldn't reach the Stellar network. Check your connection and try again." };
  }
  return { kind: "unknown", message: "Something went wrong. Please try again." };
}

/** Thrown by write hooks so callers get a readable message in `error.message`. */
export class UserFacingError extends Error {
  constructor(public readonly described: DescribedError, public readonly original?: unknown) {
    super(described.message);
    this.name = "UserFacingError";
  }
}
