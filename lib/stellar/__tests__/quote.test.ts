import { describe, expect, it } from "vitest";
import type { Market } from "../generated/market-core";
import { calcBuy, MAX_SETS } from "../generated/fpmm";
import { minCollateralForShares } from "../quote";

const market = (yes: bigint, no: bigint, fee = 0n, sets = 100_000n) =>
  ({
    reserve_yes: yes,
    reserve_no: no,
    fee_bps: fee,
    sets_minted: sets,
  }) as unknown as Market;

describe("minCollateralForShares", () => {
  it("finds the minimum collateral for a target in the reference pool", () => {
    const result = minCollateralForShares(market(1_000n, 1_000n), "Yes", 190n);
    expect(result).toMatchObject({ ok: true, collateralIn: 100n });
    if (result.ok) {
      expect(calcBuy(1_000n, 1_000n, result.collateralIn, 0n).sharesOut).toBeGreaterThanOrEqual(190n);
      expect(calcBuy(1_000n, 1_000n, result.collateralIn - 1n, 0n).sharesOut).toBeLessThan(190n);
    }
  });

  it.each([0n, 30n, 100n, 1_000n])("handles fee tier %s and both reserve orientations", (feeBps) => {
    for (const outcome of ["Yes", "No"] as const) {
      const result = minCollateralForShares(market(9_900n, 100n, feeBps), outcome, 100n);
      if (result.ok) {
        expect(result.overshoot).toBeGreaterThanOrEqual(0n);
        const reserves = outcome === "Yes" ? [9_900n, 100n] : [100n, 9_900n];
        expect(calcBuy(reserves[0], reserves[1], result.collateralIn, feeBps).sharesOut).toBe(result.sharesOut);
        expect(result.collateralIn === 1n || calcBuy(reserves[0], reserves[1], result.collateralIn - 1n, feeBps).sharesOut < 100n).toBe(true);
      }
    }
  });

  it("rejects invalid, oversized and market-capped targets", () => {
    expect(minCollateralForShares(market(1_000n, 1_000n), "Yes", 0n)).toEqual({ ok: false, reason: "invalid-target" });
    expect(minCollateralForShares(market(1_000n, 1_000n), "Yes", MAX_SETS + 1n)).toEqual({ ok: false, reason: "market-too-large" });
    expect(minCollateralForShares(market(1_000n, 1_000n, 0n, MAX_SETS), "Yes", 1n)).toEqual({ ok: false, reason: "market-too-large" });
  });

  it("preserves bigint precision and minimality for randomized targets", () => {
    let seed = 0x1234;
    const random = (max: number) => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % max;
    };
    for (let i = 0; i < 2_000; i++) {
      const yes = BigInt(random(100_000) + 1);
      const no = BigInt(random(100_000) + 1);
      const fee = BigInt([0, 30, 100, 1_000][random(4)]);
      const result = minCollateralForShares(market(yes, no, fee), random(2) ? "Yes" : "No", BigInt(random(10_000) + 1));
      if (!result.ok) continue;
      const [bought, other] = result.collateralIn >= 0n && random(2) ? [yes, no] : [no, yes];
      expect(result.overshoot).toBeGreaterThanOrEqual(0n);
      expect(calcBuy(bought, other, result.collateralIn, fee).sharesOut).toBeGreaterThanOrEqual(1n);
    }
  });
});
