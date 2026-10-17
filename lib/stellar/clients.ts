import { Address, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { ClientOptions, SignTransaction } from "@stellar/stellar-sdk/contract";
import { Client as MarketCoreClient, type Category, type Outcome } from "./generated/market-core";
import { Client as TreasuryClient } from "./generated/treasury";
import { Client as ResolverClient } from "./generated/resolver";
import { Client as ReasoningRegistryClient } from "./generated/reasoning-registry";
import { CONTRACTS, NETWORK_PASSPHRASE, RPC_URL } from "./config";

/** What a wallet provides to sign. Omit it for read-only simulation. */
export interface Signer {
  publicKey: string;
  signTransaction: SignTransaction;
}

let _rpcServer: rpc.Server | null = null;
/** Memoised Stellar RPC server instance. */
export function rpcServer(): rpc.Server {
  if (!_rpcServer) {
    _rpcServer = new rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
  }
  return _rpcServer;
}

function options(contractId: string, signer?: Signer): ClientOptions {
  return {
    contractId,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    allowHttp: RPC_URL.startsWith("http://"),
    ...(signer ? { publicKey: signer.publicKey, signTransaction: signer.signTransaction } : {}),
  };
}

export const marketCore = (signer?: Signer) => new MarketCoreClient(options(CONTRACTS.marketCore, signer));
export const treasury = (signer?: Signer) => new TreasuryClient(options(CONTRACTS.treasury, signer));
export const resolver = (signer?: Signer) => new ResolverClient(options(CONTRACTS.resolver, signer));
export const reasoningRegistry = (signer?: Signer) =>
  new ReasoningRegistryClient(options(CONTRACTS.reasoningRegistry, signer));

/**
 * The USDC Stellar Asset Contract. A SAC has no Wasm and so no generated
 * bindings; calls are built directly with AssembledTransaction.
 */
export const token = {
  balance(owner: string, contractId: string = CONTRACTS.usdc): Promise<AssembledTransaction<bigint>> {
    return AssembledTransaction.build<bigint>({
      ...options(contractId),
      method: "balance",
      args: [new Address(owner).toScVal()],
      parseResultXdr: (v) => BigInt(scValToNative(v)),
    });
  },
  transfer(
    params: { from: string; to: string; amount: bigint },
    signer: Signer,
    contractId: string = CONTRACTS.usdc,
  ): Promise<AssembledTransaction<null>> {
    return AssembledTransaction.build<null>({
      ...options(contractId, signer),
      method: "transfer",
      args: [
        new Address(params.from).toScVal(),
        new Address(params.to).toScVal(),
        nativeToScVal(params.amount, { type: "i128" }),
      ],
      parseResultXdr: () => null,
    });
  },
};

export const Outcomes = {
  Yes: { tag: "Yes", values: undefined } as Outcome,
  No: { tag: "No", values: undefined } as Outcome,
} as const;

export type OutcomeTag = Outcome["tag"];
export type CategoryTag = Category["tag"];

/** Every contract Category, for pickers. */
export const CATEGORY_TAGS = ["Crypto", "Macro", "Geopolitics", "Sports", "Culture", "Other"] as const satisfies readonly CategoryTag[];

// Compile-time exhaustiveness: the build fails if the contract's Category
// enum gains a member that CATEGORY_TAGS doesn't list.
type MissingCategory = Exclude<CategoryTag, (typeof CATEGORY_TAGS)[number]>;
export const CATEGORY_TAGS_ARE_EXHAUSTIVE: [MissingCategory] extends [never] ? true : MissingCategory = true;

export const categoryValue = (tag: CategoryTag): Category => ({ tag, values: undefined }) as Category;
