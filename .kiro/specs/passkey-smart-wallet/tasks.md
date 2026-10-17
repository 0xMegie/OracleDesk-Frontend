# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - Contract Signer Bugs (address, submit, auth, error, UI, network)
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate each of the six bugs
  - **Scoped PBT Approach**: Scope each assertion to the concrete failing case to ensure reproducibility
  - Create `lib/stellar/__tests__/passkey.test.ts` with six exploration assertions:
    1. Construct a mock signer with `publicKey: undefined` (contract signer pre-fix shape), call the `useBuy` mutation function, assert `trader` passed to `marketCore().buy` is `undefined` — confirms Bug 1
    2. Mock `tx.signAndSend` to throw, mock `tx.signAuthEntry` to succeed, call `send(tx)` with the contract signer mock — assert `signAndSend` is called and throws — confirms Bug 2
    3. Mock `requestChallenge` to return `{ status: 400, error: "INVALID_ADDRESS" }` for a `C…` address, call `signInWithWallet("C…", …)` and assert it rejects — confirms Bug 3
    4. Call `describeError(trustlineError)` with no signer, assert `result.kind === "no-trustline"` — confirms Bug 4 (suppression is absent)
    5. Render `<WalletDropdown>` with a connected `C…` address, assert text contains "Account history" (wrong copy) — confirms Bug 5
    6. Set `walletNetworkPassphrase = null` and `passkeyActive = false`, call `useWriteGuard()`, assert it does NOT throw `wrong-network` on unfixed code (semantically wrong — check is vacuously passing) — confirms Bug 6
  - Run test suite against UNFIXED code: `npx vitest run lib/stellar/__tests__/passkey.test.ts`
  - **EXPECTED OUTCOME**: Tests FAIL (or produce incorrect values) — this proves the bugs exist
  - Document counterexamples found (e.g. `trader: undefined`, `signAndSend called`, `400 INVALID_ADDRESS`)
  - Mark task complete when test is written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - ed25519 write, auth, error, and UI paths are unchanged
  - **IMPORTANT**: Follow observation-first methodology — run UNFIXED code with `G…` signer inputs first
  - Observe: `signerAddress(ed25519Signer)` returns `publicKey` on unfixed code
  - Observe: `send(tx)` with an ed25519 signer calls `tx.signAndSend()` on unfixed code
  - Observe: `signIn` with a `G…` address calls `signInWithWallet` on unfixed code
  - Observe: `describeError(trustlineError, "marketCore", ed25519Signer).kind === "no-trustline"` on unfixed code
  - Observe: `WalletDropdown` with a `G…` address renders "Account history" on unfixed code
  - Observe: `useWriteGuard` with a `G…` signer and mismatched passphrase throws `wrong-network` on unfixed code
  - Write property-based tests in `lib/stellar/__tests__/passkey.test.ts` (PBT section):
    - **PBT**: For any randomly-generated `Ed25519Signer` mock (arbitrary `publicKey` strings starting with `G`), `send()` calls `tx.signAndSend()` and never calls `signAuthEntry`
    - **PBT**: For any error string matching `/trustline entry is missing/i`, `describeError(err, "marketCore", ed25519Signer).kind === "no-trustline"` holds for all such strings
    - **PBT**: For any `G…` address, `signIn` routes to `signInWithWallet`, never to `signInWithContractAccount`
    - **Example**: `WalletDropdown` with `G…` address renders "Account history" label
    - **Example**: `useWriteGuard` with ed25519 signer and `walletNetworkPassphrase !== NETWORK_PASSPHRASE` throws `wrong-network`
  - Verify ALL preservation tests PASS on UNFIXED code
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6_

