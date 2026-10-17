import { describe, expect, it } from "vitest";
import type { Market, Position } from "../generated/market-core";
import { MAX_SETS } from "../generated/fpmm";
import { FRIENDLY, describeError } from "../errors";
import { preflightBuy, preflightRedeem, preflightSell, type PreflightInput } from "../preflight";

const market = (overrides: Partial<Market> = {}): Market =>
  ({
    category: { tag: "Crypto", values: undefined },
    close_time: 100n,
    creator: "GCREATOR",
    fee_bps: 0,
    fees_accrued: 0n,
    lp_claimed: false,
    meta_uri: "",
    question_hash: Buffer.alloc(32),
    reserve_no: 1_000_000n,
    reserve_yes: 1_000_000n,
    resolution_hash: Buffer.alloc(32),
    sets_minted: 0n,
    status: { tag: "Open", values: undefined },
    ...overrides,
  }) as Market;

const position = (yes = 0n, no = 0n): Position => ({ yes, no });
const validTrade = (): PreflightInput => ({
  config: { paused: false },
  market: market(),
  ledgerNow: 99n,
  position: position(100n, 100n),
  usdcBalance: 1_000_000n,
});

describe("preflightBuy", () => {
  it("reports trading pause, closed markets, and close-time equality", () => {
    expect(preflightBuy({ ...validTrade(), config: { paused: true } }, "Yes", 1n)).toMatchObject({
      ok: false,
      failures: [{ code: "Paused", contractErrorNumber: 2 }],
    });
    expect(preflightBuy({ ...validTrade(), market: market({ status: { tag: "Void", values: undefined } }) }, "Yes", 1n))
      .toMatchObject({ ok: false, failures: [{ code: "MarketNotOpen", contractErrorNumber: 8 }] });
    expect(preflightBuy({ ...validTrade(), ledgerNow: 100n }, "Yes", 1n)).toMatchObject({
      ok: false,
      failures: [{ code: "MarketClosed", contractErrorNumber: 9 }],
    });
    expect(preflightBuy({ ...validTrade(), ledgerNow: 99n }, "Yes", 1n).ok).toBe(true);
  });

  it("uses strict market-size boundary semantics and avoids rejecting stale near-boundary data", () => {
    const equality = market({ sets_minted: MAX_SETS - 100n });
    expect(preflightBuy({ ...validTrade(), market: equality }, "Yes", 100n).ok).toBe(true);
    expect(preflightBuy({ ...validTrade(), market: equality }, "Yes", 101n)).toMatchObject({
      ok: false,
      failures: [{ code: "MarketTooLarge", contractErrorNumber: 15 }],
    });
    expect(preflightBuy({ ...validTrade(), market: equality, marketIsStale: true }, "Yes", 101n))
      .toMatchObject({ ok: "unknown", missing: ["fresh market"] });
    expect(
      preflightBuy(
        { ...validTrade(), market: market({ status: { tag: "Void", values: undefined } }), marketIsStale: true },
        "Yes",
        1n,
      ).ok,
    ).toBe("unknown");
  });

  it("rejects invalid amount and insufficient known balance, but allows unknown balance", () => {
    expect(preflightBuy(validTrade(), "Yes", 0n)).toMatchObject({
      ok: false,
      failures: [{ code: "InvalidAmount", contractErrorNumber: 4 }],
    });
    expect(preflightBuy({ ...validTrade(), usdcBalance: 10n }, "Yes", 11n)).toMatchObject({
      ok: false,
      failures: [{ code: "InsufficientBalance" }],
    });
    expect(preflightBuy({ ...validTrade(), usdcBalance: undefined }, "Yes", 11n).ok).toBe("unknown");
    expect(preflightBuy({ ...validTrade(), market: undefined }, "Yes", 1n).ok).toBe("unknown");
  });
});

describe("preflightSell", () => {
  it("matches liquidity and holdings boundaries", () => {
    expect(preflightSell(validTrade(), "Yes", 1_000_000n, 1n)).toMatchObject({
      ok: false,
      failures: [{ code: "InsufficientLiquidity", contractErrorNumber: 14 }],
    });
    expect(preflightSell(validTrade(), "Yes", 10n, 100n).ok).toBe(true);
    expect(preflightSell(validTrade(), "Yes", 10n, 101n)).toMatchObject({
      ok: false,
      failures: [{ code: "InsufficientShares", contractErrorNumber: 13 }],
    });
    expect(preflightSell({ ...validTrade(), positionIsStale: true }, "Yes", 10n, 101n).ok).toBe("unknown");
    expect(preflightSell({ ...validTrade(), marketIsStale: true }, "Yes", 10n, 101n).ok).toBe(false);
  });
});

describe("preflightRedeem", () => {
  it("does not apply the trading pause to redemptions", () => {
    expect(
      preflightRedeem({
        config: { paused: true },
        market: market({ status: { tag: "Resolved", values: [{ tag: "Yes", values: undefined }] } }),
        position: position(1n),
      }).ok,
    ).toBe(true);
  });

  it("requires a final market and a non-zero position", () => {
    expect(preflightRedeem({ market: market(), position: position(1n) })).toMatchObject({
      ok: false,
      failures: [{ code: "NotFinal", contractErrorNumber: 11 }],
    });
    expect(
      preflightRedeem({
        market: market({ status: { tag: "Void", values: undefined } }),
        position: position(),
      }),
    ).toMatchObject({ ok: false, failures: [{ code: "NothingToRedeem", contractErrorNumber: 16 }] });
    expect(
      preflightRedeem({
        market: market(),
        marketIsStale: true,
        position: position(1n),
      }).ok,
    ).toBe("unknown");
    expect(
      preflightRedeem({
        market: market({ status: { tag: "Void", values: undefined } }),
        position: position(),
        positionIsStale: true,
      }).ok,
    ).toBe("unknown");
    expect(preflightRedeem({}).ok).toBe("unknown");
  });
});

it("shares friendly text with simulation errors", () => {
  for (const [number, code] of [[2, "Paused"], [9, "MarketClosed"], [15, "MarketTooLarge"], [16, "NothingToRedeem"]] as const) {
    expect(describeError(`Error(Contract, #${number})`).message).toBe(FRIENDLY[code]);
  }
  expect(preflightBuy(validTrade(), "Yes", 0n)).toMatchObject({
    ok: false,
    failures: [{ code: "InvalidAmount", message: FRIENDLY.InvalidAmount }],
  });
});
