import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';

export const isFeeSurge = (error: unknown): boolean => /tx_bad_seq|insufficient fee|fee.?bump|resource limit|timeout/i.test(String(error));
export const isExpiredTransaction = (error: unknown): boolean => /expired|tx_too_late|too late|time.?bound/i.test(String(error));

export interface RecoveryAdvice { kind: 'fee-bump' | 'rebuild' | 'retry'; message: string; }
export function transactionRecoveryAdvice(error: unknown): RecoveryAdvice {
  if (isFeeSurge(error)) return { kind: 'fee-bump', message: 'Network fees increased. We can retry with a higher fee.' };
  if (isExpiredTransaction(error)) return { kind: 'rebuild', message: 'This transaction expired. Rebuild it to refresh its sequence and time bounds.' };
  return { kind: 'retry', message: 'The transaction did not complete. Please retry.' };
}

/** Retry a send once after a caller rebuilds the transaction with a fresh fee/sequence. */
export async function sendWithRecovery<T>(build: (feeBump: boolean) => Promise<AssembledTransaction<T>>, send: (tx: AssembledTransaction<T>) => Promise<T>): Promise<T> {
  try { return await send(await build(false)); }
  catch (error) {
    if (!isFeeSurge(error) && !isExpiredTransaction(error)) throw error;
    return send(await build(isFeeSurge(error)));
  }
}
