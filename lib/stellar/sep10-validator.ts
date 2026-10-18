import { TransactionBuilder, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import type { AuthChallenge } from "@/lib/api/auth";
import { NETWORK_PASSPHRASE } from "./config";

/**
 * Validate SEP-10 challenge transaction structure before signing.
 * Ensures the challenge is well-formed and matches expected parameters.
 */

export interface SEP10ValidationError {
  kind: "invalid_xdr" | "invalid_structure" | "wrong_network" | "expired" | "invalid_signing_key";
  message: string;
}

/**
 * Parse transaction XDR safely.
 */
function parseTransactionXDR(xdr: string): { transaction: Transaction | FeeBumpTransaction; isFeeBump: boolean } | null {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    const isFeeBump = tx instanceof FeeBumpTransaction;
    return { transaction: tx, isFeeBump };
  } catch {
    return null;
  }
}

/**
 * Get the inner transaction from a fee-bump or regular transaction.
 */
function getInnerTransaction(tx: Transaction | FeeBumpTransaction): Transaction {
  return tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
}

/**
 * Validate a SEP-10 challenge transaction.
 *
 * Checks:
 * 1. XDR is valid and parseable
 * 2. Transaction is signed by the backend (at least one signature)
 * 3. Network passphrase matches expected
 * 4. Expiry time is valid (not expired)
 * 5. Challenge transaction has the expected structure (single operation)
 */
export function validateSEP10Challenge(
  challenge: AuthChallenge,
  expectedNetworkPassphrase: string = NETWORK_PASSPHRASE,
): SEP10ValidationError | null {
  // Validate XDR format
  const parsed = parseTransactionXDR(challenge.transaction);
  if (!parsed) {
    return {
      kind: "invalid_xdr",
      message: "Invalid SEP-10 challenge: transaction XDR is malformed",
    };
  }

  const { transaction: tx } = parsed;
  const innerTx = getInnerTransaction(tx);

  // Validate network passphrase
  if (innerTx.networkPassphrase !== expectedNetworkPassphrase) {
    return {
      kind: "wrong_network",
      message: `Invalid SEP-10 challenge: expected network ${expectedNetworkPassphrase}, got ${innerTx.networkPassphrase}`,
    };
  }

  // Validate expiry time
  const expiresAt = new Date(challenge.expiresAt).getTime();
  const now = Date.now();
  if (now > expiresAt) {
    return {
      kind: "expired",
      message: "Invalid SEP-10 challenge: challenge has expired",
    };
  }

  // Validate transaction has at least one signature (from backend)
  const signatures = tx instanceof FeeBumpTransaction ? tx.signatures : innerTx.signatures;
  if (!signatures || signatures.length === 0) {
    return {
      kind: "invalid_signing_key",
      message: "Invalid SEP-10 challenge: transaction is not signed by the backend",
    };
  }

  // SEP-10 challenge should have exactly one operation (ManageData for the challenge)
  if (innerTx.operations.length !== 1) {
    return {
      kind: "invalid_structure",
      message: `Invalid SEP-10 challenge: expected 1 operation, got ${innerTx.operations.length}`,
    };
  }

  const operation = innerTx.operations[0];
  if (operation.type !== "manageData") {
    return {
      kind: "invalid_structure",
      message: `Invalid SEP-10 challenge: expected ManageData operation, got ${operation.type}`,
    };
  }

  return null;
}

/**
 * Extract the challenge token from a ManageData operation.
 * The token is stored in the operation's value field.
 */
export function extractChallengeToken(xdr: string): string | null {
  const parsed = parseTransactionXDR(xdr);
  if (!parsed) return null;

  const { transaction: tx } = parsed;
  const innerTx = getInnerTransaction(tx);

  if (innerTx.operations.length !== 1) return null;

  const operation = innerTx.operations[0];
  if (operation.type !== "manageData") return null;

  // ManageData value is stored as a Buffer, convert to base64
  if (operation.value) {
    return Buffer.from(operation.value).toString("base64");
  }

  return null;
}