- [ ] 3. Introduce the `Signer` discriminated union and `signerAddress` helper

  - [ ] 3.1 Update `lib/stellar/clients.ts`
    - Replace the single `Signer` interface with a discriminated union: `Ed25519Signer { kind: "ed25519"; publicKey: string; signTransaction: SignTransaction }` and `ContractSigner { kind: "contract"; contractId: string; signAuthEntry: … }`
    - Export `type Signer = Ed25519Signer | ContractSigner`
    - Add `export function signerAddress(signer: Signer): string` returning `signer.contractId` for `"contract"` and `signer.publicKey` for `"ed25519"`
    - Update `options()` so contract signers pass `contractId` as the simulation publicKey and omit `signTransaction`
    - _Bug_Condition: isBugCondition(signer) where signer.kind === "contract"_
    - _Expected_Behavior: signerAddress(signer) returns contractId for contract signers_
    - _Preservation: Ed25519Signer shape is a strict superset of the old interface — all existing call sites compile unchanged_
    - _Requirements: 2.1, 3.1_

  - [ ] 3.2 Update all `signer.publicKey` call sites in `lib/hooks/useStellar.ts`
    - Replace every `signer.publicKey` / `signer?.publicKey` used as `trader:`, `holder:`, `from:`, or source account with `signerAddress(signer)` / `signerAddress(signer!)`
    - _Requirements: 2.1, 3.1_

  - [ ] 3.3 Verify bug condition exploration test now passes for Bug 1
    - **Property 1: Expected Behavior** - `trader` field uses `signerAddress(signer)`
    - **IMPORTANT**: Re-run the SAME test from task 1 (assertion 1) — do NOT write a new test
    - Run: `npx vitest run lib/stellar/__tests__/passkey.test.ts`
    - **EXPECTED OUTCOME**: Assertion 1 passes (trader is `contractId`, not `undefined`)
    - _Requirements: 2.1_

  - [ ] 3.4 Verify preservation tests still pass
    - **Property 2: Preservation** - ed25519 write paths unchanged
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS (no regressions)

- [ ] 4. Implement contract-account submission path

  - [ ] 4.1 Create `lib/stellar/contract-submit.ts`
    - Export `submitAsContract(tx: AssembledTransaction, signer: ContractSigner): Promise<{ value, txHash }>`
    - Re-simulate the assembled transaction to get fresh auth entries
    - Collect auth entries and call `signer.signAuthEntry` for each
    - Re-assemble and submit through the relayer fee-paying source account (not `tx.signAndSend()`)
    - Poll `getTransaction` until confirmed; return `{ value, txHash }`
    - Throw `UserFacingError` on relayer failure
    - Guard: throw if called with a non-contract signer (`signer.kind !== "contract"`)
    - Gate behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"`
    - _Bug_Condition: isBugCondition(signer) where signer.kind === "contract"_
    - _Expected_Behavior: signAuthEntry called per auth entry; submitted via relayer; txHash returned_
    - _Preservation: signAndSend path in useStellar.ts is untouched for ed25519 signers_
    - _Requirements: 2.2, 3.1_

  - [ ] 4.2 Route `send()` in `lib/hooks/useStellar.ts` by signer kind
    - After simulation, branch: if `signer.kind === "contract"` call `submitAsContract(tx, signer)`; else call `tx.signAndSend()`
    - _Requirements: 2.2, 3.1_

  - [ ] 4.3 Add unit tests for `contract-submit.ts` in `lib/stellar/__tests__/contract-submit.test.ts`
    - Test: throws if called with an ed25519 signer
    - Test: calls simulation before signing (mock simulation, assert called)
    - Test: calls `signAuthEntry` for each auth entry
    - Test: polls `getTransaction` and returns `txHash` on success
    - Test: throws `UserFacingError` on relayer failure
    - _Requirements: 2.2_

  - [ ] 4.4 Verify bug condition exploration test now passes for Bug 2
    - **Property 1: Expected Behavior** - `signAuthEntry` called instead of `signAndSend` for contract signers
    - Re-run assertion 2 from task 1
    - **EXPECTED OUTCOME**: Assertion 2 passes
    - _Requirements: 2.2_

  - [ ] 4.5 Verify preservation tests still pass
    - **Property 2: Preservation** - ed25519 `signAndSend` path unchanged
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS

