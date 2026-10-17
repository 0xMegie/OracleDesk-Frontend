import { describe, expect, it } from "vitest";
import { formatUsdc, formatXlm, maxIn, minOut, parseUsdc, shareOf, shortAddress, tryParseUsdc, USDC_UNIT, XLM_UNIT } from "../units";

describe("parseUsdc / formatUsdc", () => {
  it("uses 7 decimals", () => {
    expect(USDC_UNIT).toBe(10_000_000n);
    expect(parseUsdc("1")).toBe(10_000_000n);
    expect(parseUsdc("0.0000001")).toBe(1n);
    expect(parseUsdc("123.4567891")).toBe(1_234_567_891n);
    expect(parseUsdc(".5")).toBe(5_000_000n);
    expect(parseUsdc(" 2.5 ")).toBe(25_000_000n);
  });

  it("round-trips without floats", () => {
    for (const s of ["0", "1", "0.1", "0.0000001", "99999999.9999999", "123456789012.5"]) {
      expect(formatUsdc(parseUsdc(s))).toBe(s);
    }
    // 0.1 + 0.2 would be 0.30000000000000004 as floats.
    expect(formatUsdc(parseUsdc("0.1") + parseUsdc("0.2"))).toBe("0.3");
  });

  it("rejects malformed input", () => {
    for (const bad of ["1e5", "1E5", "", " ", "-1", "+1", "1,000", "abc", "1.2.3", "0x10", "Infinity", "NaN"]) {
      expect(() => parseUsdc(bad), bad).toThrow();
      expect(tryParseUsdc(bad)).toBeNull();
    }
  });

  it("rejects more than 7 decimals", () => {
    expect(() => parseUsdc("0.00000001")).toThrow(/7 decimal/);
    expect(() => parseUsdc("1.12345678")).toThrow(/7 decimal/);
  });

  it("formats with options", () => {
    expect(formatUsdc(12_345_678_900_000n, { grouping: true, maxDecimals: 2, minDecimals: 2 })).toBe("1,234,567.89");
    expect(formatUsdc(15_000_000n, { minDecimals: 2 })).toBe("1.50");
    expect(formatUsdc(19_999_999n, { maxDecimals: 2 })).toBe("1.99"); // truncates, never rounds up
    expect(formatUsdc(-5n)).toBe("-0.0000005");
  });
});

describe("formatXlm", () => {
  it("uses 7 decimals and stroops unit", () => {
    expect(XLM_UNIT).toBe(10_000_000n);
    expect(formatXlm(10_000_000n)).toBe("1");
    expect(formatXlm(1n)).toBe("0.0000001");
    expect(formatXlm(123_456n)).toBe("0.0123456");
    expect(formatXlm(12_345_678_900_000n, { grouping: true })).toBe("1,234,567.89");
    expect(formatXlm(99_981_000_000n, { grouping: true })).toBe("9,998.1");
    expect(formatXlm(0n)).toBe("0");
    expect(formatXlm(5_000_000n, { minDecimals: 2 })).toBe("0.50");
  });
});

describe("slippage helpers round against the user", () => {
  it("minOut rounds down", () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(minOut(999n, 100)).toBe(989n); // 989.01 → 989
    expect(minOut(1n, 1)).toBe(0n);
    expect(minOut(12_345n, 0)).toBe(12_345n);
    expect(() => minOut(100n, 10_001)).toThrow();
  });

  it("maxIn rounds up", () => {
    expect(maxIn(10_000n, 100)).toBe(10_100n);
    expect(maxIn(999n, 100)).toBe(1_009n); // 1008.99 → 1009
    expect(maxIn(1n, 1)).toBe(2n);
    expect(maxIn(12_345n, 0)).toBe(12_345n);
  });

  it("shareOf is a bigint share in bps", () => {
    expect(shareOf(1_000_000_000n, 1_250)).toBe(125_000_000n);
    expect(shareOf(7n, 5_000)).toBe(3n);
  });
});

describe("shortAddress", () => {
  it("keeps both ends", () => {
    expect(shortAddress("GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF")).toBe("GCM7…XAIF");
    expect(shortAddress(null)).toBe("");
  });
});
