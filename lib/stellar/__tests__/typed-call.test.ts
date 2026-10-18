import { describe, expect, it, vi } from "vitest";
import { Ok, Err } from "@stellar/stellar-sdk/contract";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { UserFacingError } from "../errors";
import { bytesToHex, read, simulated, submit } from "../typed-call";

function mockTx<T>(
  result: T,
  options?: {
    simulation?: { error?: string };
    signAndSendResult?: unknown;
    txHash?: string | null;
  },
): AssembledTransaction<T> {
  return {
    result,
    simulation: options?.simulation,
    signAndSend: vi.fn().mockResolvedValue({
      result: options?.signAndSendResult ?? result,
      sendTransactionResponse: {
        hash: options?.txHash !== undefined ? options?.txHash : "test-tx-hash-abc",
      },
    }),
  } as unknown as AssembledTransaction<T>;
}

function mockThrowingTx(
  errorToThrow: unknown,
  simulation?: { error?: string },
): AssembledTransaction<unknown> {
  const signAndSend = vi.fn();
  return {
    get result() {
      throw errorToThrow;
    },
    simulation,
    signAndSend,
  } as unknown as AssembledTransaction<unknown>;
}

describe("bytesToHex utility", () => {
  it("converts a Buffer to a lowercase hex string", () => {
    const buf = Buffer.from([0x01, 0x0f, 0xa3, 0xff]);
    expect(bytesToHex(buf)).toBe("010fa3ff");
  });

  it("converts a Uint8Array to a lowercase hex string", () => {
    const uint8 = new Uint8Array([0x00, 0x12, 0xab, 0xcd]);
    expect(bytesToHex(uint8)).toBe("0012abcd");
  });

  it("handles empty buffers", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});

describe("read() runtime helper", () => {
  it("returns plain non-Result values unchanged (e.g. u64, Position)", () => {
    const plainBigInt = 123456789n;
    const tx = mockTx(plainBigInt);
    expect(read(tx)).toBe(plainBigInt);

    const plainPosition = { shares_yes: 100n, shares_no: 0n };
    const posTx = mockTx(plainPosition);
    expect(read(posTx)).toEqual(plainPosition);
  });

  it("unwraps Ok instances into their inner value", () => {
    const okVal = 42n;
    const tx = mockTx(new Ok(okVal));
    expect(read(tx)).toBe(okVal);
  });

  it("throws UserFacingError on Err with contract error code mapped", () => {
    const tx = mockTx(new Err({ message: "Error(Contract, #12)" }), {
      simulation: { error: "HostError Error(Contract, #12)" },
    });
    expect(() => read(tx, "marketCore")).toThrow(UserFacingError);

    try {
      read(tx, "marketCore");
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const ufe = err as UserFacingError;
      expect(ufe.described.kind).toBe("contract");
      expect(ufe.described.code).toBe("SlippageExceeded");
    }
  });

  it("does not treat an object with an isOk property as a Result", () => {
    const duckTypedObject = {
      isOk: () => true,
      unwrap: () => 99,
    };
    const tx = mockTx(duckTypedObject);
    // Because duckTypedObject is NOT instanceof Ok, read() must not unwrap it.
    const result = read(tx);
    expect(result).toBe(duckTypedObject);
    expect(result).not.toBe(99);
  });

  it("maps a throwing tx.result through describeError with the contract table", () => {
    const tx = mockThrowingTx(
      new Error("Simulation failed: Error(Contract, #7)"),
      { error: "Error(Contract, #7)" },
    );

    expect(() => read(tx, "marketCore")).toThrow(UserFacingError);

    try {
      read(tx, "marketCore");
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const ufe = err as UserFacingError;
      expect(ufe.described.kind).toBe("contract");
      expect(ufe.described.code).toBe("MarketNotFound");
    }
  });

  it("simulated is a deprecated alias to read", () => {
    const tx = mockTx(100n);
    expect(simulated(tx)).toBe(100n);
  });
});

describe("submit() runtime helper", () => {
  it("surfaces simulation failure before calling signAndSend", async () => {
    const tx = mockThrowingTx(
      new Error("Error(Contract, #2)"),
      { error: "Error(Contract, #2)" },
    );

    await expect(submit(tx, "marketCore")).rejects.toThrow(UserFacingError);
    expect(tx.signAndSend).not.toHaveBeenCalled();
  });

  it("returns { value, txHash } from sendTransactionResponse on success", async () => {
    const okValue = 999n;
    const tx = mockTx(new Ok(okValue), {
      signAndSendResult: new Ok(okValue),
      txHash: "mocked-hash-xyz",
    });

    const res = await submit(tx, "marketCore");
    expect(res).toEqual({
      value: okValue,
      ledger: null,
      txHash: "mocked-hash-xyz",
    });
    expect(tx.signAndSend).toHaveBeenCalledTimes(1);
  });

  it("returns null txHash when sendTransactionResponse has no hash", async () => {
    const tx = mockTx(42n, {
      signAndSendResult: 42n,
      txHash: null,
    });

    const res = await submit(tx);
    expect(res).toEqual({
      value: 42n,
      ledger: null,
      txHash: null,
    });
  });
});
