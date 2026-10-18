/**
 * Runs the wallet state machine: holds the current state, feeds events to
 * `transition`, and carries out the effects it returns against a kit adapter.
 * No React here, so tests can drive it with a scripted adapter. WalletProvider
 * subscribes to it with useSyncExternalStore.
 */
import { transition, initialWalletState, type WalletEffect, type WalletEvent, type WalletState } from "./wallet-machine";
import type { WalletKitAdapter } from "./wallet-kit-adapter";

export interface WalletInterpreterDeps {
  /** Loads the kit. Called once, on start (browser only). */
  loadKit: () => Promise<WalletKitAdapter>;
  storedSessionWallet: () => string | null;
  clearBackendSession: () => void;
  /** Runs the backend challenge login for `address`; resolves with the wallet it signed in as. */
  signIn: (address: string, signTransaction: WalletKitAdapter["signTransaction"]) => Promise<string>;
  purgeStellarQueries: () => void;
  navigate: (to: string) => void;
  /** Turns a thrown value into a plain message. */
  describe: (err: unknown) => { kind: string; message: string };
}

export class WalletInterpreter {
  private state: WalletState = initialWalletState;
  private readonly listeners = new Set<() => void>();
  private readonly ensureWaiters: Array<(ok: boolean) => void> = [];
  private readonly connectWaiters: Array<(ok: boolean) => void> = [];
  private kitPromise: Promise<WalletKitAdapter> | null = null;
  private started = false;
  /** Bumped on every start and stop, so a late kit load from an old run is ignored. */
  private generation = 0;
  private unsubscribeKit: Array<() => void> = [];

  constructor(private readonly deps: WalletInterpreterDeps) {}

  getState = (): WalletState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Loads the kit, subscribes to its events and restores a session. Returns the teardown. */
  start = (): (() => void) => {
    if (this.started) return this.stop;
    this.started = true;
    const generation = ++this.generation;
    this.kit().then(
      (kit) => {
        if (generation !== this.generation) return;
        this.unsubscribeKit = [
          kit.onStateUpdated(({ address, passphrase }) =>
            this.send({
              type: "KIT_STATE_UPDATED",
              address,
              passphrase,
              storedSessionWallet: this.deps.storedSessionWallet(),
            }),
          ),
          kit.onDisconnect(() => this.send({ type: "KIT_DISCONNECTED" })),
        ];
        this.send({ type: "KIT_LOADED" });
      },
      (err) => this.send({ type: "KIT_FAILED", error: this.deps.describe(err).message }),
    );
    return this.stop;
  };

  stop = (): void => {
    this.generation++;
    this.started = false;
    this.unsubscribeKit.forEach((fn) => fn());
    this.unsubscribeKit = [];
  };

  send = (event: WalletEvent): void => {
    const next = transition(this.state, event);
    this.state = next.state;
    this.listeners.forEach((fn) => fn());
    for (const effect of next.effects) this.run(effect);
  };

  /** Resolves once the backend session is established for the current account. */
  ensureSession = (): Promise<boolean> =>
    new Promise((resolve) => {
      this.ensureWaiters.push(resolve);
      this.send({ type: "ENSURE_SESSION" });
    });

  /** Resolves true when a wallet is connected by the time the attempt ends. */
  openModal = (returnTo: string | null): Promise<boolean> =>
    new Promise((resolve) => {
      this.connectWaiters.push(resolve);
      this.send({ type: "CONNECT_REQUESTED", returnTo });
    });

  disconnect = (): void => this.send({ type: "DISCONNECT_REQUESTED" });

  /** Signs with the connected kit; used by the signer the provider exposes. */
  signTransaction = async (xdr: string, opts: { networkPassphrase: string; address: string }) =>
    (await this.kit()).signTransaction(xdr, opts);

  private kit(): Promise<WalletKitAdapter> {
    this.kitPromise ??= this.deps.loadKit();
    return this.kitPromise;
  }

  private run(effect: WalletEffect): void {
    switch (effect.type) {
      case "restore":
        this.kit()
          .then((kit) => kit.getAddress().then((r) => r.address, () => null))
          .then((address) =>
            this.send({
              type: "RESTORED",
              epoch: effect.epoch,
              address,
              storedSessionWallet: this.deps.storedSessionWallet(),
            }),
          );
        return;

      case "openAuthModal":
        this.kit()
          .then((kit) => kit.authModal())
          .then(
            ({ address }) =>
              this.send({
                type: "CONNECT_SUCCEEDED",
                epoch: effect.epoch,
                address,
                storedSessionWallet: this.deps.storedSessionWallet(),
              }),
            (err) => {
              const described = this.deps.describe(err);
              // Closing the picker, or declining there, is not an error worth showing.
              const silent = described.kind === "rejected" || /closed/i.test(String((err as { message?: string })?.message));
              this.send({ type: "CONNECT_FAILED", epoch: effect.epoch, silent, message: described.message });
            },
          );
        return;

      case "queryNetwork":
        // Some wallets can't report their network; the unknown state is fine.
        this.kit()
          .then((kit) => kit.getNetwork())
          .then(
            ({ networkPassphrase }) =>
              this.send({ type: "NETWORK_REPORTED", epoch: effect.epoch, address: effect.address, passphrase: networkPassphrase }),
            () => {},
          );
        return;

      case "signIn":
        this.deps
          .signIn(effect.address, (xdr, opts) => this.signTransaction(xdr, opts))
          .then(
            (wallet) => this.send({ type: "SIGNIN_SUCCEEDED", epoch: effect.epoch, attempt: effect.attempt, wallet }),
            (err) =>
              this.send({
                type: "SIGNIN_FAILED",
                epoch: effect.epoch,
                attempt: effect.attempt,
                message: this.deps.describe(err).message,
              }),
          );
        return;

      case "clearBackendSession":
        this.deps.clearBackendSession();
        return;

      case "kitDisconnect":
        this.kit().then((kit) => kit.disconnect()).catch(() => {});
        return;

      case "purgeStellarQueries":
        this.deps.purgeStellarQueries();
        return;

      case "navigate":
        this.deps.navigate(effect.to);
        return;

      case "resolveEnsure":
        this.ensureWaiters.splice(0).forEach((resolve) => resolve(effect.ok));
        return;

      case "resolveConnect":
        this.connectWaiters.splice(0).forEach((resolve) => resolve(effect.ok));
        return;
    }
  }
}
