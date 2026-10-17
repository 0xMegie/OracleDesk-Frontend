import { describe, expect, it } from "vitest";
import { calcSell } from "../generated/fpmm";
import { reconcileWithQuote, solveSellForShares } from "../sell-solver";

describe("solveSellForShares", () => {
  it("returns the maximal collateral output allowed by a share budget", () => {
    const result = solveSellForShares(1_000n, 1_000n, 375n, 0n);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(calcSell(1_000n, 1_000n, result.collateralOut, 0n).sharesIn).toBeLessThanOrEqual(375n);
    expect(calcSell(1_000n, 1_000n, result.collateralOut + 1n, 0n).sharesIn).toBeGreaterThan(375n);
    expect(result.dust).toBe(375n - result.sharesIn);
  });

  it("returns zero dust when the reference pool can consume the whole budget", () => {
    const result = solveSellForShares(1_000n, 1_000n, 999_999n, 0n);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.dust).toBe(0n);
  });

  it("rejects a budget too small to cover any collateral output", () => {
    expect(solveSellForShares(1_000n, 1_000n, 1n, 1_000n)).toEqual({ error: "too-small" });
  });

  it.each([0n, 30n, 100n, 1_000n])("handles fee tier %s bps", (feeBps) => {
    for (const [rSold, rOther] of [[99n, 9_901n], [9_901n, 99n], [1_000n, 1_000n]] as const) {
      const result = solveSellForShares(rSold, rOther, 200n, feeBps);
      if ("error" in result) continue;
      expect(calcSell(rSold, rOther, result.collateralOut, feeBps).sharesIn).toBe(result.sharesIn);
      expect(result.iterations).toBeLessThanOrEqual(130);
    }
  });

  it("stays exact for bigint positions above the safe integer range", () => {
    const result = solveSellForShares(10n ** 20n, 10n ** 20n, 10n ** 18n, 30n);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(calcSell(10n ** 20n, 10n ** 20n, result.collateralOut, 30n).sharesIn).toBe(result.sharesIn);
  });

  it("keeps sharesIn monotone for a deterministic randomized sample", () => {
    let seed = 0x51e11;
    const random = (max: number) => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % max;
    };
    for (let i = 0; i < 2_000; i++) {
      const rSold = BigInt(random(100_000) + 1);
      const rOther = BigInt(random(100_000) + 2);
      const fee = BigInt([0, 30, 100, 1_000][random(4)]);
      let previous = 0n;
      const maxOut = ((rOther - 1n) * (10_000n - fee)) / 10_000n;
      const probes = 8;
      for (let j = 1; j <= probes; j++) {
        const amount = (maxOut * BigInt(j)) / BigInt(probes);
        if (amount === 0n) continue;
        const current = calcSell(rSold, rOther, amount, fee).sharesIn;
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
      const budget = BigInt(random(1_000_000) + 1);
      const solution = solveSellForShares(rSold, rOther, budget, fee);
      if ("error" in solution) continue;
      expect(calcSell(rSold, rOther, solution.collateralOut, fee).sharesIn).toBeLessThanOrEqual(budget);
      if (solution.collateralOut < maxOut) {
        expect(calcSell(rSold, rOther, solution.collateralOut + 1n, fee).sharesIn).toBeGreaterThan(budget);
      }
    }
  });

  it("reconciles its share count with the simulated quote", async () => {
    const local = solveSellForShares(1_000n, 1_000n, 375n, 0n);
    expect("error" in local).toBe(false);
    if ("error" in local) return;
    const reconciled = await reconcileWithQuote(local, async () => local.sharesIn);
    expect(reconciled).toEqual(local);
  });
});
