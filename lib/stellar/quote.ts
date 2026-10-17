import type { Market } from "./generated/market-core";
import { BPS, calcBuy, MAX_SETS, MathError } from "./generated/fpmm";
import type { OutcomeTag } from "./clients";

export type ExactBuy =
  | { ok: true; collateralIn: bigint; sharesOut: bigint; overshoot: bigint; fee: bigint; net: bigint }
  | { ok: false; reason: "invalid-target" | "market-too-large" | "overflow" };

/**
 * calcBuy's output is monotone: fee and net never decrease as collateralIn
 * grows; newReserveOther grows with net, so the ceiling-rounded new bought
 * reserve cannot increase. Thus net + reserveBought - newReserveBought cannot
 * decrease.
 */
export function minCollateralForShares(
  market: Pick<Market, "reserve_yes" | "reserve_no" | "fee_bps" | "sets_minted">,
  outcome: OutcomeTag,
  targetShares: bigint,
): ExactBuy {
  if (targetShares <= 0n) return { ok: false, reason: "invalid-target" };
  if (targetShares > MAX_SETS) return { ok: false, reason: "market-too-large" };

  const [rBought, rOther] =
    outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
  const feeBps = BigInt(market.fee_bps);
  const headroom = MAX_SETS - market.sets_minted;
  if (rBought <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS || headroom <= 0n) {
    return { ok: false, reason: "market-too-large" };
  }

  const maxCollateralIn = (headroom * BPS) / (BPS - feeBps);
  if (maxCollateralIn <= 0n) return { ok: false, reason: "market-too-large" };

  const sharesAt = (amount: bigint) => {
    try {
      return calcBuy(rBought, rOther, amount, feeBps).sharesOut;
    } catch (error) {
      if (error instanceof MathError) return 0n;
      throw error;
    }
  };

  if (sharesAt(maxCollateralIn) < targetShares) return { ok: false, reason: "market-too-large" };

  let low = 0n;
  let high = maxCollateralIn;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (sharesAt(mid) >= targetShares) high = mid;
    else low = mid;
  }

  try {
    const quote = calcBuy(rBought, rOther, high, feeBps);
    if (market.sets_minted + quote.net > MAX_SETS) return { ok: false, reason: "market-too-large" };
    return {
      ok: true,
      collateralIn: high,
      sharesOut: quote.sharesOut,
      overshoot: quote.sharesOut - targetShares,
      fee: quote.fee,
      net: quote.net,
    };
  } catch (error) {
    if (error instanceof MathError) return { ok: false, reason: "overflow" };
    throw error;
  }
}
