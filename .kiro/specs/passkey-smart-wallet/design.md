# Passkey Smart Wallet Bugfix Design

## Overview

The frontend hardcodes an ed25519 (`G…`) model for every trader. Passkey smart wallets
(`C…` contract accounts) authenticate via WebAuthn (secp256r1) and require a completely
different signing path. Six bugs prevent contract-account holders from trading. All fixes
are gated behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"`, so the existing ed25519
path is never disturbed.

The fix introduces a union `Signer` type (`kind: "ed25519" | "contract"`), routes write
operations through a new `contract-submit.ts` relayer path for contract signers, replaces
the SEP-10 auth flow with a contract-account challenge for passkey sessions, suppresses
trustline errors for `C…` addresses, adjusts WalletDropdown copy, and bypasses the kit's
network-passphrase check for contract signers.

---

## Glossary

- **Bug_Condition (C)**: The set of runtime states where the connected signer has
  `kind === "contract"` (i.e. the address begins with `C`).
- **Property (P)**: The correct behavior for each write path, auth flow, and UI element
  when `kind === "contract"` — defined per-bug in the Correctness Properties section.
- **Preservation**: All behavior for `kind === "ed25519"` signers (and for any code path
  when the passkeys flag is off) that must remain identical after the fix.
- **`Signer`**: The interface in `lib/stellar/clients.ts` that the wallet provides.
  Currently `{ publicKey: string; signTransaction: SignTransaction }`.
- **`signerAddress(signer)`**: A new helper that returns `signer.contractId` for contract
  signers and `signer.publicKey` for ed25519 signers — the canonical trader address.
- **`isBugCondition(signer)`**: Returns `true` iff `signer.kind === "contract"`.
- **`AssembledTransaction`**: The Stellar SDK type used for every write in `useStellar.ts`.
  Currently always submitted via `tx.signAndSend()`.
- **SEP-10**: The existing challenge-transaction auth flow (`signInWithWallet` /
  `assertStellarAccount`). Works only for ed25519 keys.
- **SEP-45 / contract-auth challenge**: A 32-byte payload hash signed via WebAuthn.
  Documented as "proposed" in `docs/api.md`. Used for contract-account login.
- **`signAuthEntry`**: Stellar SDK method that signs only a Soroban authorization entry
  (not the full envelope) — the correct signing primitive for contract accounts.
- **`describeError`**: `lib/stellar/errors.ts` function that classifies thrown errors into
  user-facing messages. Emits trustline advice that is irrelevant for `C…` addresses.
- **`explorerAccount`**: `lib/stellar/config.ts` helper that already routes `C…` addresses
  to `/contract/…`. Used by WalletDropdown.
- **`useWriteGuard`**: Hook in `lib/hooks/useStellar.ts` that checks `isWrongNetwork`
  before any write; the check uses the wallets-kit passphrase, which is absent for passkey
  signers.

---

## Bug Details

### Fault Condition

The bug manifests when a user connects a passkey smart wallet (`C…` address) and the
frontend code (a) reads `signer.publicKey` as the trader address, (b) calls
`tx.signAndSend()` to submit, (c) routes through the SEP-10 auth flow, (d) surfaces
trustline error messages, (e) shows "Account history" copy, or (f) runs an
`isWrongNetwork` check that relies on the wallets-kit passphrase.

**Formal Specification:**

```
FUNCTION isBugCondition(signer)
  INPUT: signer of type Signer (current or proposed union)
  OUTPUT: boolean

  RETURN signer.kind === "contract"
         // Equivalent guard for pre-fix code:
         // signer.publicKey === undefined AND address.startsWith("C")
END FUNCTION
```

### Examples

- **Bug 1 (type / address)**: `useBuy` calls `marketCore(signer).buy({ trader: signer.publicKey, … })`.
  For a contract signer `publicKey` is `undefined`, so the transaction is built with no
  source account and fails at simulation.

- **Bug 2 (signAndSend)**: `send()` calls `tx.signAndSend()`. The SDK implementation
  calls `signTransaction` on the full XDR envelope; a passkey wallet cannot sign an
  envelope, so submission always throws.

- **Bug 3 (SEP-10 auth)**: `openModal` / `ensureSession` call `signInWithWallet`, which
  POSTs to `/auth/challenge` with a `C…` address. The backend validates that address with
  `StrKey.isValidEd25519PublicKey`, returns `400 INVALID_ADDRESS`, and login always fails.

