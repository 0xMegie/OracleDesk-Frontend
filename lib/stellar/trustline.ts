import {
  Keypair,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { rpcServer, token } from "./clients";
import { CONTRACTS, NETWORK_PASSPHRASE } from "./config";
import type { Signer } from "./clients";
import { describeError, UserFacingError } from "./errors";

export type TrustlineState =
  | { kind: "native" }
  | { kind: "present"; authorized: boolean; balance: bigint; limit: bigint }
  | { kind: "missing" }
  | { kind: "account-missing" };

const assetNameCache = new Map<string, Promise<Asset>>();

export function usdcClassicAsset(): Promise<Asset> {
  let pending = assetNameCache.get(CONTRACTS.usdc);
  if (!pending) {
    pending = (async () => {
      const transaction = await token.name(CONTRACTS.usdc);
      const result: unknown = transaction.result;
      const name =
        result && typeof result === "object" && "isOk" in result &&
        typeof (result as { isOk: unknown }).isOk === "function"
          ? (result as { isOk(): boolean; unwrap(): string }).unwrap()
          : (result as string);
      if (name === "native") return Asset.native();
      const separator = name.lastIndexOf(":");
      if (separator <= 0 || separator === name.length - 1) {
        throw new Error(`Unexpected SAC asset name: ${name}`);
      }
      const asset = new Asset(name.slice(0, separator), name.slice(separator + 1));
      if (asset.contractId(NETWORK_PASSPHRASE) !== CONTRACTS.usdc) {
        throw new Error("The configured USDC contract does not match the asset it wraps.");
      }
      return asset;
    })();
    assetNameCache.set(CONTRACTS.usdc, pending);
  }
  return pending;
}

export async function getTrustlineState(account: string, asset: Asset): Promise<TrustlineState> {
  if (asset.isNative()) return { kind: "native" };

  const address = Keypair.fromPublicKey(account).xdrPublicKey();
  const keys = [
    xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: address })),
    xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({ accountId: address, asset: asset.toTrustLineXDRObject() }),
    ),
  ];
  const { entries } = await rpcServer().getLedgerEntries(...keys);
  const accountEntry = entries.find((entry) => entry.key.switch().name === "account");
  if (!accountEntry) return { kind: "account-missing" };
  const trustlineEntry = entries.find((entry) => entry.key.switch().name === "trustline");
  if (!trustlineEntry) return { kind: "missing" };

  const trustline = trustlineEntry.val.trustLine();
  const authorized = (trustline.flags() & xdr.TrustLineFlags.authorizedFlag().value) !== 0;
  return {
    kind: "present",
    authorized,
    balance: BigInt(trustline.balance().toString()),
    limit: BigInt(trustline.limit().toString()),
  };
}

function accountExtensionV1(account: xdr.AccountEntry) {
  const ext = account.ext();
  return ext.switch() === 1 ? ext.v1() : null;
}

export async function reserveCheck(
  address: string,
): Promise<{ ok: boolean; spendable: bigint; required: bigint }> {
  const account = await rpcServer().getAccountEntry(address);
  const v1 = accountExtensionV1(account);
  const v2 = v1?.ext().switch() === 2 ? v1.ext().v2() : null;
  const numSponsoring = BigInt(v2?.numSponsoring() ?? 0);
  const numSponsored = BigInt(v2?.numSponsored() ?? 0);
  let baseReserve = 5_000_000n;
  try {
    const latest = await rpcServer().getLatestLedger();
    baseReserve = BigInt(latest.headerXdr.baseReserve());
  } catch {
    // Older RPC endpoints may not return ledger headers; Stellar's base reserve is 0.5 XLM.
  }
  const minimumBalance =
    (2n + BigInt(account.numSubEntries()) + numSponsoring - numSponsored) * baseReserve;
  const sellingLiabilities = BigInt(v1?.liabilities().selling().toString() ?? "0");
  const spendable = BigInt(account.balance().toString()) - minimumBalance - sellingLiabilities;
  const required = baseReserve + BigInt(BASE_FEE);
  return { ok: spendable >= required, spendable, required };
}

export async function buildChangeTrustXdr(address: string, asset: Asset): Promise<string> {
  const [account, feeStats] = await Promise.all([rpcServer().getAccount(address), rpcServer().getFeeStats()]);
  const recommended = BigInt(feeStats.inclusionFee.p70 || BASE_FEE);
  const fee = recommended > 10_000n ? 10_000n : recommended > BigInt(BASE_FEE) ? recommended : BigInt(BASE_FEE);
  return new TransactionBuilder(account, {
    fee: fee.toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(120)
    .build()
    .toXDR();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function submitAndPoll(
  signedXdr: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ hash: string }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  let response = await rpcServer().sendTransaction(tx);
  if (response.status === "TRY_AGAIN_LATER") {
    await wait(2_000);
    response = await rpcServer().sendTransaction(tx);
  }
  if (response.status === "ERROR") {
    const described = describeError(response.errorResult ?? "Transaction submission failed");
    throw new UserFacingError(described, response.errorResult);
  }
  if (response.status !== "PENDING" && response.status !== "DUPLICATE") {
    throw new Error(`Unexpected transaction submission status: ${response.status}`);
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let delay = 500;
  while (Date.now() < deadline) {
    await wait(delay);
    const result = await rpcServer().getTransaction(response.hash);
    if (result.status === "SUCCESS") return { hash: response.hash };
    if (result.status === "FAILED") {
      throw new UserFacingError(describeError(result.resultXdr.toXDR("base64")), result.resultXdr);
    }
    delay = Math.min(delay * 2, 4_000);
  }
  throw new Error("The trustline transaction is still pending. Check your wallet before retrying.");
}

export async function enableUsdcTrustline(address: string, asset: Asset, signer: Signer): Promise<{ hash: string }> {
  const reserve = await reserveCheck(address);
  if (!reserve.ok) {
    const neededXlm = reserve.required - reserve.spendable;
    throw new UserFacingError({
      kind: "low-reserve",
      message: `Add at least ${(Number(neededXlm) / 10_000_000).toFixed(2)} XLM to cover the USDC trustline reserve and fee.`,
    });
  }

  const unsignedXdr = await buildChangeTrustXdr(address, asset);
  const signed = await signer.signTransaction(unsignedXdr, { networkPassphrase: NETWORK_PASSPHRASE });
  if (signed.error) throw new UserFacingError(describeError(signed.error), signed.error);
  return submitAndPoll(signed.signedTxXdr);
}
