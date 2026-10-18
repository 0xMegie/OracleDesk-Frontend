import { describe, expect, it } from "vitest";
import { initialWalletState, transition, viewOf, type WalletEffect, type WalletEvent, type WalletState } from "../wallet-machine";

const A = "GAAAA";
const B = "GBBBB";

/** Runs events in order and collects every effect emitted. */
function run(events: WalletEvent[], from: WalletState = initialWalletState) {
  let state = from;
  const effects: WalletEffect[] = [];
  for (const e of events) {
    const next = transition(state, e);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const types = (effects: WalletEffect[]) => effects.map((e) => e.type);

/** A state where the kit has loaded, restore found nothing, and the epoch is 0. */
const disconnected = run([{ type: "KIT_LOADED" }, { type: "RESTORED", epoch: 0, address: null, storedSessionWallet: null }]).state;

describe("wallet machine: restore", () => {
  it("restores a stored session without redirecting or prompting", () => {
    const { state, effects } = run([
      { type: "KIT_LOADED" },
      { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: A },
    ]);
    expect(state).toMatchObject({ tag: "connected", address: A, session: { wallet: A } });
    expect(types(effects)).toEqual(["restore"]);
    expect(types(effects)).not.toContain("navigate");
    expect(types(effects)).not.toContain("signIn");
  });

  it("restores with no address to disconnected", () => {
    expect(disconnected).toMatchObject({ tag: "disconnected", error: null });
  });

  it("ignores a late RESTORED after disconnect", () => {
    const connected = run([
      { type: "KIT_LOADED" },
      { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: null },
    ]).state;
    const after = run([{ type: "DISCONNECT_REQUESTED" }], connected).state;
    const late = run([{ type: "RESTORED", epoch: 0, address: A, storedSessionWallet: null }], after).state;
    expect(late).toMatchObject({ tag: "disconnected" });
  });
});

describe("wallet machine: connect", () => {
  it("connect never starts backend sign-in and redirects only with a safe returnTo", () => {
    const { state, effects } = run([
      { type: "CONNECT_REQUESTED", returnTo: "/copy-trade?traceId=x" },
      { type: "CONNECT_SUCCEEDED", epoch: 0, address: A, storedSessionWallet: null },
    ], disconnected);
    expect(state).toMatchObject({ tag: "connected", address: A, session: null });
    expect(types(effects)).not.toContain("signIn");
    expect(effects.filter((e) => e.type === "navigate")).toEqual([{ type: "navigate", to: "/copy-trade?traceId=x" }]);
  });

  it("connect without returnTo emits no navigation", () => {
    const { effects } = run([
      { type: "CONNECT_REQUESTED", returnTo: null },
      { type: "CONNECT_SUCCEEDED", epoch: 0, address: A, storedSessionWallet: null },
    ], disconnected);
    expect(types(effects)).not.toContain("navigate");
  });

  it("closing the picker yields disconnected without an error", () => {
    const { state } = run([
      { type: "CONNECT_REQUESTED", returnTo: null },
      { type: "CONNECT_FAILED", epoch: 0, silent: true, message: "closed" },
    ], disconnected);
    expect(state).toMatchObject({ tag: "disconnected", error: null });
  });

  it("a real connect failure keeps the previous account and shows the error", () => {
    const connected = run([
      { type: "KIT_LOADED" },
      { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: null },
    ]).state;
    const { state } = run([
      { type: "CONNECT_REQUESTED", returnTo: null },
      { type: "CONNECT_FAILED", epoch: 0, silent: false, message: "Wallet is locked" },
    ], connected);
    expect(state).toMatchObject({ tag: "connected", address: A, error: "Wallet is locked" });
  });

  it("the picker keeps the previous account visible while it is open", () => {
    const connected = run([
      { type: "KIT_LOADED" },
      { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: null },
    ]).state;
    const view = viewOf(run([{ type: "CONNECT_REQUESTED", returnTo: null }], connected).state);
    expect(view).toMatchObject({ address: A, isConnecting: true });
  });

  it("a connect requested before the kit loads runs once the kit has restored", () => {
    const { state, effects } = run([
      { type: "CONNECT_REQUESTED", returnTo: "/premium" },
      { type: "KIT_LOADED" },
      { type: "RESTORED", epoch: 0, address: null, storedSessionWallet: null },
    ]);
    expect(state).toMatchObject({ tag: "connecting", returnTo: "/premium" });
    expect(types(effects)).toContain("openAuthModal");
  });

  it("a kit state update during connect waits for CONNECT_SUCCEEDED", () => {
    const { state, effects } = run([
      { type: "CONNECT_REQUESTED", returnTo: "/premium" },
      { type: "KIT_STATE_UPDATED", address: A, passphrase: null, storedSessionWallet: null },
    ], disconnected);
    expect(state.tag).toBe("connecting");
    expect(effects).toEqual([{ type: "openAuthModal", epoch: 0 }]);
  });
});

describe("wallet machine: sign-in", () => {
  const connectedA = run([
    { type: "CONNECT_REQUESTED", returnTo: null },
    { type: "CONNECT_SUCCEEDED", epoch: 0, address: A, storedSessionWallet: null },
  ], disconnected).state;

  it("ensure session signs in once and resolves true on success", () => {
    const started = run([{ type: "ENSURE_SESSION" }], connectedA);
    expect(started.effects).toEqual([{ type: "signIn", epoch: 0, address: A, attempt: 1 }]);
    const done = run([{ type: "SIGNIN_SUCCEEDED", epoch: 0, attempt: 1, wallet: A }], started.state);
    expect(done.state).toMatchObject({ tag: "connected", session: { wallet: A } });
    expect(done.effects).toEqual([{ type: "resolveEnsure", ok: true }]);
  });

  it("two ENSURE_SESSION events produce one signIn effect", () => {
    const { effects } = run([{ type: "ENSURE_SESSION" }, { type: "ENSURE_SESSION" }], connectedA);
    expect(types(effects).filter((t) => t === "signIn")).toHaveLength(1);
  });

  it("ensure session when already authenticated resolves without signing in", () => {
    const authed = run([{ type: "ENSURE_SESSION" }, { type: "SIGNIN_SUCCEEDED", epoch: 0, attempt: 1, wallet: A }], connectedA).state;
    const { effects } = run([{ type: "ENSURE_SESSION" }], authed);
    expect(effects).toEqual([{ type: "resolveEnsure", ok: true }]);
  });

  it("sign-in failure keeps the account and resolves false with the message", () => {
    const failed = run(
      [{ type: "ENSURE_SESSION" }, { type: "SIGNIN_FAILED", epoch: 0, attempt: 1, message: "Login was declined" }],
      connectedA,
    );
    expect(failed.state).toMatchObject({ tag: "connected", address: A, session: null, error: "Login was declined" });
    expect(failed.effects).toEqual([{ type: "signIn", address: A, epoch: 0, attempt: 1 }, { type: "resolveEnsure", ok: false }]);
  });

  it("account change during authenticating drops the stale sign-in result", () => {
    const pending = run([{ type: "ENSURE_SESSION" }], connectedA);
    const switched = run([{ type: "KIT_STATE_UPDATED", address: B, passphrase: null, storedSessionWallet: null }], pending.state);
    expect(switched.state).toMatchObject({ tag: "connected", address: B, session: null });
    expect(types(switched.effects)).toContain("resolveEnsure");
    const late = run([{ type: "SIGNIN_SUCCEEDED", epoch: 0, attempt: 1, wallet: A }], switched.state);
    expect(late.state).toMatchObject({ tag: "connected", address: B, session: null });
  });

  it("a sign-in result for an older attempt is ignored", () => {
    const first = run([{ type: "ENSURE_SESSION" }], connectedA).state;
    const failed = run([{ type: "SIGNIN_FAILED", epoch: 0, attempt: 1, message: "x" }], first).state;
    const second = run([{ type: "ENSURE_SESSION" }], failed).state;
    const stale = run([{ type: "SIGNIN_SUCCEEDED", epoch: 0, attempt: 1, wallet: A }], second).state;
    expect(stale).toMatchObject({ tag: "authenticating", attempt: 2 });
  });

  it("a stored session for another wallet is cleared on connect", () => {
    const { effects } = run([
      { type: "CONNECT_REQUESTED", returnTo: null },
      { type: "CONNECT_SUCCEEDED", epoch: 0, address: B, storedSessionWallet: A },
    ], connectedA);
    expect(types(effects)).toContain("clearBackendSession");
  });

  it("ensure session while disconnected resolves false", () => {
    expect(run([{ type: "ENSURE_SESSION" }], disconnected).effects).toEqual([{ type: "resolveEnsure", ok: false }]);
  });
});

describe("wallet machine: disconnect and kit events", () => {
  const connectedA = run([
    { type: "KIT_LOADED" },
    { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: A },
  ]).state;

  it("disconnect clears the session, purges stellar queries and bumps the epoch", () => {
    const { state, effects } = run([{ type: "DISCONNECT_REQUESTED" }], connectedA);
    expect(state).toMatchObject({ tag: "disconnected", epoch: 1 });
    expect(types(effects)).toEqual(expect.arrayContaining(["kitDisconnect", "clearBackendSession", "purgeStellarQueries"]));
  });

  it("KIT_DISCONNECTED clears session and purges stellar queries", () => {
    const { state, effects } = run([{ type: "KIT_DISCONNECTED" }], connectedA);
    expect(state).toMatchObject({ tag: "disconnected" });
    expect(types(effects)).toEqual(expect.arrayContaining(["clearBackendSession", "purgeStellarQueries"]));
  });

  it("the kit's launch notification for the restored account is not an account change", () => {
    const { state, effects } = run([
      { type: "KIT_STATE_UPDATED", address: A, passphrase: "Test SDF Network ; September 2015", storedSessionWallet: A },
    ], connectedA);
    expect(state).toMatchObject({ tag: "connected", address: A, session: { wallet: A }, network: "Test SDF Network ; September 2015" });
    expect(effects).toEqual([]);
  });

  it("network reports from a previous epoch are ignored", () => {
    const after = run([{ type: "DISCONNECT_REQUESTED" }], connectedA).state;
    const { state } = run([{ type: "NETWORK_REPORTED", epoch: 0, address: A, passphrase: "Other" }], after);
    expect(state).toMatchObject({ tag: "disconnected", epoch: 1 });
  });
});

describe("wallet machine: invariants", () => {
  // Every event kind, with an epoch that matches the starting state, so the
  // interesting branches are reachable from any state.
  const alphabet = (epoch: number): WalletEvent[] => [
    { type: "KIT_LOADED" },
    { type: "RESTORED", epoch, address: A, storedSessionWallet: A },
    { type: "CONNECT_REQUESTED", returnTo: "/premium" },
    { type: "CONNECT_SUCCEEDED", epoch, address: A, storedSessionWallet: null },
    { type: "CONNECT_FAILED", epoch, silent: true, message: "closed" },
    { type: "KIT_STATE_UPDATED", address: A, passphrase: null, storedSessionWallet: null },
    { type: "KIT_DISCONNECTED" },
    { type: "ENSURE_SESSION" },
    { type: "SIGNIN_SUCCEEDED", epoch, attempt: 1, wallet: A },
    { type: "SIGNIN_FAILED", epoch, attempt: 1, message: "no" },
    { type: "DISCONNECT_REQUESTED" },
  ];

  it("no event sequence without CONNECT_REQUESTED ever emits navigate", () => {
    // Every sequence of up to 4 events from the alphabet, after a restore.
    // Restore and kit events alone must never redirect; only a connect the
    // user started may (its CONNECT_REQUESTED is the only way into "connecting").
    const events = alphabet(0).filter((e) => e.type !== "CONNECT_REQUESTED");
    let sequences: WalletEvent[][] = [[]];
    for (let depth = 0; depth < 4; depth++) {
      sequences = sequences.flatMap((seq) => events.map((e) => [...seq, e]));
      for (const seq of sequences) {
        const { effects } = run([{ type: "KIT_LOADED" }, { type: "RESTORED", epoch: 0, address: A, storedSessionWallet: A }, ...seq]);
        expect(types(effects)).not.toContain("navigate");
      }
    }
  });
});
