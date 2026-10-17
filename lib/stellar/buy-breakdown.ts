import { calcBuy, type BuyQuote } from "./generated/fpmm";

export interface BuyBreakdown extends BuyQuote {
  /** Price impact in basis points, measured against the pre-trade marginal price. */
  priceImpactBps: bigint;
}

/** Calculate the same fee, output and price impact used by the FPMM locally. */
export function buyBreakdown(
  reserveBought: bigint,
  reserveOther: bigint,
  collateralIn: bigint,
  feeBps: bigint,
): BuyBreakdown {
  const quote = calcBuy(reserveBought, reserveOther, collateralIn, feeBps);
  const before = reserveBought * 10_000n / (reserveBought + reserveOther);
  const after = quote.newReserveBought * 10_000n /
    (quote.newReserveBought + quote.newReserveOther);
  return { ...quote, priceImpactBps: after > before ? after - before : before - after };
}
