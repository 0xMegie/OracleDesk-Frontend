/**
 * Cross-tab synchronization for wallet and session state.
 * Uses BroadcastChannel for real-time sync and storage events as fallback.
 */

export interface SyncMessage {
  type: "auth_session_changed" | "wallet_disconnected" | "wallet_changed";
  address?: string | null;
  token?: string | null;
  timestamp: number;
}

/**
 * Create a BroadcastChannel for cross-tab sync, with graceful fallback to storage events.
 */
export function createCrossTabSync(onMessage: (msg: SyncMessage) => void) {
  const unsubscribe: Array<() => void> = [];

  // Try to use BroadcastChannel (not supported in all browsers)
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel("oracledesk-wallet-sync");
    channel.addEventListener("message", (event) => {
      onMessage(event.data as SyncMessage);
    });
    unsubscribe.push(() => {
      channel?.close();
    });
  } catch {
    // BroadcastChannel not available, fall back to storage events
  }

  // Fallback: listen for storage events from other tabs
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === "oracledesk_wallet") {
      onMessage({
        type: "wallet_changed",
        address: event.newValue,
        timestamp: Date.now(),
      });
    } else if (event.key === "oracledesk_token") {
      onMessage({
        type: "auth_session_changed",
        token: event.newValue || undefined,
        timestamp: Date.now(),
      });
    }
  };

  if (!channel) {
    window.addEventListener("storage", handleStorageChange);
    unsubscribe.push(() => {
      window.removeEventListener("storage", handleStorageChange);
    });
  }

  return {
    /**
     * Broadcast a message to other tabs.
     */
    broadcast(msg: SyncMessage) {
      if (channel) {
        channel.postMessage(msg);
      }
      // Storage events are automatic when localStorage changes
    },

    /**
     * Stop listening for sync messages.
     */
    unsubscribe: () => {
      unsubscribe.forEach((fn) => fn());
    },
  };
}

/**
 * Broadcast session change to other tabs.
 */
export function broadcastSessionChange(token: string | null, address: string | null) {
  if (typeof window === "undefined") return;

  try {
    const channel = new BroadcastChannel("oracledesk-wallet-sync");
    channel.postMessage({
      type: "auth_session_changed",
      token,
      address,
      timestamp: Date.now(),
    } as SyncMessage);
    channel.close();
  } catch {
    // BroadcastChannel not available; storage events will handle it
  }
}

/**
 * Broadcast wallet disconnection to other tabs.
 */
export function broadcastWalletDisconnect() {
  if (typeof window === "undefined") return;

  try {
    const channel = new BroadcastChannel("oracledesk-wallet-sync");
    channel.postMessage({
      type: "wallet_disconnected",
      timestamp: Date.now(),
    } as SyncMessage);
    channel.close();
  } catch {
    // BroadcastChannel not available
  }
}
