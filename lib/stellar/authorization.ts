import { Address, xdr } from '@stellar/stellar-sdk';

export interface AuthorizationInspection { count: number; signers: string[]; functions: string[]; warnings: string[]; valid: boolean; }

/** Inspect authorization entries before a wallet prompt; never sign unexpected addresses/functions. */
export function inspectAuthorizationEntries(entries: readonly xdr.SorobanAuthorizationEntry[], expectedAddress?: string): AuthorizationInspection {
  const signers: string[] = [];
  const functions: string[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    try {
      const address = entry.credentials().switch().name === 'sorobanCredentialsAddress' ? Address.fromScAddress(entry.credentials().address().address()).toString() : undefined;
      if (address) signers.push(address);
      functions.push(String(entry.rootInvocation().function()));
      if (expectedAddress && address && address !== expectedAddress) warnings.push(`Unexpected signer ${address}`);
    } catch { warnings.push('Unable to decode an authorization entry'); }
  }
  return { count: entries.length, signers, functions, warnings, valid: warnings.length === 0 };
}
