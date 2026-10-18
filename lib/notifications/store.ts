/**
 * Per-wallet, per-network notification inbox persisted in IndexedDB
 * (issue #42). Falls back to an in-memory store when IndexedDB is
 * unavailable (private mode, quota, prerender).
 */

export type InboxKind = "fill" | "redeemable" | "redeemed" | "trace" | "tx-failed" | "tx-pending";

export interface InboxItem {
  /** Deterministic: `${kind}:${eventId|marketId|txHash}`. */
  id: string;
  owner: string;
  network: string;
  kind: InboxKind;
  marketId?: string;
  txHash?: string;
  ledger?: number;
  /** Ledger close time if known, else receipt time. */
  createdAt: number;
  readAt: number | null;
  /** bigint values as decimal strings. */
  data: Record<string, string>;
}

export interface ListOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export interface Inbox {
  readonly persistent: boolean;
  put(items: InboxItem[]): Promise<void>;
  list(opts?: ListOptions): Promise<InboxItem[]>;
  markRead(ids: string[]): Promise<void>;
  markAllRead(): Promise<void>;
  unreadCount(): Promise<number>;
  prune(max: number): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): void;
}

export const DB_NAME = "oracledesk-inbox";
const DB_VERSION = 1;
const ITEMS = "items";
const META = "meta";
export const MAX_ITEMS = 500;

const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const byNewest = (a: InboxItem, b: InboxItem) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/** Shared ordering/merge rules so both backends behave identically. */
function mergeItem(existing: InboxItem | undefined, incoming: InboxItem): InboxItem {
  // Idempotent on id; never resets readAt.
  if (!existing) return incoming;
  return { ...incoming, readAt: existing.readAt ?? incoming.readAt, createdAt: Math.min(existing.createdAt, incoming.createdAt) };
}

function pruneOrder(items: InboxItem[], max: number): InboxItem[] {
  if (items.length <= max) return [];
  // Oldest read items go first; unread items only if still over the cap.
  const read = items.filter((i) => i.readAt !== null).sort((a, b) => a.createdAt - b.createdAt);
  const unread = items.filter((i) => i.readAt === null).sort((a, b) => a.createdAt - b.createdAt);
  return [...read, ...unread].slice(0, items.length - max);
}

export function createMemoryInbox(owner: string, network: string): Inbox {
  const items = new Map<string, InboxItem>();
  const meta = new Map<string, string>();
  return {
    persistent: false,
    async put(list) {
      for (const it of list) {
        if (it.owner !== owner || it.network !== network) continue;
        items.set(it.id, mergeItem(items.get(it.id), it));
      }
    },
    async list(opts = {}) {
      let out = [...items.values()].sort(byNewest);
      if (opts.unreadOnly) out = out.filter((i) => i.readAt === null);
      return opts.limit ? out.slice(0, opts.limit) : out;
    },
    async markRead(ids) {
      const now = Date.now();
      for (const id of ids) {
        const it = items.get(id);
        if (it && it.readAt === null) items.set(id, { ...it, readAt: now });
      }
    },
    async markAllRead() {
      const now = Date.now();
      for (const [id, it] of items) if (it.readAt === null) items.set(id, { ...it, readAt: now });
    },
    async unreadCount() {
      let n = 0;
      for (const it of items.values()) if (it.readAt === null) n++;
      return n;
    },
    async prune(max) {
      for (const it of pruneOrder([...items.values()], max)) items.delete(it.id);
    },
    async getMeta(key) {
      return meta.get(key);
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
    close() {},
  };
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(ITEMS)) {
        const store = db.createObjectStore(ITEMS, { keyPath: ["owner", "network", "id"] });
        store.createIndex("byCreated", ["owner", "network", "createdAt"]);
        store.createIndex("byOwner", ["owner", "network"]);
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: ["owner", "network", "key"] });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function createIdbInbox(db: IDBDatabase, owner: string, network: string): Inbox {
  const range = () => IDBKeyRange.only([owner, network]);

  const all = async (): Promise<InboxItem[]> => {
    const tx = db.transaction(ITEMS, "readonly");
    return req(tx.objectStore(ITEMS).index("byOwner").getAll(range())) as Promise<InboxItem[]>;
  };

  return {
    persistent: true,
    async put(list) {
      const mine = list.filter((it) => it.owner === owner && it.network === network);
      if (mine.length === 0) return;
      const tx = db.transaction(ITEMS, "readwrite");
      const store = tx.objectStore(ITEMS);
      for (const it of mine) {
        const getReq = store.get([owner, network, it.id]);
        getReq.onsuccess = () => store.put(mergeItem(getReq.result as InboxItem | undefined, it));
      }
      await done(tx);
    },
    async list(opts = {}) {
      let out = (await all()).sort(byNewest);
      if (opts.unreadOnly) out = out.filter((i) => i.readAt === null);
      return opts.limit ? out.slice(0, opts.limit) : out;
    },
    async markRead(ids) {
      const now = Date.now();
      const tx = db.transaction(ITEMS, "readwrite");
      const store = tx.objectStore(ITEMS);
      for (const id of ids) {
        const getReq = store.get([owner, network, id]);
        getReq.onsuccess = () => {
          const it = getReq.result as InboxItem | undefined;
          if (it && it.readAt === null) store.put({ ...it, readAt: now });
        };
      }
      await done(tx);
    },
    async markAllRead() {
      const items = await all();
      await this.markRead(items.filter((i) => i.readAt === null).map((i) => i.id));
    },
    async unreadCount() {
      return (await all()).filter((i) => i.readAt === null).length;
    },
    async prune(max) {
      const victims = pruneOrder(await all(), max);
      if (victims.length === 0) return;
      const tx = db.transaction(ITEMS, "readwrite");
      for (const it of victims) tx.objectStore(ITEMS).delete([owner, network, it.id]);
      await done(tx);
    },
    async getMeta(key) {
      const tx = db.transaction(META, "readonly");
      const row = (await req(tx.objectStore(META).get([owner, network, key]))) as { value: string } | undefined;
      return row?.value;
    },
    async setMeta(key, value) {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).put({ owner, network, key, value });
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Opens the inbox for one address on one network. Call only from effects:
 * IndexedDB does not exist during prerender.
 */
export async function openInbox(
  owner: string,
  network: string,
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
): Promise<Inbox> {
  if (!factory) return createMemoryInbox(owner, network);
  try {
    const db = await openDb(factory);
    return createIdbInbox(db, owner, network);
  } catch {
    return createMemoryInbox(owner, network);
  }
}
