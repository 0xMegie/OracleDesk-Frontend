import { describe, expect, it } from "vitest";
import { createMemoryInbox, openInbox, type InboxItem } from "../store";

const NET = "Test SDF Network ; September 2015";
const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  owner: "GA",
  network: NET,
  kind: "fill",
  createdAt: 1,
  readAt: null,
  data: {},
  ...over,
});

describe("inbox store (memory backend; same merge rules as IndexedDB)", () => {
  it("put is idempotent and keeps readAt", async () => {
    const inbox = createMemoryInbox("GA", NET);
    await inbox.put([item("fill:1")]);
    await inbox.markRead(["fill:1"]);
    await inbox.put([item("fill:1")]);
    const [stored] = await inbox.list();
    expect(stored.readAt).not.toBeNull();
    expect(await inbox.list()).toHaveLength(1);
  });

  it("isolates by owner and network", async () => {
    const inbox = createMemoryInbox("GA", NET);
    await inbox.put([item("a"), item("b", { owner: "GB" }), item("c", { network: "Public Global Stellar Network ; September 2015" })]);
    expect((await inbox.list()).map((i) => i.id)).toEqual(["a"]);
  });

  it("counts unread", async () => {
    const inbox = createMemoryInbox("GA", NET);
    await inbox.put([item("a"), item("b"), item("c")]);
    await inbox.markRead(["a"]);
    expect(await inbox.unreadCount()).toBe(2);
    await inbox.markAllRead();
    expect(await inbox.unreadCount()).toBe(0);
  });

  it("prune drops the oldest read items first and keeps unread", async () => {
    const inbox = createMemoryInbox("GA", NET);
    await inbox.put([item("old-read", { createdAt: 1 }), item("old-unread", { createdAt: 2 }), item("new", { createdAt: 3 })]);
    await inbox.markRead(["old-read"]);
    await inbox.prune(2);
    expect((await inbox.list()).map((i) => i.id).sort()).toEqual(["new", "old-unread"]);
  });

  it("falls back to memory when indexedDB throws", async () => {
    const broken = { open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory;
    const inbox = await openInbox("GA", NET, broken);
    expect(inbox.persistent).toBe(false);
    await inbox.put([item("a")]);
    expect(await inbox.unreadCount()).toBe(1);
  });

  it("falls back to memory when indexedDB is unavailable", async () => {
    const inbox = await openInbox("GA", NET, undefined);
    expect(inbox.persistent).toBe(false);
  });
});
