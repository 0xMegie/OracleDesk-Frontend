import type { Market, Position } from "./generated/market-core";
import { Errors } from "./generated/market-core";
import { calcBuy, calcSell, MAX_SETS } from "./generated/fpmm";
import { FRIENDLY } from "./errors";
import type { OutcomeTag } from "./clients";

export type PreflightCode =
  | "Paused"
  | "MarketNotFound"
  | "MarketNotOpen"
  | "MarketClosed"
  | "NotFinal"
  | "InvalidAmount"
  | "InsufficientLiquidity"
  | "MarketTooLarge"
  | "InsufficientShares"
  | "NothingToRedeem"
  | "InsufficientBalance";

export interface PreflightFailure {
  code: PreflightCode;
  message: string;
  contractErrorNumber?: number;
}

export type Preflight =
  | { ok: true }
  | { ok: false; failures: PreflightFailure[] }
  | { ok: "unknown"; missing: string[] };

export interface PreflightInput {
  config?: { paused: boolean };
  market?: Market;
  marketIsStale?: boolean;
  /** Set only when the on-chain read explicitly returned MarketNotFound. */
  marketNotFound?: boolean;
  ledgerNow?: bigint;
  position?: Position;
  positionIsStale?: boolean;
  usdcBalance?: bigint;
}

const ERROR_NUMBERS = new Map(
  Object.entries(Errors).map(([number, value]) => [value.message, Number(number)] as const),
);

function failure(code: PreflightCode): PreflightFailure {
  return {
    code,
    message: FRIENDLY[code] ?? `The contract would reject this (${code}).`,
    ...(ERROR_NUMBERS.has(code) ? { contractErrorNumber: ERROR_NUMBERS.get(code) } : {}),
  };
}

function result(failures: PreflightFailure[], missing: string[]): Preflight {
  if (failures.length) return { ok: false, failures };
  return missing.length ? { ok: "unknown", missing: [...new Set(missing)] } : { ok: true };
}

function commonTradeFailures(input: PreflightInput, missing: string[]): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  if (input.config?.paused) failures.push(failure("Paused"));
  else if (!input.config) missing.push("protocol status");

  if (input.marketNotFound) failures.push(failure("MarketNotFound"));
  else if (input.marketIsStale) missing.push("fresh market");
  else if (!input.market) missing.push("market");
  else if (input.market.status.tag !== "Open") failures.push(failure("MarketNotOpen"));

  if (input.market && !input.marketIsStale && input.ledgerNow === undefined) missing.push("ledger time");
  else if (
    input.market &&
    !input.marketIsStale &&
    input.ledgerNow !== undefined &&
    input.ledgerNow >= input.market.close_time
  ) {
    failures.push(failure("MarketClosed"));
  }
  return failures;
}

export function preflightBuy(input: PreflightInput, outcome: OutcomeTag, collateralIn: bigint): Preflight {
  const missing: string[] = [];
  const failures = commonTradeFailures(input, missing);
  let mathResult: ReturnType<typeof calcBuy> | undefined;

  if (collateralIn <= 0n) {
    failures.push(failure("InvalidAmount"));
  } else if (input.market && !input.marketIsStale) {
    const [rBought, rOther] =
      outcome === "Yes"
        ? [input.market.reserve_yes, input.market.reserve_no]
        : [input.market.reserve_no, input.market.reserve_yes];
    try {
      mathResult = calcBuy(rBought, rOther, collateralIn, BigInt(input.market.fee_bps));
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid input")) failures.push(failure("InvalidAmount"));
      else missing.push("market reserves");
    }

    if (mathResult) {
      const newSets = input.market.sets_minted + mathResult.net;
      const difference = newSets - MAX_SETS;
      if (difference > 0n) {
        if (input.marketIsStale && difference === 1n) missing.push("fresh market size");
        else failures.push(failure("MarketTooLarge"));
      }
    }
  } else if (!input.marketIsStale) {
    missing.push("market reserves");
  }

  if (input.usdcBalance === undefined) missing.push("USDC balance");
  else if (input.usdcBalance < collateralIn) failures.push(failure("InsufficientBalance"));

  return result(failures, missing);
}

export function preflightSell(
  input: PreflightInput,
  outcome: OutcomeTag,
  collateralOut: bigint,
  sharesIn: bigint,
): Preflight {
  const missing: string[] = [];
  const failures = commonTradeFailures(input, missing);
  if (input.market && !input.marketIsStale) {
    const [rSold, rOther] =
      outcome === "Yes"
        ? [input.market.reserve_yes, input.market.reserve_no]
        : [input.market.reserve_no, input.market.reserve_yes];
    try {
      calcSell(rSold, rOther, collateralOut, BigInt(input.market.fee_bps));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("insufficient liquidity")) failures.push(failure("InsufficientLiquidity"));
      else if (message.includes("invalid input")) failures.push(failure("InvalidAmount"));
      else missing.push("market reserves");
    }
  } else if (!input.marketIsStale) {
    missing.push("market reserves");
  }
  if (input.position === undefined) missing.push("position");
  else if ((outcome === "Yes" ? input.position.yes : input.position.no) < sharesIn) {
    if (input.positionIsStale) missing.push("fresh position");
    else failures.push(failure("InsufficientShares"));
  }
  return result(failures, missing);
}

export function preflightRedeem(input: PreflightInput): Preflight {
  const missing: string[] = [];
  const failures: PreflightFailure[] = [];
  if (input.marketNotFound) failures.push(failure("MarketNotFound"));
  else if (input.marketIsStale) missing.push("fresh market");
  else if (!input.market) missing.push("market");
  else if (input.market.status.tag === "Open") failures.push(failure("NotFinal"));

  if (input.position === undefined) missing.push("position");
  else if (input.position.yes === 0n && input.position.no === 0n) {
    if (input.positionIsStale) missing.push("fresh position");
    else failures.push(failure("NothingToRedeem"));
  }

  return result(failures, missing);
}
