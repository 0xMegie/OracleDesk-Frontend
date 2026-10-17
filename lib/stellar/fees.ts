import { rpc, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { rpcServer } from "./clients";

export interface FeeBreakdown {
  /** Stroops: totalFee - resourceFee */
  inclusionFee: bigint;
  /** Stroops from SorobanTransactionData.resourceFee() */
  resourceFee: bigint;
  /** Stroops: BigInt(tx.built.fee) */
  totalFee: bigint;
  /** Stroops from simulation.minResourceFee */
  minResourceFee: bigint;
  resources: {
    instructions: number;
    readBytes: number;
    writeBytes: number;
    readEntries: number;
    writeEntries: number;
  };
}

export class SimulationError extends Error {
  constructor(message: string, public readonly response?: rpc.Api.SimulateTransactionResponse) {
    super(message);
    this.name = "SimulationError";
  }
}

/**
 * Extracts fee breakdown and footprint statistics from a simulated AssembledTransaction.
 * Arithmetic is kept strictly in bigint (stroops). Never passes through float/number.
 */
export function feeBreakdown(tx: AssembledTransaction<unknown>): FeeBreakdown {
  if (!tx || !tx.simulation) {
    throw new SimulationError("Transaction has no simulation data");
  }

  const sim = tx.simulation as rpc.Api.SimulateTransactionResponse;

  if (rpc.Api.isSimulationError(sim) || (sim as { error?: string }).error) {
    throw new SimulationError(
      String((sim as { error?: string }).error ?? "Simulation failed"),
      sim,
    );
  }

  if (rpc.Api.isSimulationRestore(sim) || "restorePreamble" in (sim as object)) {
    throw new SimulationError("Transaction requires footprint restore", sim);
  }

  const minResourceFee = BigInt(sim.minResourceFee ?? 0);
  const rawTx = tx.built;
  if (!rawTx) {
    throw new SimulationError("Transaction has not been built");
  }
  const totalFee = BigInt(rawTx.fee);

  const rawTxData = (sim as { transactionData?: unknown }).transactionData;
  if (!rawTxData) {
    throw new SimulationError("Simulation is missing transactionData");
  }

  const sorobanData: xdr.SorobanTransactionData =
    typeof (rawTxData as { build?: () => xdr.SorobanTransactionData }).build === "function"
      ? (rawTxData as { build: () => xdr.SorobanTransactionData }).build()
      : (rawTxData as xdr.SorobanTransactionData);

  const resourceFee = BigInt(sorobanData.resourceFee().toString());
  const inclusionFee = totalFee - resourceFee;

  const resources = sorobanData.resources();
  const footprint = resources.footprint();
  const readBytes =
    typeof (resources as { diskReadBytes?: () => number }).diskReadBytes === "function"
      ? (resources as { diskReadBytes: () => number }).diskReadBytes()
      : typeof (resources as unknown as { readBytes?: () => number }).readBytes === "function"
      ? (resources as unknown as { readBytes: () => number }).readBytes()
      : 0;

  return {
    inclusionFee,
    resourceFee,
    totalFee,
    minResourceFee,
    resources: {
      instructions: resources.instructions(),
      readBytes,
      writeBytes: resources.writeBytes(),
      readEntries: footprint.readOnly().length,
      writeEntries: footprint.readWrite().length,
    },
  };
}

export interface AccountReserve {
  balance: bigint;
  minBalance: bigint;
  sellingLiabilities: bigint;
  spendable: bigint;
  subentries: number;
  sponsoring: number;
  sponsored: number;
}

/**
 * Standard Stellar network base reserve: 0.5 XLM (5,000,000 stroops).
 * Used when network RPC does not expose the ledger header XDR.
 */
export const DEFAULT_BASE_RESERVE = 5_000_000n;

/**
 * Computes spendable native XLM from an account entry per CAP-33 sponsored reserves.
 * All arithmetic is performed in BigInt stroops.
 */
export function spendableXlm(entry: xdr.AccountEntry, baseReserve: bigint): AccountReserve {
  const balance = BigInt(entry.balance().toString());
  const subentries = Number(entry.numSubEntries());
  let sellingLiabilities = 0n;
  let sponsoring = 0;
  let sponsored = 0;

  try {
    if (entry.ext().switch() >= 1) {
      const v1 = entry.ext().v1();
      sellingLiabilities = BigInt(v1.liabilities().selling().toString());
      if (v1.ext().switch() >= 2) {
        const v2 = v1.ext().v2();
        sponsoring = Number(v2.numSponsoring());
        sponsored = Number(v2.numSponsored());
      }
    }
  } catch {
    // Non-fatal if extension format differs
  }

  // Formula (CAP-33): minBalance = (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve
  const reserveMultiplier = 2n + BigInt(subentries) + BigInt(sponsoring) - BigInt(sponsored);
  const minBalance = reserveMultiplier * baseReserve;
  const rawSpendable = balance - minBalance - sellingLiabilities;
  const spendable = rawSpendable < 0n ? 0n : rawSpendable;

  return {
    balance,
    minBalance,
    sellingLiabilities,
    spendable,
    subentries,
    sponsoring,
    sponsored,
  };
}

/**
 * Reads the latest base reserve from the network if exposed in the ledger header XDR,
 * otherwise falls back to DEFAULT_BASE_RESERVE (0.5 XLM).
 */
export async function fetchBaseReserve(server: rpc.Server = rpcServer()): Promise<bigint> {
  try {
    const latest = (await server.getLatestLedger()) as unknown as { headerXdr?: string };
    if (latest && typeof latest.headerXdr === "string") {
      const header = xdr.LedgerHeader.fromXDR(latest.headerXdr, "base64");
      return BigInt(header.baseReserve().toString());
    }
  } catch {
    // Fall back to protocol default
  }
  // Soroban RPC getLatestLedger does not always include the raw ledger header XDR;
  // fall back to the protocol standard base reserve of 0.5 XLM (5_000_000 stroops).
  return DEFAULT_BASE_RESERVE;
}