- **Bug 4 (trustline error)**: A failed trade on a contract account may contain text
  matching `/trustline entry is missing/i`; `describeError` returns the "Add the USDC
  asset in your wallet first" message, which has no meaning for a contract account.

- **Bug 5 (UI copy)**: `WalletDropdown` renders `<span>Account history</span>` for every
  connected address. A contract-account holder sees the wrong label.

- **Bug 6 (isWrongNetwork)**: `useWriteGuard` reads `isWrongNetwork`, which is
  `walletNetworkPassphrase !== NETWORK_PASSPHRASE`. For a passkey signer the kit never
  fires a passphrase event, so `walletNetworkPassphrase` stays `null`, making
  `isWrongNetwork` always `false` — which happens to be non-blocking, but the check is
  semantically wrong and could flip if the context is initialised differently.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A connected `G…` wallet continues to use `signer.publicKey` as trader address.
- A connected `G…` wallet continues to submit via `tx.signAndSend()`.
- A connected `G…` wallet continues to authenticate via the SEP-10
  challenge-transaction flow (`signInWithWallet` / `requestChallenge` / `verifyChallenge`).
- A connected `G…` wallet continues to see trustline error messages from `describeError`.
- A connected `G…` wallet continues to see "Account history" in the dropdown, linking to
  the Stellar Expert account page.
- A connected `G…` wallet continues to have its trades blocked by `isWrongNetwork`.
- Read hooks (`usePosition`, `useUsdcBalance`, `useOnChainMarket`) continue to work for
  any address, since they never depend on signer kind.
- When `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS` is not `"true"`, no passkey UI or code path
  is reachable.

**Scope:**
All inputs where `isBugCondition(signer)` is `false` (i.e. `signer.kind === "ed25519"`)
must be completely unaffected by this fix. This includes:

- All trade mutations (`useBuy`, `useSell`, `useRedeem`, `useUsdcTransfer`) when called
  with an ed25519 signer.
- All auth flows when the connected address starts with `G`.
- All `describeError` call sites when the address starts with `G`.
- All WalletDropdown rendering when the address starts with `G`.
- The entire codebase when `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS !== "true"`.

---

## Hypothesized Root Cause

1. **`Signer` is a single-shape interface** (`lib/stellar/clients.ts`).
   There is no `kind` discriminant, so callers cannot branch on signer type. Every write
   path unconditionally reads `signer.publicKey`; a contract signer has no such property.

2. **`send()` is hardwired to `tx.signAndSend()`** (`lib/hooks/useStellar.ts`).
   `signAndSend` delegates to `signTransaction` from the Stellar Wallets Kit, which signs
   the full envelope XDR. WebAuthn-based passkey signers can only sign auth entries
   (32-byte payloads), not full envelopes. There is no alternate submission path.

3. **`signInWithWallet` assumes ed25519** (`lib/api/auth.ts` / `lib/stellar/WalletProvider.tsx`).
   `requestChallenge` sends a `C…` address to the backend; the backend's
   `StrKey.isValidEd25519PublicKey` guard rejects it. No contract-account auth endpoint
   exists yet (documented as "proposed" in `docs/api.md`).

4. **`describeError` has no signer-kind context** (`lib/stellar/errors.ts`).
   The function classifies errors purely from the thrown text. It has no way to suppress
   trustline advice based on whether the trader is a contract account.

5. **WalletDropdown hardcodes "Account history"** (`components/layout/WalletDropdown.tsx`).
   The copy is a plain string literal, with no branch for `C…` addresses. `explorerAccount`
   in `config.ts` already routes `C…` correctly; only the label is wrong.

6. **`isWrongNetwork` derives from `walletNetworkPassphrase`** (`lib/stellar/WalletProvider.tsx`).
   The wallets kit fires a passphrase only when a conventional wallet connects. A passkey
   flow bypasses the kit entirely; the passphrase never arrives, so the check has undefined
   semantics for contract signers.

---

## Correctness Properties

Property 1: Fault Condition — Contract signer uses `signerAddress()` and auth-entry signing

_For any_ signer where `isBugCondition(signer)` is `true` (i.e. `signer.kind === "contract"`),
every write path (buy, sell, redeem, transfer) SHALL use `signerAddress(signer)` as the
trader address, SHALL sign only the Soroban authorization entries via `signAuthEntry`, and
SHALL submit through the relayer path in `contract-submit.ts` rather than calling
`tx.signAndSend()`.

**Validates: Requirements 2.1, 2.2**

Property 2: Fault Condition — Contract signer authenticates via contract-account challenge

