import { describe, expect, it } from "vitest";
import { buyBreakdown } from "../buy-breakdown";
import { isArchivedStateError, simulateWithRestore } from "../archival";
import { isExpiredTransaction, isFeeSurge, transactionRecoveryAdvice } from "../transaction-recovery";

describe("buy breakdown", () => {
  it("reports fee, net collateral and price impact from FPMM math", () => {
    const result = buyBreakdown(1_000_000n, 1_000_000n, 100_000n, 100n);
    expect(result.fee).toBe(1_000n);
    expect(result.net).toBe(99_000n);
    expect(result.sharesOut).toBeGreaterThan(0n);
    expect(result.priceImpactBps).toBeGreaterThan(0n);
  });
});

describe("transaction recovery", () => {
  it("classifies fee surges and expiry with actionable advice", () => {
    expect(isFeeSurge("tx_bad_seq")).toBe(true);
    expect(transactionRecoveryAdvice("tx_bad_seq").kind).toBe("fee-bump");
    expect(isExpiredTransaction("tx_too_late")).toBe(true);
    expect(transactionRecoveryAdvice("tx_too_late").kind).toBe("rebuild");
  });
});

describe("archived state recovery", () => {
  it("restores and rebuilds when simulation exposes an archived entry", async () => {
    let attempts = 0;
    const build = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("archived ledger entry");
      return {} as never;
    };
    // Build failures occur before an assembled transaction exists, so callers
    // can also use this predicate around their restore endpoint.
    expect(isArchivedStateError("archived ledger entry")).toBe(true);
    await expect(simulateWithRestore(build, async () => undefined)).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });
});
