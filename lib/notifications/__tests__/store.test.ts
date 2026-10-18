import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInbox, type InboxItem } from "../store";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
const item = (id: string, owner = "A", network = "test"): InboxItem => ({ id, owner, network, kind: "fill", createdAt: Number(id) || 1, readAt: null, data: {} });
describe("persisted wallet inbox", () => {
  it("put is idempotent and preserves readAt across reconnecting", async () => {
    let store = await openInbox("A", "test"); await store.put([item("1"), item("1")]);
    await store.markRead(["1"]); store.close(); store = await openInbox("A", "test");
    await store.put([item("1")]); expect(await store.list()).toHaveLength(1); expect((await store.list())[0].readAt).not.toBeNull();
    expect(await store.unreadCount()).toBe(0); store.close();
  });
  it("isolates owners and networks, including metadata and clear/read actions", async () => {
    const a = await openInbox("A", "test"), b = await openInbox("B", "test"), main = await openInbox("A", "main");
    await a.put([item("1"), item("foreign", "B")]); await b.put([item("2", "B")]); await main.put([item("3", "A", "main")]);
    await a.setMeta("ledger", "4"); await a.markAllRead();
    expect(await a.unreadCount()).toBe(0); expect(await b.unreadCount()).toBe(1); expect(await main.unreadCount()).toBe(1);
    expect(await b.getMeta("ledger")).toBeUndefined(); expect((await a.list()).map(x => x.id)).toEqual(["1"]);
    [a, b, main].forEach(store => store.close());
  });
  it("prunes oldest read items first and caps even a wholly unread inbox", async () => {
    const store = await openInbox("prune", "test"); await store.put([1, 2, 3, 4].map(id => item(String(id), "prune")));
    await store.markRead(["3", "4"]); await store.prune(2); expect((await store.list()).map(x => x.id)).toEqual(["2", "1"]);
    await store.put([item("5", "prune")]); await store.prune(2); expect((await store.list()).map(x => x.id)).toEqual(["5", "2"]); store.close();
  });
  it("falls back to memory if IndexedDB is unavailable and retains read state", async () => {
    vi.stubGlobal("indexedDB", { open() { throw new Error("private browsing"); } });
    const store = await openInbox("fallback", "test"); expect(store.persistent).toBe(false);
    await store.put([item("1", "fallback")]); await store.markAllRead(); await store.put([item("1", "fallback")]);
    expect(await store.unreadCount()).toBe(0); expect(await store.list()).toHaveLength(1); store.close();
  });
});