_For any_ session establishment where `isBugCondition(signer)` is `true`, the system SHALL
call `signInWithContractAccount()` (SEP-45 style, signing a 32-byte payload hash via
WebAuthn) instead of `signInWithWallet()`, so authentication succeeds for a `C…` address.

**Validates: Requirement 2.3**

Property 3: Fault Condition — Trustline errors suppressed for contract signers

_For any_ error thrown during a trade where `isBugCondition(signer)` is `true`, calling
`describeError(err, contract, signer)` SHALL NOT return a message with `kind === "no-trustline"`;
it SHALL instead return a generic or contract-specific message.

**Validates: Requirement 2.4**

Property 4: Fault Condition — WalletDropdown shows "Wallet history" for contract addresses

_For any_ connected address where `address.startsWith("C")`, the WalletDropdown SHALL
render "Wallet history" (not "Account history") as the explorer-link subtitle.

**Validates: Requirement 2.5**

Property 5: Fault Condition — `useWriteGuard` bypasses `isWrongNetwork` for contract signers

_For any_ call to `useWriteGuard()` where `isBugCondition(signer)` is `true`, the guard
SHALL NOT throw a `wrong-network` error regardless of `walletNetworkPassphrase`, allowing
the write to proceed.

**Validates: Requirement 2.6**

Property 6: Preservation — ed25519 write paths are unchanged

_For any_ signer where `isBugCondition(signer)` is `false` (i.e. `signer.kind === "ed25519"`),
every write path SHALL continue to use `signer.publicKey` as trader address and submit via
`tx.signAndSend()`, producing identical behavior to the pre-fix code.

**Validates: Requirements 3.1, 3.6**

Property 7: Preservation — ed25519 auth flow is unchanged

_For any_ session establishment where `isBugCondition(signer)` is `false`, the system
SHALL continue to call `signInWithWallet()` through the SEP-10 challenge-transaction path,
unchanged.

**Validates: Requirement 3.2**

Property 8: Preservation — `describeError` trustline messages intact for ed25519

_For any_ error thrown during a trade where `isBugCondition(signer)` is `false`,
`describeError` SHALL continue to return `kind === "no-trustline"` messages exactly as
before, when the error text matches the trustline pattern.

**Validates: Requirement 3.3**

Property 9: Preservation — Passkeys flag gates every new code path

_For any_ code path introduced by this fix (contract-signer branch, passkey auth, new UI
copy), the path SHALL be unreachable when `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS !== "true"`.

**Validates: Requirement 3.5**

---

## Fix Implementation

### New Files

**`lib/stellar/passkey.ts`**

Exports:
- `createPasskeyWallet(name: string): Promise<PasskeyResult>` — registers a WebAuthn
  credential, derives a `C…` contract address from the COSE public key, and returns the
  signer.
- `connectPasskeyWallet(): Promise<PasskeyResult>` — authenticates an existing credential.
- `passkeySigner(contractId: string, credentialId: Uint8Array): Signer` — constructs a
  `Signer` with `kind: "contract"` and a `signAuthEntry` implementation that calls
  `navigator.credentials.get`, normalises the DER-encoded secp256r1 signature to low-S,
  and returns the raw 64-byte `(r, s)` pair.

**`lib/stellar/contract-submit.ts`**

Exports:
- `submitAsContract(tx: AssembledTransaction, signer: ContractSigner): Promise<{ value, txHash }>` —
  re-simulates the assembled transaction, collects the auth entries, calls
  `signer.signAuthEntry` for each, re-assembles, and submits through a fee-paying source
  account (relayer) rather than via `tx.signAndSend()`. Polls for the result via
  `getTransaction`.

### Changes to Existing Files

**`lib/stellar/clients.ts`**

```
// Replace the Signer interface with a discriminated union:
export interface Ed25519Signer {
  kind: "ed25519";
  publicKey: string;
  signTransaction: SignTransaction;
}

export interface ContractSigner {
  kind: "contract";
  contractId: string;
  signAuthEntry: (entryXdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
}

export type Signer = Ed25519Signer | ContractSigner;

// New helper — single call site for "what address is this signer trading as?"
export function signerAddress(signer: Signer): string {
  return signer.kind === "contract" ? signer.contractId : signer.publicKey;
}

// options() continues to accept Signer | undefined. For contract signers
// pass only contractId as publicKey (for simulation) and omit signTransaction.
// signAndSend is never called for contract signers.
```

**`lib/stellar/WalletProvider.tsx`**