- [ ] 5. Implement contract-account authentication

  - [ ] 5.1 Add `signInWithContractAccount()` to `lib/api/auth.ts`
    - Export `async function signInWithContractAccount(contractId: string, signPayload: (payload: Uint8Array) => Promise<Uint8Array>): Promise<AuthSession>`
    - Call `POST /auth/contract-challenge` with `{ contractId }` → receive `{ payload: string, expiresAt }`
    - Sign the decoded base64 payload via the `signPayload` callback
    - Call `POST /auth/contract-verify` with `{ contractId, signature: base64 }` → return `AuthSession`
    - Gate behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"`
    - _Bug_Condition: isBugCondition(signer) where signer.kind === "contract"_
    - _Expected_Behavior: signs 32-byte payload hash via WebAuthn; never sends envelope to backend_
    - _Preservation: signInWithWallet is untouched; its call sites are unaffected_
    - _Requirements: 2.3, 3.2_

  - [ ] 5.2 Document proposed backend endpoints in `docs/api.md`
    - Add `POST /auth/contract-challenge` and `POST /auth/contract-verify` as "Proposed" endpoints with request/response shapes
    - _Requirements: 2.3_

  - [ ] 5.3 Branch `signIn()` in `lib/stellar/WalletProvider.tsx`
    - Add `passkeyActive` state flag (set when a passkey signer is connected)
    - In `signIn`: if `signer.kind === "contract"` call `signInWithContractAccount(signer.contractId, signer.signAuthEntry)`; else call `signInWithWallet()` as today
    - _Requirements: 2.3, 3.2_

  - [ ] 5.4 Verify bug condition exploration test now passes for Bug 3
    - **Property 1: Expected Behavior** - contract auth calls `/auth/contract-challenge` not `/auth/challenge`
    - Re-run assertion 3 from task 1
    - **EXPECTED OUTCOME**: Assertion 3 passes
    - _Requirements: 2.3_

  - [ ] 5.5 Verify preservation tests still pass
    - **Property 2: Preservation** - SEP-10 auth flow for ed25519 unchanged
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS

- [ ] 6. Suppress trustline errors for contract signers

  - [ ] 6.1 Update `describeError` in `lib/stellar/errors.ts`
    - Add optional parameter `signer?: Signer` to `describeError`
    - When `signer?.kind === "contract"`, skip the `no-trustline` classification and fall through to the generic `unknown` path
    - All existing call sites omit the new parameter and compile unchanged
    - _Bug_Condition: isBugCondition(signer) where signer.kind === "contract"_
    - _Expected_Behavior: describeError returns kind !== "no-trustline" for contract signers_
    - _Preservation: all existing call sites omit signer param; trustline messages intact for ed25519_
    - _Requirements: 2.4, 3.3_

  - [ ] 6.2 Update `describeError` call sites in `lib/hooks/useStellar.ts` to pass `signer`
    - Pass the current `signer` to `describeError` so the suppression logic activates for contract signers
    - _Requirements: 2.4_

  - [ ] 6.3 Verify bug condition exploration test now passes for Bug 4
    - **Property 1: Expected Behavior** - `describeError` with contract signer returns `kind !== "no-trustline"`
    - Re-run assertion 4 from task 1
    - **EXPECTED OUTCOME**: Assertion 4 passes
    - _Requirements: 2.4_

  - [ ] 6.4 Verify preservation tests still pass
    - **Property 2: Preservation** - trustline messages intact for ed25519 signers
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS

- [ ] 7. Fix WalletDropdown copy for contract addresses

  - [ ] 7.1 Update `components/layout/WalletDropdown.tsx`
    - Replace the static `"Account history"` string with: `const historyLabel = address?.startsWith("C") ? "Wallet history" : "Account history"`
    - Use `historyLabel` in the rendered JSX
    - The `explorerAccount` href in `config.ts` already routes `C…` to `/contract/…` — no URL change needed
    - _Bug_Condition: isBugCondition equivalent — address.startsWith("C")_
    - _Expected_Behavior: renders "Wallet history" label for C… addresses_
    - _Preservation: "Account history" label unchanged for G… addresses_
    - _Requirements: 2.5, 3.4_

  - [ ] 7.2 Verify bug condition exploration test now passes for Bug 5
    - **Property 1: Expected Behavior** - WalletDropdown renders "Wallet history" for `C…` address
    - Re-run assertion 5 from task 1
    - **EXPECTED OUTCOME**: Assertion 5 passes
    - _Requirements: 2.5_

  - [ ] 7.3 Verify preservation tests still pass
    - **Property 2: Preservation** - "Account history" unchanged for G… addresses
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS

