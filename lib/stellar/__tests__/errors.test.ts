import { describe, expect, it } from "vitest";
import { classifySequenceError, describeError } from "../errors";

describe("describeError", () => {
  it("maps market-core contract errors by code", () => {
    const slip = describeError(new Error("HostError: Error(Contract, #12)\nEvent log: ..."));
    expect(slip).toMatchObject({ kind: "contract", code: "SlippageExceeded" });
    expect(slip.message).toMatch(/price moved/i);

    const closed = describeError("simulation failed: Error(Contract, #9)");
    expect(closed).toMatchObject({ kind: "contract", code: "MarketClosed" });
    expect(closed.message).toMatch(/closed/i);
  });

  it("uses the contract's own table", () => {
    expect(describeError("Error(Contract, #5)", "treasury").code).toBe("TradeCapExceeded");
    expect(describeError("Error(Contract, #5)", "marketCore").code).toBe("InvalidProbability");
  });

  it("recognises wallet rejection", () => {
    expect(describeError({ code: -4, message: "The user rejected this request." }).kind).toBe("rejected");
    expect(describeError(new Error("User declined access")).kind).toBe("rejected");
  });

  it("classifies txBadSeq from structured RPC results and SDK error text", () => {
    const structured = {
      sendTransactionResponse: {
        errorResult: {
          result: () => ({ switch: () => ({ name: "txBadSeq" }) }),
        },
      },
    };
    expect(classifySequenceError(structured)).toBe(true);
    expect(describeError(structured)).toMatchObject({ kind: "stale-sequence", code: "txBadSeq" });
    expect(describeError("Transaction failed: txBadSeq")).toMatchObject({ kind: "stale-sequence" });
  });

  it("recognises balance and trustline failures before contract codes", () => {
    // A SAC failure inside market_core.buy carries the token's own code.
    expect(describeError("Error(Contract, #10) ... balance is not sufficient to spend").kind).toBe("insufficient-balance");
    expect(describeError("Error(Contract, #13) ... trustline entry is missing for account").kind).toBe("no-trustline");
  });

  it("falls back to a readable message", () => {
    expect(describeError(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(describeError(42).message).toMatch(/something went wrong/i);
  });
});
