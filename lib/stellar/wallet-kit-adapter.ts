import { APP_URL, WALLETCONNECT_CHAIN, WALLETCONNECT_PROJECT_ID } from "./config";

/**
 * The slice of Stellar Wallets Kit that WalletProvider uses. An interface so
 * tests can drive the wallet logic with a scripted fake (no extension, no DOM).
 */
export interface WalletKitAdapter {
  authModal(): Promise<{ address: string }>;
  getAddress(): Promise<{ address: string }>;
  getNetwork(): Promise<{ networkPassphrase: string }>;
  signTransaction(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<{ signedTxXdr: string }>;
  disconnect(): Promise<void>;
  onStateUpdated(cb: (payload: { address: string | null; passphrase: string | null }) => void): () => void;
  onDisconnect(cb: () => void): () => void;
}

let loading: Promise<WalletKitAdapter> | null = null;

/** How long to wait for WalletConnect's async init before the wallet list is refreshed. */
const WALLETCONNECT_READY_TIMEOUT_MS = 5_000;

/**
 * Loads the kit once, in the browser only. The kit reads localStorage when its
 * module is evaluated, which breaks server rendering, so the dynamic imports
 * stay inside this function.
 */
export function loadStellarWalletsKit(): Promise<WalletKitAdapter> {
  loading ??= (async () => {
    const [{ StellarWalletsKit, KitEventType, Networks }, { defaultModules }] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
    ]);

    const modules = defaultModules();
    // WalletConnect is loaded only when a project id is configured, so the
    // default bundle does not change.
    let walletConnect: { isAvailable(): Promise<boolean> } | null = null;
    if (WALLETCONNECT_PROJECT_ID) {
      const { WalletConnectModule, WalletConnectTargetChain } = await import(
        "@creit.tech/stellar-wallets-kit/modules/wallet-connect"
      );
      walletConnect = new WalletConnectModule({
        projectId: WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: "OracleDesk",
          description: "AI prediction markets on Stellar",
          url: APP_URL,
          icons: [`${APP_URL}/icon.png`],
        },
        allowedChains: [WALLETCONNECT_CHAIN === "stellar:testnet" ? WalletConnectTargetChain.TESTNET : WalletConnectTargetChain.PUBLIC],
      });
      modules.push(walletConnect as (typeof modules)[number]);
    }
    StellarWalletsKit.init({ modules, network: Networks.TESTNET });

    if (walletConnect) {
      // Its client starts asynchronously; once it is ready, list it in the modal.
      const wc = walletConnect;
      const deadline = Date.now() + WALLETCONNECT_READY_TIMEOUT_MS;
      const timer = setInterval(async () => {
        if (await wc.isAvailable()) {
          clearInterval(timer);
          StellarWalletsKit.refreshSupportedWallets();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
        }
      }, 250);
    }

    const adapter: WalletKitAdapter = {
      authModal: () => StellarWalletsKit.authModal(),
      getAddress: () => StellarWalletsKit.getAddress(),
      getNetwork: () => StellarWalletsKit.getNetwork(),
      signTransaction: (xdr, opts) => StellarWalletsKit.signTransaction(xdr, opts),
      disconnect: () => StellarWalletsKit.disconnect(),
      // The kit's `on` returns the unsubscribe function.
      onStateUpdated: (cb) =>
        StellarWalletsKit.on(KitEventType.STATE_UPDATED, ({ payload }) =>
          cb({ address: payload.address ?? null, passphrase: payload.networkPassphrase || null }),
        ),
      onDisconnect: (cb) => StellarWalletsKit.on(KitEventType.DISCONNECT, () => cb()),
    };
    return adapter;
  })();
  return loading;
}
