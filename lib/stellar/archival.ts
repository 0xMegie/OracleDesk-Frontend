import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';

export const isArchivedStateError = (error: unknown): boolean => /archiv|missing ledger entry|ttl|entry.?not.?found/i.test(String(error));

/** Re-simulate after restoring archived entries through the supplied backend/client. */
export async function simulateWithRestore<T>(build: () => Promise<AssembledTransaction<T>>, restore: () => Promise<void>): Promise<AssembledTransaction<T>> {
  try {
    const tx = await build();
    // `simulation` is only metadata; reading `result` forces the SDK to
    // surface expired/missing state errors from the simulation.
    void tx.result;
    return tx;
  }
  catch (error) {
    if (!isArchivedStateError(error)) throw error;
    await restore();
    return build();
  }
}
