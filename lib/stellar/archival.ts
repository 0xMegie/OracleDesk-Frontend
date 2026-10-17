import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';

export const isArchivedStateError = (error: unknown): boolean => /archiv|missing ledger entry|ttl|entry.?not.?found/i.test(String(error));

/** Re-simulate after restoring archived entries through the supplied backend/client. */
export async function simulateWithRestore<T>(build: () => Promise<AssembledTransaction<T>>, restore: () => Promise<void>): Promise<AssembledTransaction<T>> {
  const tx = await build();
  try { tx.simulation; return tx; }
  catch (error) {
    if (!isArchivedStateError(error)) throw error;
    await restore();
    return build();
  }
}
