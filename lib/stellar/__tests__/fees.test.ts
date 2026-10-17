import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import {
  DEFAULT_BASE_RESERVE,
  feeBreakdown,
  fetchBaseReserve,
  SimulationError,
  spendableXlm,
} from "../fees";
import { formatXlm } from "../units";
import accountEntryFixture from "./fixtures/account-entry.json";
import buySimulationFixture from "./fixtures/buy-simulation.json";

describe("feeBreakdown", () => {
  it("splits inclusion and resource fee from a recorded simulation", () => {
    const txData = xdr.SorobanTransactionData.fromXDR(buySimulationFixture.transactionDataXdr, "base64");
    const fakeTx = {
      built: { fee: buySimulationFixture.fee },
      simulation: {
        minResourceFee: buySimulationFixture.minResourceFee,
        transactionData: {
          build: () => txData,
        },
      },
    } as unknown as AssembledTransaction<unknown>;

    const breakdown = feeBreakdown(fakeTx);

    expect(breakdown.totalFee).toBe(50_000n);
    expect(breakdown.resourceFee).toBe(35_000n);
    expect(breakdown.inclusionFee).toBe(15_000n);
    expect(breakdown.minResourceFee).toBe(25_000n);
    expect(breakdown.resources).toEqual({
      instructions: 450_000,
      readBytes: 1200,
      writeBytes: 640,
      readEntries: 1,
      writeEntries: 1,
    });
  });

  it("keeps values as bigint", () => {
    const txData = xdr.SorobanTransactionData.fromXDR(buySimulationFixture.transactionDataXdr, "base64");
    const fakeTx = {
      built: { fee: "10000000" },
      simulation: {
        minResourceFee: "2000000",
        transactionData: txData,
      },
    } as unknown as AssembledTransaction<unknown>;

    const breakdown = feeBreakdown(fakeTx);
    expect(typeof breakdown.totalFee).toBe("bigint");
    expect(typeof breakdown.resourceFee).toBe("bigint");
    expect(typeof breakdown.inclusionFee).toBe("bigint");
    expect(typeof breakdown.minResourceFee).toBe("bigint");
  });

  it("throws SimulationError on simulation error or restore response", () => {
    const errTx = {
      built: { fee: "100" },
      simulation: { error: "HostError: Error(Contract, #1)" },
    } as unknown as AssembledTransaction<unknown>;
    expect(() => feeBreakdown(errTx)).toThrow(SimulationError);

    const restoreTx = {
      built: { fee: "100" },
      simulation: { restorePreamble: {} },
    } as unknown as AssembledTransaction<unknown>;
    expect(() => feeBreakdown(restoreTx)).toThrow(SimulationError);
  });
});

describe("spendableXlm", () => {
  it("uses 2 + subentries base reserves", () => {
    const entry = new xdr.AccountEntry({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32)),
      balance: xdr.Int64.fromString("100000000"), // 10 XLM
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 3,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.from([1, 1, 1, 1]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    });

    const baseReserve = 5_000_000n; // 0.5 XLM
    const res = spendableXlm(entry, baseReserve);

    // minBalance = (2 + 3) * 0.5 XLM = 2.5 XLM = 25,000,000 stroops
    expect(res.minBalance).toBe(25_000_000n);
    expect(res.sellingLiabilities).toBe(0n);
    expect(res.spendable).toBe(75_000_000n);
    expect(res.subentries).toBe(3);
    expect(res.sponsoring).toBe(0);
    expect(res.sponsored).toBe(0);
  });

  it("accounts for sponsoring and sponsored counts", () => {
    const entry = xdr.AccountEntry.fromXDR(accountEntryFixture.accountEntryXdr, "base64");
    const baseReserve = 5_000_000n;
    const res = spendableXlm(entry, baseReserve);

    // From fixture: balance = 100_000_000n, subentries = 2, sponsoring = 2, sponsored = 1, sellingLiabilities = 5_000_000n
    // minBalance = (2 + 2 + 2 - 1) * 5_000_000 = 5 * 5_000_000 = 25_000_000n
    expect(res.minBalance).toBe(25_000_000n);
    expect(res.sellingLiabilities).toBe(5_000_000n);
    // spendable = 100_000_000 - 25_000_000 - 5_000_000 = 70_000_000n
    expect(res.spendable).toBe(70_000_000n);
    expect(res.sponsoring).toBe(2);
    expect(res.sponsored).toBe(1);
    expect(res.subentries).toBe(2);
  });

  it("subtracts selling liabilities and floors at zero", () => {
    const entry = new xdr.AccountEntry({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32)),
      balance: xdr.Int64.fromString("10000000"), // 1 XLM
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 2,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.from([1, 1, 1, 1]),
      signers: [],
      ext: new xdr.AccountEntryExt(
        1,
        new xdr.AccountEntryExtensionV1({
          liabilities: new xdr.Liabilities({
            buying: xdr.Int64.fromString("0"),
            selling: xdr.Int64.fromString("20000000"), // 2 XLM liabilities
          }),
          ext: new xdr.AccountEntryExtensionV1Ext(0),
        }),
      ),
    });

    const baseReserve = 5_000_000n;
    const res = spendableXlm(entry, baseReserve);
    // minBalance = (2 + 2) * 5_000_000 = 20_000_000n
    // raw spendable = 10_000_000 - 20_000_000 - 20_000_000 = -30_000_000n -> floored to 0
    expect(res.spendable).toBe(0n);
  });
});

describe("base reserve reading and formatXlm", () => {
  it("falls back to DEFAULT_BASE_RESERVE when header XDR is missing", async () => {
    const fakeServer = {
      getLatestLedger: async () => ({ sequence: 100 }),
    };
    const reserve = await fetchBaseReserve(fakeServer as unknown as import("@stellar/stellar-sdk").rpc.Server);
    expect(reserve).toBe(DEFAULT_BASE_RESERVE);
    expect(reserve).toBe(5_000_000n);
  });

  it("formatXlm formats stroops with 7 decimals and grouping", () => {
    expect(formatXlm(12_345_600n)).toBe("1.23456");
    expect(formatXlm(99_981_000_000n, { grouping: true })).toBe("9,998.1");
    expect(formatXlm(123_456n)).toBe("0.0123456");
  });
});