- [ ] 8. Bypass `isWrongNetwork` for passkey signers

  - [ ] 8.1 Update `useWriteGuard()` in `lib/hooks/useStellar.ts`
    - Skip the `isWrongNetwork` check when `signer.kind === "contract"` (passkey signer has no wallets-kit passphrase)
    - _Bug_Condition: isBugCondition(signer) where signer.kind === "contract"_
    - _Expected_Behavior: useWriteGuard does not throw wrong-network for contract signers_
    - _Preservation: isWrongNetwork check fully enforced for ed25519 signers_
    - _Requirements: 2.6, 3.6_

  - [ ] 8.2 Update `isWrongNetwork` in `lib/stellar/WalletProvider.tsx`
    - Return `false` unconditionally when `passkeyActive` is true
    - _Requirements: 2.6_

  - [ ] 8.3 Verify bug condition exploration test now passes for Bug 6
    - **Property 1: Expected Behavior** - `useWriteGuard` does not throw for contract signer regardless of passphrase
    - Re-run assertion 6 from task 1
    - **EXPECTED OUTCOME**: Assertion 6 passes
    - _Requirements: 2.6_

  - [ ] 8.4 Verify preservation tests still pass
    - **Property 2: Preservation** - `isWrongNetwork` enforced for ed25519 signers
    - Re-run preservation tests from task 2
    - **EXPECTED OUTCOME**: All preservation tests PASS

- [ ] 9. Implement `lib/stellar/passkey.ts` (WebAuthn integration)

  - [ ] 9.1 Create `lib/stellar/passkey.ts`
    - Export `createPasskeyWallet(name: string): Promise<PasskeyResult>` — calls `navigator.credentials.create` with WebAuthn options, extracts the COSE public key from the attestation, derives a `C…` contract address, returns a `ContractSigner`
    - Export `connectPasskeyWallet(): Promise<PasskeyResult>` — calls `navigator.credentials.get` to authenticate an existing credential, returns a `ContractSigner`
    - Export `passkeySigner(contractId: string, credentialId: Uint8Array): Signer` — constructs a `ContractSigner` whose `signAuthEntry` implementation calls `navigator.credentials.get`, parses the DER-encoded secp256r1 signature, normalises to low-S (negate `s` if `s > n/2`), and returns the raw 64-byte `(r ‖ s)` pair
    - Gate all exports behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"`
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 9.2 Add unit tests in `lib/stellar/__tests__/passkey.test.ts`
    - DER → raw low-S normalisation: generate secp256r1 DER signatures with high-S; assert normalised output is canonical low-S
    - COSE public key extraction: decode a known COSE_Key structure; assert extracted x/y bytes match expected coordinates
    - Auth payload hash: build a known challenge; assert `sha256(payload)` matches expected digest
    - `signerAddress` helper: assert returns `contractId` for `kind: "contract"` and `publicKey` for `kind: "ed25519"`
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 9.3 Expose `connectPasskey()` and `createPasskey()` in `lib/stellar/WalletProvider.tsx`
    - Add `connectPasskey()`: calls `connectPasskeyWallet()`, sets signer with `kind: "contract"`, sets `passkeyActive = true`
    - Add `createPasskey()`: calls `createPasskeyWallet(name)`, sets signer with `kind: "contract"`, sets `passkeyActive = true`
    - Both methods gate behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"`
    - _Requirements: 2.1, 2.3_

- [ ] 10. Write end-to-end tests

  - [ ] 10.1 Create `e2e/localnet/passkey.e2e.test.ts`
    - Full buy flow with a passkey wallet: create credential, connect, authenticate via contract challenge, execute a buy on a localnet market, assert `txHash` returned and position updated
    - Disconnect and reconnect: assert session is cleared and re-established correctly
    - ed25519 wallet side-by-side: connect Freighter wallet in same suite, assert it still uses `signAndSend` (regression guard)
    - WalletDropdown visual: render with `C…` address, assert "Wallet history" label and `/contract/` explorer URL
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 3.1, 3.2_

- [ ] 11. Checkpoint — Ensure all tests pass
  - Run full test suite: `npx vitest run`
  - Run e2e suite against localnet: `npx playwright test e2e/localnet/passkey.e2e.test.ts`
  - Ensure all exploration tests (Property 1) pass — confirms all six bugs are fixed
  - Ensure all preservation tests (Property 2) pass — confirms no regressions
  - Ensure all unit tests pass (`passkey.test.ts`, `contract-submit.test.ts`)
  - Ask the user if any questions arise
