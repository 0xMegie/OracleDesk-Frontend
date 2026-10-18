/* eslint-disable @typescript-eslint/no-explicit-any -- SDK assembled transactions are invariant; these boundary helpers preserve the exact binding return type. */
import { Ok, Err } from "@stellar/stellar-sdk/contract";
import type { AssembledTransaction, Result } from "@stellar/stellar-sdk/contract";
import type { ContractName } from "./errors";
import { describeError, UserFacingError } from "./errors";
import type { marketCore, reasoningRegistry } from "./clients";

/**
 * Converts a byte buffer (Buffer or Uint8Array) into a lowercase hex string.
 * Used for trace_hash conversion across the app.
 */
export function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** T from AssembledTransaction<T> */
export type TxValue<Tx> = Tx extends AssembledTransaction<infer T> ? T : never;

/**
 * Unwrapped value: Result<V> -> V, otherwise T itself.
 * Wrapped in a tuple to prevent distributive conditional typing over unions.
 */
export type Unwrapped<T> = [T] extends [Result<infer V>]
  ? V
  : T;

/** For a client method: (args, opts?) => Promise<AssembledTransaction<X>> -> Unwrapped<X> */
export type MethodValue<M> = M extends (...a: never[]) => Promise<infer Tx> ? Unwrapped<TxValue<Tx>> : never;

export type MarketCoreClient = ReturnType<typeof marketCore>;
export type RegistryClient = ReturnType<typeof reasoningRegistry>;
export type Value<C, K extends keyof C> = MethodValue<C[K]>;

/**
 * Reads the simulated result of an AssembledTransaction.
 * Infers the unwrapped return type directly from the transaction parameter.
 * Detects contract Result types using SDK Ok/Err instances (not duck typing).
 */
export function read<Tx extends AssembledTransaction<any>>(
  tx: Tx,
  contract: ContractName = "marketCore",
): Unwrapped<TxValue<Tx>> {
  const sim = tx.simulation as { error?: string } | undefined;
  let raw: unknown;
  try {
    raw = tx.result;
  } catch (err) {
    throw new UserFacingError(describeError(`${sim?.error ?? ""} ${String(err)}`, contract), err);
  }

  if (raw instanceof Ok) {
    return raw.unwrap() as Unwrapped<TxValue<Tx>>;
  }
  if (raw instanceof Err) {
    const errPayload = sim?.error ? `${sim.error} ${String(raw)}` : raw;
    throw new UserFacingError(describeError(errPayload, contract), raw);
  }

  return raw as Unwrapped<TxValue<Tx>>;
}

/**
 * Simulates, signs, and sends an AssembledTransaction.
 * First verifies simulation success via `read(tx)`, then calls `signAndSend()`.
 * Returns `{ value, txHash }` with the value inferred from the transaction.
 */
export async function submit<Tx extends AssembledTransaction<any>>(
  tx: Tx,
  contract: ContractName = "marketCore",
): Promise<{ value: Unwrapped<TxValue<Tx>>; txHash: string | null; ledger: number | null }> {
  // Surface simulation failures before asking the wallet to sign.
  read(tx, contract);
  try {
    const sent = await tx.signAndSend();
    const value = sent.result as unknown;
    // Single documented cast at the boundary where the SDK's SentTransaction.result is loosely typed.
    let unwrapped: unknown = value;
    if (value instanceof Ok) {
      unwrapped = value.unwrap();
    } else if (value instanceof Err) {
      throw new UserFacingError(describeError(value, contract), value);
    }
    return {
      value: unwrapped as Unwrapped<TxValue<Tx>>,
      txHash: sent.sendTransactionResponse?.hash ?? null,
      ledger: sent.getTransactionResponse && "ledger" in sent.getTransactionResponse ? sent.getTransactionResponse.ledger : null,
    };
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(describeError(err, contract), err);
  }
}

/**
 * @deprecated Use `read` instead. `read` infers the result type directly from
 * the binding method signature without requiring explicit type arguments.
 */
export const simulated = read;

export function simulatedWithLedger<Tx extends AssembledTransaction<any>>(tx: Tx, contract: ContractName = "marketCore") {
  const value = read(tx, contract);
  const ledger = tx.simulation?.latestLedger;
  if (!Number.isSafeInteger(ledger) || !ledger || ledger < 0) throw new Error("RPC returned a read without its ledger");
  return { value, ledger };
}
