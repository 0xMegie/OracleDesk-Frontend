import deployments from "./generated/deployments.testnet.json";

/**
 * Network and contract configuration. Contract ids default to the synced
 * deployments file (lib/stellar/generated/, see scripts/sync-bindings.mjs);
 * each can be overridden with a NEXT_PUBLIC_* variable.
 *
 * Next.js only inlines NEXT_PUBLIC_* values referenced literally, so each one
 * is spelled out below.
 */

const env = (value: string | undefined, fallback: string) => (value && value.trim() ? value.trim() : fallback);

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export const NETWORK_PASSPHRASE = env(process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE, TESTNET_PASSPHRASE);
export const NETWORK_LABEL = NETWORK_PASSPHRASE === TESTNET_PASSPHRASE ? "Stellar Testnet" : "Stellar";
export const RPC_URL = env(process.env.NEXT_PUBLIC_STELLAR_RPC_URL, "https://soroban-testnet.stellar.org");
export const EXPLORER_URL = env(process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL, "https://stellar.expert/explorer/testnet");

export const CONTRACTS = {
  marketCore: env(process.env.NEXT_PUBLIC_MARKET_CORE_CONTRACT_ID, deployments.contracts.market_core),
  treasury: env(process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID, deployments.contracts.treasury),
  resolver: env(process.env.NEXT_PUBLIC_RESOLVER_CONTRACT_ID, deployments.contracts.resolver),
  reasoningRegistry: env(process.env.NEXT_PUBLIC_REASONING_REGISTRY_CONTRACT_ID, deployments.contracts.reasoning_registry),
  usdc: env(process.env.NEXT_PUBLIC_USDC_CONTRACT_ID, deployments.contracts.usdc),
} as const;

/**
 * Recipient of premium payments. Must match the backend's PAYMENTS_RECIPIENT
 * or the backend will reject the payment. Defaults to the treasury, like the
 * backend (see docs/api.md for why that is a product decision).
 */
export const PAYMENTS_RECIPIENT = env(process.env.NEXT_PUBLIC_PAYMENTS_RECIPIENT, CONTRACTS.treasury);

/**
 * Admin G-addresses. This is a UI gate only: the backend enforces admin
 * rights itself (ADMIN_ADDRESSES). Matched exactly, because Stellar
 * addresses are uppercase and case-sensitive.
 */
export const ADMIN_ADDRESSES: readonly string[] = (process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

export const isAdminAddress = (address: string | null | undefined) =>
  Boolean(address) && ADMIN_ADDRESSES.includes(address as string);

export const IPFS_GATEWAY = env(process.env.NEXT_PUBLIC_IPFS_GATEWAY_URL, "https://ipfs.io/ipfs");

/** The contracts repo's x402 trace service (per-trace unlocks). Empty if not deployed. */
export const X402_URL = env(process.env.NEXT_PUBLIC_X402_URL, "");

/**
 * WalletConnect (mobile wallets such as LOBSTR and Freighter Mobile). Off
 * unless a WalletConnect Cloud project id is set. The project's allowed-origin
 * list is what protects it, not the id itself.
 */
export const WALLETCONNECT_PROJECT_ID = env(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, "");
/** Public URL of this app, shown to the wallet while it pairs. */
export const APP_URL = env(process.env.NEXT_PUBLIC_APP_URL, "http://localhost:3000");
export const WALLETCONNECT_CHAIN = NETWORK_PASSPHRASE === TESTNET_PASSPHRASE ? "stellar:testnet" : "stellar:pubnet";

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAccount = (address: string) =>
  `${EXPLORER_URL}/${address.startsWith("C") ? "contract" : "account"}/${address}`;
