import { describe, expect, it } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import {
  evaluateTxStatus,
  fromRecord,
  isValidRecord,
  loadRecords,
  mergeRecords,
  saveRecords,
  toRecord,
  tradeInvalidationKeys,
  type TrackedTx,
} from "../tx-tracker-core";

class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const TEST_PASSPHRASE = "Test SDF Network ; September 2015";
const VALID_HOLDER = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
const VALID_HASH_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_HASH_2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("tx-tracker pure functions", () => {
  it("round-trips bigint amounts through sessionStorage strings without precision loss", () => {
    const rawAmounts = {
      collateralIn: 100_000_000n,
      minSharesOut: 98_765_432n,
      largeValue: 999_999_999_999_999_999n,
      zero: 0n,
    };

    const serialized = toRecord(rawAmounts);
    expect(serialized).toEqual({
      collateralIn: "100000000",
      minSharesOut: "98765432",
      largeValue: "999999999999999999",
      zero: "0",
    });

    const restored = fromRecord(serialized);
    expect(restored).toEqual(rawAmounts);
  });

  it("drops records for a different network passphrase", () => {
    const now = Date.now();
    const wrongNetRecord: TrackedTx = {
      hash: VALID_HASH_1,
      kind: "buy",
      holder: VALID_HOLDER,
      marketId: "1",
      outcome: "Yes",
      amounts: { collateralIn: "100000000" },
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      submittedAt: now,
      state: "pending",
    };

    expect(isValidRecord(wrongNetRecord, TEST_PASSPHRASE, now)).toBe(false);

    const storage = new FakeStorage();
    saveRecords(storage, [wrongNetRecord]);
    const loaded = loadRecords(storage, TEST_PASSPHRASE, now);
    expect(loaded.length).toBe(0);
  });

  it("drops malformed and stale records", () => {
    const now = Date.now();
    const staleTime = now - 25 * 60 * 60 * 1000; // 25 hours old

    const staleRecord: TrackedTx = {
      hash: VALID_HASH_1,
      kind: "buy",
      holder: VALID_HOLDER,
      amounts: { collateralIn: "100" },
      networkPassphrase: TEST_PASSPHRASE,
      submittedAt: staleTime,
      state: "pending",
    };
    expect(isValidRecord(staleRecord, TEST_PASSPHRASE, now)).toBe(false);

    // Malformed records
    expect(isValidRecord({ hash: "not-a-hex" }, TEST_PASSPHRASE, now)).toBe(false);
    expect(isValidRecord({ hash: VALID_HASH_1, kind: "unknown" }, TEST_PASSPHRASE, now)).toBe(false);
    expect(isValidRecord({ hash: VALID_HASH_1, kind: "buy", holder: "short" }, TEST_PASSPHRASE, now)).toBe(false);
    expect(isValidRecord(null, TEST_PASSPHRASE, now)).toBe(false);
  });

  it("merges records from two writers by hash without blind overwrite", () => {
    const now = Date.now();
    const writer1: TrackedTx[] = [
      {
        hash: VALID_HASH_1,
        kind: "buy",
        holder: VALID_HOLDER,
        marketId: "1",
        amounts: { collateralIn: "100" },
        networkPassphrase: TEST_PASSPHRASE,
        submittedAt: now - 1000,
        state: "pending",
      },
    ];

    const writer2: TrackedTx[] = [
      {
        hash: VALID_HASH_1,
        kind: "buy",
        holder: VALID_HOLDER,
        marketId: "1",
        amounts: { collateralIn: "100" },
        networkPassphrase: TEST_PASSPHRASE,
        submittedAt: now - 1000,
        state: "confirmed",
        ledger: 500,
      },
      {
        hash: VALID_HASH_2,
        kind: "usdc-transfer",
        holder: VALID_HOLDER,
        amounts: { amount: "5000000" },
        networkPassphrase: TEST_PASSPHRASE,
        submittedAt: now,
        state: "pending",
      },
    ];

    const merged = mergeRecords(writer1, writer2);
    expect(merged.length).toBe(2);

    const tx1 = merged.find((r) => r.hash === VALID_HASH_1);
    expect(tx1?.state).toBe("confirmed");
    expect(tx1?.ledger).toBe(500);

    const tx2 = merged.find((r) => r.hash === VALID_HASH_2);
    expect(tx2?.state).toBe("pending");
  });

  it("marks NOT_FOUND past time bound as expired with mayNotHaveBeenSent flag", () => {
    const record: TrackedTx = {
      hash: VALID_HASH_1,
      kind: "buy",
      holder: VALID_HOLDER,
      marketId: "1",
      amounts: { collateralIn: "100" },
      networkPassphrase: TEST_PASSPHRASE,
      submittedAt: Date.now(),
      state: "pending",
      maxTime: 1000,
    };

    const notExpiredRes = {
      status: "NOT_FOUND",
      latestLedger: 10,
      latestLedgerCloseTime: 999,
    } as rpc.Api.GetTransactionResponse;
    const stillPending = evaluateTxStatus(record, notExpiredRes);
    expect(stillPending.state).toBe("pending");

    const expiredRes = {
      status: "NOT_FOUND",
      latestLedger: 15,
      latestLedgerCloseTime: 1005,
    } as rpc.Api.GetTransactionResponse;
    const expired = evaluateTxStatus(record, expiredRes);
    expect(expired.state).toBe("expired");
    expect(expired.mayNotHaveBeenSent).toBe(true);
  });

  it("computes the same invalidation keys as useInvalidateAfterTrade", () => {
    const marketId = "42";
    const holder = VALID_HOLDER;

    const keys = tradeInvalidationKeys(marketId, holder);
    expect(keys).toEqual([
      ["stellar", "market", "42"],
      ["stellar", "markets"],
      ["stellar", "position", "42", holder],
      ["stellar", "usdcBalance", holder],
    ]);
  });
});
