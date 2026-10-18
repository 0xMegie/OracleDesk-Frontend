import { describe, expect, it } from "vitest";
import { Ring } from "../ring";

const key = (x: { id: string }) => x.id;

describe("Ring", () => {
  it("keeps the newest capacity items", () => {
    const r = new Ring(3, key).pushMany([{ id: "a" }, { id: "b" }]).pushMany([{ id: "c" }, { id: "d" }]);
    expect(r.toArray().map(key)).toEqual(["c", "d", "a"]);
  });

  it("dedupes by key", () => {
    const r = new Ring(5, key).pushMany([{ id: "a" }]).pushMany([{ id: "a" }, { id: "b" }]);
    expect(r.toArray().map(key)).toEqual(["b", "a"]);
  });

  it("returns the same ring when nothing changes", () => {
    const r = new Ring(5, key).pushMany([{ id: "a" }]);
    expect(r.pushMany([{ id: "a" }])).toBe(r);
    expect(r.pushMany([])).toBe(r);
  });
});