- Add a `passkeyActive` state flag (set when a passkey signer is connected).
- Build `signer` as `Ed25519Signer` when kit-connected and `ContractSigner` when passkey.
- In `signIn`: branch on signer kind — call `signInWithContractAccount()` for `kind: "contract"`.
- In `isWrongNetwork`: return `false` unconditionally when `passkeyActive` is true
  (bypasses `walletNetworkPassphrase` comparison).

**`lib/api/auth.ts`**

Add:
```typescript
export async function signInWithContractAccount(
  contractId: string,
  signPayload: (payload: Uint8Array) => Promise<Uint8Array>,
): Promise<AuthSession>
```
This function calls the new backend endpoint (to be implemented separately, documented
as "proposed" in `docs/api.md`):
- `POST /auth/contract-challenge` — returns a `{ payload: string (base64 32-byte hash), expiresAt }`.
- Signs the payload via WebAuthn (`signPayload` callback).
- `POST /auth/contract-verify` — sends `{ contractId, signature: base64 }`.
- Returns `AuthSession` and stores it.

Gated behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS`.

**`lib/hooks/useStellar.ts`**

- `useWriteGuard`: skip `isWrongNetwork` when `signer.kind === "contract"`.
- `send()`: branch after simulation — if `signer.kind === "contract"` delegate to
  `submitAsContract(tx, signer)` instead of `tx.signAndSend()`.
- Every `trader:` / `holder:` / `from:` field: replace `signer.publicKey` with
  `signerAddress(signer)`.

**`lib/stellar/errors.ts`**

Add an optional `signer?: Signer` parameter to `describeError`. When
`signer?.kind === "contract"`, skip the `no-trustline` classification and fall through to
the generic `unknown` path. All existing call sites omit the new parameter and are
unaffected.

**`components/layout/WalletDropdown.tsx`**

Replace the static `"Account history"` string with:
```typescript
const historyLabel = address?.startsWith("C") ? "Wallet history" : "Account history";
```
The `explorerAccount` href already routes `C…` to `/contract/…` in `config.ts`, so no
URL change is needed.

---

## Testing Strategy

### Validation Approach

Testing follows two phases: first surface counterexamples on the unfixed code to confirm
each root cause, then verify the fix passes the correctness properties and preserves all
ed25519 behavior.

### Exploratory Fault Condition Checking

**Goal**: Demonstrate each bug concretely on the *unfixed* code before implementing the
fix. Each test should fail on the original code and pass after the fix.

**Test Plan**: Use `lib/stellar/__tests__/passkey.test.ts` for unit-level exploration.
Run the suite against the unfixed code first to observe the failure modes.

**Test Cases**:

1. **Address extraction (Bug 1)**: Construct a mock `Signer` with `publicKey: undefined`
   (simulating a contract signer) and call `useBuy`'s `mutationFn`. Assert that the `trader`
   field passed to `marketCore().buy` is `undefined` — confirming the bug. Expected to fail
   after fix (trader will be `contractId`).

2. **signAndSend for contract (Bug 2)**: Mock `tx.signAndSend` to throw, mock
   `tx.signAuthEntry` to succeed. Call `send(tx)` with a contract-signer mock. On unfixed
   code `signAndSend` is called and the mock throws; after fix `signAuthEntry` path is taken.

3. **SEP-10 challenge rejected (Bug 3)**: Mock `requestChallenge` to return
   `{ status: 400, error: "INVALID_ADDRESS" }` when called with a `C…` address.
   Assert that `signInWithWallet("C…", …)` rejects — confirming the bug.

4. **Trustline message for contract (Bug 4)**: Call `describeError(trustlineError)` with
   no signer. Assert `kind === "no-trustline"`. Then call with a mock contract signer.
   Assert `kind !== "no-trustline"` after fix.

5. **WalletDropdown copy (Bug 5)**: Render `<WalletDropdown>` with a connected `C…`
   address. Assert the text content contains "Account history" on unfixed code and "Wallet
   history" after fix.

6. **isWrongNetwork blocks passkey (Bug 6)**: Set `walletNetworkPassphrase = null` and
   `passkeyActive = false`. Assert `useWriteGuard` throws `wrong-network`. After fix,
   with `passkeyActive = true`, assert it does not throw.

**Expected Counterexamples (unfixed)**:
- `signer.publicKey` is `undefined` → `trader: undefined` in contract call.
- `tx.signAndSend()` called instead of `signAuthEntry`.
- Backend returns `400 INVALID_ADDRESS` for `C…` challenge.
- `describeError` returns `kind: "no-trustline"` regardless of signer type.

### Fix Checking

**Goal**: Verify Properties 1–5 hold for all contract-signer inputs after the fix.

**Pseudocode:**
```
FOR ALL signer WHERE isBugCondition(signer) DO
  // Property 1
  ASSERT signerAddress(signer) === signer.contractId
  ASSERT writePathUsesSignAuthEntry(signer)
  ASSERT writePathSubmitsViaRelayer(signer)

  // Property 2
  ASSERT authFlowCallsContractChallenge(signer)

  // Property 3
  ASSERT describeError(trustlineErr, "marketCore", signer).kind !== "no-trustline"

  // Property 4 (address-based, not signer-kind-based)
  ASSERT walletDropdownLabel(signer.contractId) === "Wallet history"

  // Property 5
  ASSERT useWriteGuard(signer) does not throw wrong-network
