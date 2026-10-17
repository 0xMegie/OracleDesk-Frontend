import { BPS, calcSell, MathError } from "./generated/fpmm";

export interface SellSolution {
  collateralOut: bigint;
  sharesIn: bigint;
  dust: bigint;
  iterations: number;
}

export type SellSolveError = { error: "insufficient-liquidity" | "too-small" };

/**
 * calcSell's sharesIn is monotone: gross is non-decreasing in collateralOut;
 * as gross grows, rOther - gross shrinks and ceil(rSold*rOther/(rOther-gross))
 * cannot decrease. Their sum with gross therefore cannot decrease.
 */
export function solveSellForShares(
  rSold: bigint,
  rOther: bigint,
  shareBudget: bigint,
  feeBps: bigint,
): SellSolution | SellSolveError {
  if (rSold <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS) {
    return { error: "insufficient-liquidity" };
  }
  if (shareBudget <= 0n) return { error: "too-small" };

  // For calcSell to remain liquid, gross must be at most rOther - 1.
  const maxCollateralOut = ((rOther - 1n) * (BPS - feeBps)) / BPS;
  if (maxCollateralOut <= 0n) return { error: "insufficient-liquidity" };

  let low = 0n;
  let high = maxCollateralOut + 1n;
  let iterations = 0;

  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    iterations++;
    try {
      if (calcSell(rSold, rOther, mid, feeBps).sharesIn <= shareBudget) low = mid;
      else high = mid;
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
      high = mid;
    }
  }

  if (low === 0n) return { error: "too-small" };
  const sharesIn = calcSell(rSold, rOther, low, feeBps).sharesIn;
  return { collateralOut: low, sharesIn, dust: shareBudget - sharesIn, iterations };
}

/**
 * Confirm the local math against quote_sell. A caller can refetch reserves
 * and re-solve when the quoted share count differs.
 */
export async function reconcileWithQuote(
  local: SellSolution,
  quote: (collateralOut: bigint) => Promise<bigint>,
): Promise<SellSolution> {
  const sharesIn = await quote(local.collateralOut);
  if (sharesIn === local.sharesIn) return local;
  return {
    ...local,
    sharesIn,
    dust: local.dust + local.sharesIn - sharesIn,
  };
}
