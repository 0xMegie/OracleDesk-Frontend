export type InboxKind = "fill" | "redeemable" | "redeemed" | "trace" | "tx-failed" | "tx-pending";
export interface InboxItem {
  id: string; owner: string; network: string; kind: InboxKind; marketId?: string; txHash?: string; ledger?: number;
  createdAt: number; readAt: number | null; data: Record<string, string>;
}
export interface Inbox {
  readonly persistent: boolean;
  put(items: InboxItem[]): Promise<void>;
  list(opts?: { limit?: number }): Promise<InboxItem[]>;
  markRead(ids: string[]): Promise<void>;
  markAllRead(): Promise<void>;
  remove(ids: string[]): Promise<void>;
  unreadCount(): Promise<number>;
  prune(max: number): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): void;
}
const memory = new Map<string, { items: Map<string, InboxItem>; meta: Map<string, string> }>();
const newest = (items: Iterable<InboxItem>) => [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oracledesk-inbox", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const items = db.createObjectStore("items", { keyPath: ["owner", "network", "id"] });
      items.createIndex("scope", ["owner", "network"]);
      items.createIndex("createdAt", ["owner", "network", "createdAt"]);
      items.createIndex("readAt", ["owner", "network", "readAt"]);
      db.createObjectStore("meta", { keyPath: ["owner", "network", "key"] });
    };
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error("Inbox database is blocked")); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
}

export async function openInbox(owner: string, network: string): Promise<Inbox> {
  const scope = JSON.stringify([owner, network]);
  let fallback = memory.get(scope);
  if (!fallback) { fallback = { items: new Map(), meta: new Map() }; memory.set(scope, fallback); }
  const local = fallback;
  let db: IDBDatabase | null;
  try { db = await connect(); } catch { db = null; }
  let closed = false;
  if (db) db.onversionchange = () => { db?.close(); db = null; };
  const matches = (item: InboxItem) => item.owner === owner && item.network === network;
  function transaction<T>(storeName: string, run: (store: IDBObjectStore, result: (v: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db!.transaction(storeName, "readwrite");
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Inbox transaction aborted"));
      run(tx.objectStore(storeName), v => { value = v; });
    });
  }
  async function safe<T>(action: () => Promise<T>, offline: () => T): Promise<T> {
    if (closed) throw new Error("Inbox is closed");
    if (db) {
      try { return await action(); }
      catch { db.close(); db = null; }
    }
    return offline();
  }
  const all = () => newest(local.items.values());
  const readItems = () => safe(() => transaction<InboxItem[]>("items", (store, result) => {
    const request = store.index("scope").getAll(IDBKeyRange.only([owner, network]));
    request.onsuccess = () => {
      const items = (request.result as InboxItem[]).filter(matches);
      local.items.clear();
      items.forEach(item => local.items.set(item.id, item));
      result(newest(items));
    };
  }), all);
  const remove = async (ids: string[]) => {
    await safe(() => transaction<void>("items", store => { ids.forEach(id => store.delete([owner, network, id])); }), () => undefined);
    ids.forEach(id => local.items.delete(id));
  };
  const mark = async (ids: string[] | null) => {
    const now = Date.now();
    await safe(() => transaction<void>("items", store => {
      const request = store.index("scope").getAll(IDBKeyRange.only([owner, network]));
      request.onsuccess = () => {
        for (const item of request.result as InboxItem[]) {
          if (matches(item) && item.readAt === null && (ids === null || ids.includes(item.id))) {
            const next = { ...item, readAt: now }; store.put(next); local.items.set(item.id, next);
          }
        }
      };
    }), () => undefined);
    for (const [id, item] of local.items) if (item.readAt === null && (ids === null || ids.includes(id))) local.items.set(id, { ...item, readAt: now });
  };
  return {
    get persistent() { return db !== null; },
    async put(items) {
      const own = items.filter(matches);
      await safe(() => transaction<void>("items", store => {
        // Deduplicate inside the transaction so two copies in one batch keep readAt.
        for (const item of new Map(own.map(item => [item.id, item])).values()) {
          const request = store.get([owner, network, item.id]);
          request.onsuccess = () => {
            const previous = request.result as InboxItem | undefined;
            const next = { ...item, createdAt: previous?.createdAt ?? item.createdAt, readAt: previous?.readAt ?? item.readAt };
            store.put(next); local.items.set(item.id, next);
          };
        }
      }), () => undefined);
      for (const item of own) {
        const previous = local.items.get(item.id);
        local.items.set(item.id, { ...item, createdAt: previous?.createdAt ?? item.createdAt, readAt: previous?.readAt ?? item.readAt });
      }
    },
    async list(opts) { return (await readItems()).slice(0, opts?.limit ?? Infinity); },
    markRead: ids => mark(ids), markAllRead: () => mark(null), remove,
    async unreadCount() { return (await readItems()).filter(item => item.readAt === null).length; },
    async prune(max) {
      const items = await readItems();
      const removeCount = Math.max(0, items.length - max);
      const oldestFirst = items.sort((a, b) => Number(a.readAt === null) - Number(b.readAt === null) || a.createdAt - b.createdAt);
      await remove(oldestFirst.slice(0, removeCount).map(item => item.id));
    },
    async getMeta(key) {
      return safe(() => transaction<string | undefined>("meta", (store, result) => {
        const request = store.get([owner, network, key]);
        request.onsuccess = () => { const value = request.result?.value; if (typeof value === "string") local.meta.set(key, value); result(value); };
      }), () => local.meta.get(key));
    },
    async setMeta(key, value) {
      await safe(() => transaction<void>("meta", store => { store.put({ owner, network, key, value }); }), () => undefined);
      local.meta.set(key, value);
    },
    close() { closed = true; db?.close(); db = null; },
  };
}
