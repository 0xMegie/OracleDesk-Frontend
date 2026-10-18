/**
 * Pure state machine behind WalletProvider. No React, no SDK types: the
 * provider feeds events in, and runs the effects that come out.
 *
 * Every async result carries the `epoch` it was started in. A disconnect
 * bumps the epoch, so late results from before it are ignored.
 */

export interface SessionInfo {
  wallet: string;
}

export interface PendingConnect {
  returnTo: string | null;
}

export type WalletState =
  | { tag: "loading-kit"; epoch: number; pendingConnect: PendingConnect | null }
  | { tag: "restoring"; epoch: number; pendingConnect: PendingConnect | null }
  | { tag: "disconnected"; epoch: number; error: string | null }
  | {
      tag: "connecting";
      epoch: number;
      returnTo: string | null;
      /** The connected state to fall back to if the picker is closed. */
      previous: ConnectedState | null;
    }
  | ConnectedState
  | {
      tag: "authenticating";
      epoch: number;
      address: string;
      network: string | null;
      /** Sign-in attempt number. Results for any other attempt are stale. */
      attempt: number;
    };

export interface ConnectedState {
  tag: "connected";
  epoch: number;
  address: string;
  network: string | null;
  session: SessionInfo | null;
  attempt: number;
  error: string | null;
}

export type WalletEvent =
  | { type: "KIT_LOADED" }
  | { type: "KIT_FAILED"; error: string }
  | { type: "RESTORED"; epoch: number; address: string | null; storedSessionWallet: string | null }
  | { type: "CONNECT_REQUESTED"; returnTo: string | null }
  | { type: "CONNECT_SUCCEEDED"; epoch: number; address: string; storedSessionWallet: string | null }
  /** `silent` is true for a closed picker or a rejected request: not an error to show. */
  | { type: "CONNECT_FAILED"; epoch: number; silent: boolean; message: string }
  | { type: "NETWORK_REPORTED"; epoch: number; address: string; passphrase: string | null }
  | { type: "KIT_STATE_UPDATED"; address: string | null; passphrase: string | null; storedSessionWallet: string | null }
  | { type: "KIT_DISCONNECTED" }
  /** Another tab issued or cleared the backend session for `wallet`. */
  | { type: "SESSION_SYNCED"; wallet: string | null }
  | { type: "ENSURE_SESSION" }
  | { type: "SIGNIN_SUCCEEDED"; epoch: number; attempt: number; wallet: string }
  | { type: "SIGNIN_FAILED"; epoch: number; attempt: number; message: string }
  | { type: "DISCONNECT_REQUESTED" };

export type WalletEffect =
  | { type: "restore"; epoch: number }
  | { type: "openAuthModal"; epoch: number }
  | { type: "queryNetwork"; epoch: number; address: string }
  | { type: "signIn"; epoch: number; address: string; attempt: number }
  | { type: "clearBackendSession" }
  | { type: "kitDisconnect" }
  | { type: "purgeStellarQueries" }
  | { type: "navigate"; to: string }
  | { type: "resolveEnsure"; ok: boolean }
  | { type: "resolveConnect"; ok: boolean };

export interface Transition {
  state: WalletState;
  effects: WalletEffect[];
}

export const initialWalletState: WalletState = { tag: "loading-kit", epoch: 0, pendingConnect: null };

const stay = (state: WalletState): Transition => ({ state, effects: [] });

const sessionFor = (wallet: string | null): SessionInfo | null => (wallet ? { wallet } : null);

/** A backend session is only ever reused for the wallet it was issued to. */
const isAuthenticatedState = (s: WalletState): boolean =>
  s.tag === "connected" && s.session?.wallet === s.address;

