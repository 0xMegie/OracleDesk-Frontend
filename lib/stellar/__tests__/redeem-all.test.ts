import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const decodeValue = vi.fn();
vi.mock("../clients", () => ({
  marketCore: () => ({ spec: { scValToNative: decodeValue } }),
}));

import {
  discoverRedeemable,
  loadRedeemAllResume,
  marketLedgerKey,
  positionLedgerKey,
  REDEEM_ALL_STORAGE_KEY,
  saveRedeemAllResume,
  type ItemState,
} from "../redeem-all";

interface FakeEntry {
  key: { toXDR(format: "base64"): string };
  val: { contractData(): { val(): { id: bigint; kind: "Position" | "Market" } } };
  liveUntilLedgerSeq?: number;
}

function fakeEntry(key: FakeEntry["key"], kind: "Position" | "Market", id: bigint): FakeEntry {
  return {
    key,
    val: { contractData: () => ({ val: () => ({ kind, id }) }) },
  } as FakeEntry;
}

describe("redeem-all discovery", () => {
  beforeEach(() => {
    decodeValue.mockImplementation((value: { id: bigint; kind: string }) =>
      value.kind === "Position"
        ? { yes: 1_000_000n, no: 500_000n }
        : {
            close_time: 0n,
            sets_minted: 1n,
            reserve_yes: 1n,
            reserve_no: 1n,
            status:
              value.id % 3n === 0n
                ? ["Resolved", [value.id % 2n ? "Yes" : "No"]]
                : { tag: "Resolved", values: [{ tag: value.id % 2n ? "Yes" : "No", values: undefined }] },
          },
    );
  });

  afterEach(() => vi.clearAllMocks());

  it("creates distinct persistent Soroban keys for markets and account positions", () => {
    const holder = Keypair.random().publicKey();
    const anotherHolder = Keypair.random().publicKey();
    expect(marketLedgerKey(3n).toXDR("base64")).not.toBe(marketLedgerKey(4n).toXDR("base64"));
    expect(positionLedgerKey(3n, holder).toXDR("base64")).not.toBe(
      positionLedgerKey(3n, anotherHolder).toXDR("base64"),
    );
    expect(positionLedgerKey(3n, holder).toXDR("base64")).not.toBe(marketLedgerKey(3n).toXDR("base64"));
  });

  it("reads every ledger chunk and accumulates redeemables beyond the first chunk", async () => {
    const holder = Keypair.random().publicKey();
    const count = 202n;
    const keyToMarket = new Map<string, bigint>();
    for (let id = 0n; id < count; id++) {
      keyToMarket.set(positionLedgerKey(id, holder).toXDR("base64"), id);
      keyToMarket.set(marketLedgerKey(id).toXDR("base64"), id);
    }
    let requestCount = 0;
    const server = {
      getLedgerEntries: vi.fn(async (...keys: FakeEntry["key"][]) => {
        const isPositionRead = requestCount < 2;
        requestCount += 1;
        const entries = keys.map((key) => {
          const id = keyToMarket.get(key.toXDR("base64"));
          if (id === undefined) return null;
          return fakeEntry(key, isPositionRead ? "Position" : "Market", id);
        }).filter((entry): entry is FakeEntry => entry !== null);
        return { entries, latestLedger: 600 };
      }),
    };

    const result = await discoverRedeemable(holder, count, server as never);

    expect(server.getLedgerEntries).toHaveBeenCalledTimes(4);
    expect(server.getLedgerEntries.mock.calls.map(([...keys]) => keys.length)).toEqual([200, 2, 200, 2]);
    expect(result.scannedMarkets).toBe(count);
    expect(result.redeemables).toHaveLength(Number(count));
    expect(result.redeemables[0]).toMatchObject({ marketId: 0n, settlement: "no", expectedPayout: 500_000n });
    expect(result.redeemables[201]).toMatchObject({ marketId: 201n, settlement: "yes", expectedPayout: 1_000_000n });
    expect(result.scanLimited).toBe(false);
  });

  it("limits huge scans to the newest market IDs", async () => {
    const server = { getLedgerEntries: vi.fn(async () => ({ entries: [], latestLedger: 1 })) };
    const result = await discoverRedeemable(Keypair.random().publicKey(), 50_000n, server as never);
    expect(result.scannedMarkets).toBe(20_000n);
    expect(result.totalMarkets).toBe(50_000n);
    expect(result.scanLimited).toBe(true);
    expect(server.getLedgerEntries).toHaveBeenCalledTimes(100);
  });
});

describe("redeem-all session resume", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };

  beforeEach(() => {
    data.clear();
    vi.stubGlobal("sessionStorage", storage);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stores and restores progress per connected wallet, including bigint payouts", () => {
    const holder = Keypair.random().publicKey();
    const states: Record<string, ItemState> = {
      "7": { s: "redeemed", payout: 1_250_000n, hash: "abc123" },
      "8": { s: "failed", error: "RPC unavailable" },
    };
    saveRedeemAllResume({ holder, ids: Object.keys(states), states });
    expect(loadRedeemAllResume(holder)).toEqual({ holder, ids: ["7", "8"], states });
    expect(loadRedeemAllResume(Keypair.random().publicKey())).toBeNull();
    expect(data.has(`${REDEEM_ALL_STORAGE_KEY}${holder}`)).toBe(true);
  });

  it("surfaces malformed saved progress instead of silently treating it as empty", () => {
    const holder = Keypair.random().publicKey();
    data.set(`${REDEEM_ALL_STORAGE_KEY}${holder}`, "{");
    expect(() => loadRedeemAllResume(holder)).toThrow("Could not restore redemption progress");
  });
});