END FOR
```

### Preservation Checking

**Goal**: Verify Properties 6–9 hold for all ed25519-signer inputs after the fix.

**Pseudocode:**
```
FOR ALL signer WHERE NOT isBugCondition(signer) DO
  // Property 6
  ASSERT signerAddress(signer) === signer.publicKey
  ASSERT writePathCallsSignAndSend(signer)

  // Property 7
  ASSERT authFlowCallsSignInWithWallet(signer)

  // Property 8
  ASSERT describeError(trustlineErr, "marketCore", signer).kind === "no-trustline"

  // Property 9 (flag gate)
  WITH NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS unset DO
    ASSERT noContractSignerCodePathReachable()
  END WITH
END FOR
```

**Testing Approach**: Property-based testing is used for preservation checking because
the input space (arbitrary signer shapes, error text strings, network state combinations)
is large and PBT generates edge cases that manual tests miss.

**Test Cases**:
1. **ed25519 write preservation**: Generate random `Ed25519Signer` mocks; assert
   `signerAddress` returns `publicKey`, `send()` calls `signAndSend`, and `useBuy` builds
   the transaction with `trader: publicKey`.
2. **Trustline message preservation**: Generate error strings matching the trustline
   pattern; assert `describeError(err, "marketCore", ed25519Signer).kind === "no-trustline"`
   for all of them.
3. **Auth flow preservation**: Verify `signIn` calls `signInWithWallet` (not the contract
   variant) for all `G…` addresses.

### Unit Tests

Location: `lib/stellar/__tests__/passkey.test.ts`

- DER → raw low-S normalisation: generate secp256r1 DER signatures with high-S and assert
  the normalised output is canonical low-S.
- COSE public key extraction: decode a known COSE_Key structure and assert the extracted
  x/y bytes match the expected coordinates.
- Auth payload hash: build a known challenge and assert `sha256(payload)` matches the
  expected digest.
- `describeError` for contract traders: assert trustline classification is suppressed when
  a contract signer is passed.
- `signerAddress` helper: assert returns `contractId` for `kind: "contract"` and
  `publicKey` for `kind: "ed25519"`.

Location: unit tests for `lib/stellar/contract-submit.ts`

- Refuses unexpected signer kinds (throws if called with an ed25519 signer).
- Re-simulates before signing (mocks simulation and asserts it is called).
- Polls `getTransaction` until confirmed and returns txHash.
- Throws `UserFacingError` on relayer failure.

### Property-Based Tests

Location: `lib/stellar/__tests__/passkey.test.ts` (PBT section)

- **Property 1 PBT**: For any mock contract signer and any market params, `useBuy`'s
  mutation function uses `signerAddress(signer)` as `trader` and routes through
  `submitAsContract`.
- **Property 2 PBT**: For any error text, `describeError` with a contract signer never
  returns `kind === "no-trustline"`.
- **Preservation PBT**: For any ed25519 signer and any error text, `describeError`
  behavior is identical to the unfixed code (trustline classification is preserved).

### Integration Tests

Location: `e2e/localnet/passkey.e2e.test.ts` (localnet e2e)

- Full buy flow with a passkey wallet: create a credential, connect, authenticate via
  contract challenge, execute a buy on a localnet market, assert the tx hash is returned
  and the position is updated.
- Disconnect and reconnect: assert session is cleared and re-established correctly.
- ed25519 wallet side-by-side: in the same test suite, connect a standard Freighter
  wallet and assert it still uses `signAndSend` (regression guard).
- WalletDropdown visual: render with a `C…` address and assert "Wallet history" label
  and the `/contract/` explorer URL.