export function transition(s: WalletState, e: WalletEvent): Transition {
  switch (e.type) {
    case "KIT_LOADED":
      if (s.tag !== "loading-kit") return stay(s);
      return {
        state: { tag: "restoring", epoch: s.epoch, pendingConnect: s.pendingConnect },
        effects: [{ type: "restore", epoch: s.epoch }],
      };

    case "KIT_FAILED":
      if (s.tag !== "loading-kit") return stay(s);
      return {
        state: { tag: "disconnected", epoch: s.epoch, error: e.error },
        effects: [{ type: "resolveConnect", ok: false }],
      };

    case "RESTORED": {
      // Restore never redirects and never prompts: it only reads state.
      if (s.tag !== "restoring" || e.epoch !== s.epoch) return stay(s);
      const restored: WalletState = e.address
        ? {
            tag: "connected",
            epoch: s.epoch,
            address: e.address,
            network: null,
            session: sessionFor(e.storedSessionWallet),
            attempt: 0,
            error: null,
          }
        : { tag: "disconnected", epoch: s.epoch, error: null };
      // A connect requested while the kit was still restoring runs now.
      if (s.pendingConnect) return transition(restored, { type: "CONNECT_REQUESTED", returnTo: s.pendingConnect.returnTo });
      return stay(restored);
    }

    case "CONNECT_REQUESTED":
      switch (s.tag) {
        case "loading-kit":
        case "restoring":
          return stay({ ...s, pendingConnect: { returnTo: e.returnTo } });
        case "connecting":
          // The picker is already open; the caller waits for that result.
          return stay(s);
        case "authenticating":
          // Sign-in in flight: abandon it, the picker takes over.
          return {
            state: { tag: "connecting", epoch: s.epoch, returnTo: e.returnTo, previous: null },
            effects: [{ type: "resolveEnsure", ok: false }, { type: "openAuthModal", epoch: s.epoch }],
          };
        case "connected":
          return {
            state: { tag: "connecting", epoch: s.epoch, returnTo: e.returnTo, previous: s },
            effects: [{ type: "openAuthModal", epoch: s.epoch }],
          };
        case "disconnected":
          return {
            state: { tag: "connecting", epoch: s.epoch, returnTo: e.returnTo, previous: null },
            effects: [{ type: "openAuthModal", epoch: s.epoch }],
          };
      }

    case "CONNECT_SUCCEEDED": {
      if (s.tag !== "connecting" || e.epoch !== s.epoch) return stay(s);
      // The connect itself never signs in: that waits for ENSURE_SESSION.
      const effects: WalletEffect[] = [
        { type: "queryNetwork", epoch: s.epoch, address: e.address },
        { type: "resolveConnect", ok: true },
      ];
      if (e.storedSessionWallet && e.storedSessionWallet !== e.address) effects.push({ type: "clearBackendSession" });
      if (s.returnTo) effects.push({ type: "navigate", to: s.returnTo });
      return {
        state: {
          tag: "connected",
          epoch: s.epoch,
          address: e.address,
          network: null,
          session: e.storedSessionWallet === e.address ? sessionFor(e.address) : null,
          attempt: s.previous?.attempt ?? 0,
          error: null,
        },
        effects,
      };
    }

    case "CONNECT_FAILED": {
      if (s.tag !== "connecting" || e.epoch !== s.epoch) return stay(s);
      const error = e.silent ? null : e.message;
      const fallback: WalletState = s.previous
        ? { ...s.previous, error }
        : { tag: "disconnected", epoch: s.epoch, error };
      return { state: fallback, effects: [{ type: "resolveConnect", ok: false }] };
    }

    case "NETWORK_REPORTED":
      if (e.epoch !== s.epoch) return stay(s);
      if ((s.tag === "connected" || s.tag === "authenticating") && s.address === e.address) {
        return stay({ ...s, network: e.passphrase ?? s.network });
      }
      return stay(s);

    case "KIT_STATE_UPDATED": {
      // Restore and connect own the first answer; the kit's launch
      // notification is not an account change.
      if (s.tag === "loading-kit" || s.tag === "restoring" || s.tag === "connecting") return stay(s);
      const clear: WalletEffect[] =
        e.address && e.storedSessionWallet && e.storedSessionWallet !== e.address
          ? [{ type: "clearBackendSession" }]
          : [];
      if (!e.address) {
        const effects: WalletEffect[] =
          s.tag === "authenticating" ? [{ type: "resolveEnsure", ok: false }] : [];
        return { state: { tag: "disconnected", epoch: s.epoch, error: null }, effects };
      }
      if ((s.tag === "connected" || s.tag === "authenticating") && s.address === e.address) {
        return stay({ ...s, network: e.passphrase ?? s.network });
      }
      // A different account (or a first account after disconnect): no session carries over.
      const effects: WalletEffect[] = [...clear];
      if (s.tag === "authenticating") effects.push({ type: "resolveEnsure", ok: false });
      return {
        state: {
          tag: "connected",
          epoch: s.epoch,
          address: e.address,
          network: e.passphrase,
          session: e.storedSessionWallet === e.address ? sessionFor(e.address) : null,
          attempt: "attempt" in s ? s.attempt : 0,
          error: null,
        },
        effects,
      };
    }

    case "KIT_DISCONNECTED": {
      const epoch = s.epoch + 1;
      const effects: WalletEffect[] = [
        { type: "clearBackendSession" },
        { type: "purgeStellarQueries" },
        { type: "resolveEnsure", ok: false },
        { type: "resolveConnect", ok: false },
      ];
      return { state: { tag: "disconnected", epoch, error: null }, effects };
    }

    case "SESSION_SYNCED": {
      if (s.tag !== "connected") return stay(s);
      return stay({ ...s, session: e.wallet === s.address ? sessionFor(e.wallet) : null });
    }

    case "ENSURE_SESSION": {
      if (s.tag === "connected") {
        if (isAuthenticatedState(s)) return { state: s, effects: [{ type: "resolveEnsure", ok: true }] };
        const attempt = s.attempt + 1;
        return {
          state: { tag: "authenticating", epoch: s.epoch, address: s.address, network: s.network, attempt },
          effects: [{ type: "signIn", epoch: s.epoch, address: s.address, attempt }],
        };
      }
      // Single-flight: a sign-in already in progress is shared, not repeated.
      if (s.tag === "authenticating") return stay(s);
      return { state: s, effects: [{ type: "resolveEnsure", ok: false }] };
    }

    case "SIGNIN_SUCCEEDED": {
      if (s.tag !== "authenticating" || e.epoch !== s.epoch || e.attempt !== s.attempt) return stay(s);
      // A login for a different wallet than the one in the kit is not ours to keep.
      if (e.wallet !== s.address) return stay(s);
      return {
        state: {
          tag: "connected",
          epoch: s.epoch,
          address: s.address,
          network: s.network,
          session: sessionFor(e.wallet),
          attempt: s.attempt,
          error: null,
        },
        effects: [{ type: "resolveEnsure", ok: true }],
      };
    }

    case "SIGNIN_FAILED": {
      if (s.tag !== "authenticating" || e.epoch !== s.epoch || e.attempt !== s.attempt) return stay(s);
      return {
        state: {
          tag: "connected",
          epoch: s.epoch,
          address: s.address,
          network: s.network,
          session: null,
          attempt: s.attempt,
          error: e.message,
        },
        effects: [{ type: "resolveEnsure", ok: false }],
      };
    }

    case "DISCONNECT_REQUESTED": {
      const effects: WalletEffect[] = [
        { type: "kitDisconnect" },
        { type: "clearBackendSession" },
        { type: "purgeStellarQueries" },
        { type: "resolveEnsure", ok: false },
        { type: "resolveConnect", ok: false },
      ];
      return { state: { tag: "disconnected", epoch: s.epoch + 1, error: null }, effects };
    }
  }
}

/** The fields WalletContextValue exposes, derived from the state. */
export interface WalletView {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  walletNetworkPassphrase: string | null;
  isAuthenticated: boolean;
  error: string | null;
}

export function viewOf(s: WalletState): WalletView {
  const base = { walletNetworkPassphrase: null, isAuthenticated: false, error: null } as const;
  switch (s.tag) {
    case "loading-kit":
    case "restoring":
      return { ...base, address: null, isConnected: false, isConnecting: s.pendingConnect !== null };
    case "disconnected":
      return { ...base, address: null, isConnected: false, isConnecting: false, error: s.error };
    case "connecting":
      // Keep showing the account the user already had while the picker is open.
      if (s.previous) return { ...viewOf(s.previous), isConnecting: true };
      return { ...base, address: null, isConnected: false, isConnecting: true };
    case "authenticating":
      return {
        address: s.address,
        isConnected: true,
        isConnecting: false,
        walletNetworkPassphrase: s.network,
        isAuthenticated: false,
        error: null,
      };
    case "connected":
      return {
        address: s.address,
        isConnected: true,
        isConnecting: false,
        walletNetworkPassphrase: s.network,
        isAuthenticated: isAuthenticatedState(s),
        error: s.error,
      };
  }
}
