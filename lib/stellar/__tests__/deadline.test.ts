import { describe, expect, it } from "vitest";
import { assertSigningDeadline, deadlineFor } from "../deadline";

describe("deadlineFor", () => {
  it("uses the default timeout when a market is not near closing", () => {
    expect(deadlineFor("buy", 1_000, 2_000n)).toEqual({ timeoutInSeconds: 60, maxTime: 1_060 });
  });

  it("shrinks trade validity to the safe market-close boundary", () => {
    expect(deadlineFor("sell", 1_000, 1_050n)).toEqual({ timeoutInSeconds: 40, maxTime: 1_040 });
  });

  it("refuses trades when fewer than the minimum safe seconds remain", () => {
    expect(() => deadlineFor("buy", 1_000, 1_024n)).toThrow(/under 25 seconds/i);
  });

  it("sets an explicit timeout on redeem and transfer without a market deadline", () => {
    expect(deadlineFor("redeem", 1_000)).toEqual({ timeoutInSeconds: 60, maxTime: 1_060 });
    expect(deadlineFor("transfer", 1_000, 1_001n)).toEqual({ timeoutInSeconds: 60, maxTime: 1_060 });
  });

  it("rejects a wallet response that arrives too close to expiry", () => {
    const deadline = deadlineFor("buy", 1_000, 1_200n);
    expect(() => assertSigningDeadline(deadline, deadline.maxTime - 5)).toThrow(/signing took too long/i);
  });
});
