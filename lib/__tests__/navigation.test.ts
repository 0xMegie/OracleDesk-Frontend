import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../navigation";

const BASE = "https://oracledesk.test";

describe("safeReturnTo", () => {
  it("accepts same-origin paths with query and hash", () => {
    expect(safeReturnTo("/copy-trade?traceId=x", BASE)).toBe("/copy-trade?traceId=x");
    expect(safeReturnTo("/markets/quick-view?onChainId=3#ticket", BASE)).toBe("/markets/quick-view?onChainId=3#ticket");
  });

  it("rejects protocol-relative and backslash hosts", () => {
    expect(safeReturnTo("//evil.com", BASE)).toBeNull();
    expect(safeReturnTo("/\\evil.com", BASE)).toBeNull();
    expect(safeReturnTo("/\t/evil.com", BASE)).toBeNull();
  });

  it("rejects absolute URLs and script schemes", () => {
    expect(safeReturnTo("https://evil.com", BASE)).toBeNull();
    expect(safeReturnTo("javascript:alert(1)", BASE)).toBeNull();
  });

  it("rejects empty input", () => {
    expect(safeReturnTo(null, BASE)).toBeNull();
    expect(safeReturnTo("", BASE)).toBeNull();
  });
});
