import { describe, expect, it } from "vitest";
import { xdr, type rpc } from "@stellar/stellar-sdk";
import { classifySequenceError, describeError, describeSubmission } from "../errors";

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

  it("maps op_low_reserve and txInsufficientBalance to insufficient-xlm while preserving USDC balance mapping", () => {
    expect(describeError("op_low_reserve").kind).toBe("insufficient-xlm");
    expect(describeError("txInsufficientBalance").kind).toBe("insufficient-xlm");
    expect(describeError("tx_insufficient_balance").kind).toBe("insufficient-xlm");
    // USDC balance still wins
    expect(describeError("balance is not sufficient to spend").kind).toBe("insufficient-balance");
    expect(describeError("insufficient balance").kind).toBe("insufficient-balance");
    expect(describeError("op_underfunded").kind).toBe("insufficient-balance");
  });

  it("maps a missing WalletConnect session to a reconnect message", () => {
    const described = describeError(new Error("No WalletConnect session found or it expired for the selected address."));
    expect(described).toMatchObject({ kind: "disconnected" });
    expect(described.message).toMatch(/connect your mobile wallet again/i);
  });

  it("maps an unfunded source account to account-not-found, before USDC rules", () => {
    expect(describeError(new Error("Account not found: GABC123")).kind).toBe("account-not-found");
    expect(describeError("op_no_source_account").kind).toBe("account-not-found");
    expect(describeError("balance is not sufficient to spend").kind).toBe("insufficient-balance");
  });

  it("falls back to a readable message", () => {
    expect(describeError(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(describeError(42).message).toMatch(/something went wrong/i);
  });
});

describe("describeSubmission", () => {
  it("maps TRY_AGAIN_LATER and DUPLICATE", () => {
    const tryAgain = describeSubmission({
      status: "TRY_AGAIN_LATER",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
    } as rpc.Api.SendTransactionResponse);
    expect(tryAgain.kind).toBe("submission");
    expect(tryAgain.submission).toBe("try-again-later");

    const dup = describeSubmission({
      status: "DUPLICATE",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
    } as rpc.Api.SendTransactionResponse);
    expect(dup.kind).toBe("submission");
    expect(dup.submission).toBe("duplicate");
  });

  it("maps ERROR result codes txBadSeq, txInsufficientFee, txTooLate, txInsufficientBalance", () => {
    const makeError = (resultArm: () => xdr.TransactionResultResult) =>
      ({
        status: "ERROR",
        hash: "1234",
        latestLedger: 10,
        latestLedgerCloseTime: 100,
        errorResult: new xdr.TransactionResult({
          feeCharged: xdr.Int64.fromString("100"),
          result: resultArm(),
          ext: new xdr.TransactionResultExt(0),
        }),
      }) as unknown as rpc.Api.SendTransactionResponse;

    const badSeq = describeSubmission(makeError(() => xdr.TransactionResultResult.txBadSeq()));
    expect(badSeq.resultCode).toBe("txBadSeq");
    expect(badSeq.submission).toBe("rejected-by-network");

    const lowFee = describeSubmission(makeError(() => xdr.TransactionResultResult.txInsufficientFee()));
    expect(lowFee.resultCode).toBe("txInsufficientFee");

    const tooLate = describeSubmission(makeError(() => xdr.TransactionResultResult.txTooLate()));
    expect(tooLate.resultCode).toBe("txTooLate");

    const noXlm = describeSubmission(makeError(() => xdr.TransactionResultResult.txInsufficientBalance()));
    expect(noXlm.kind).toBe("insufficient-xlm");
    expect(noXlm.resultCode).toBe("txInsufficientBalance");
  });

  it("falls through to contract errors on txFailed", () => {
    const failedContract = {
      status: "ERROR",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
      errorResult: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult.txFailed([]),
        ext: new xdr.TransactionResultExt(0),
      }),
      message: "HostError: Error(Contract, #12)",
    } as unknown as rpc.Api.SendTransactionResponse;

    const result = describeSubmission(failedContract, "marketCore");
    expect(result.code).toBe("SlippageExceeded");
    expect(result.resultCode).toBe("txFailed");
    expect(result.submission).toBe("rejected-by-network");
  });
});
