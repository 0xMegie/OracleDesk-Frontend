# Implementation Plan

- [-] 1. Write bug condition exploration test
  - **Property 1: Fault Condition** - Unconstrained Generic / Duck-Type Gap
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate all five root causes exist today
  - **Scoped PBT Approach**: Scope assertions to the concrete failing cases listed below for reproducibility
  - Create `lib/stellar/__tests__/typed-call.test-d.ts` using vitest `expectTypeOf` — assert against the EXISTING `simulated` helper (not the yet-to-be-written `read`):
    - `simulated<{ wrong: true }>(await marketCore().market_count())` — assert this should NOT compile (it does today, proving unconstrained generic)
    - `expectTypeOf(simulated(await marketCore().market_count())).not.toBeAny()` — assert result is not `any` (fails today: return type is the caller-supplied `T`, which is inferred as `unknown` when no arg is passed)
    - `expectTypeOf(simulated(await reasoningRegistry().get_trace({…}))).toHaveProperty("trace_hash").toEqualTypeOf<Buffer>()` — assert `trace_hash` is `Buffer` not `Uint8Array` (fails today: hand-written shape uses `Uint8Array`)
  - Create or extend `lib/stellar/__tests__/typed-call.test.ts` — runtime assertions against unfixed code:
    - Construct `{ isOk: () => true, unwrap: () => 99 }` (a plain object, not an `Ok` instance); run it through the existing duck-typed guard; assert that the duck-type check incorrectly passes where `instanceof Ok` would return `false`
    - Document the counterexample: "duck-typed guard accepts a plain `{ isOk: () => true }` object — `instanceof Ok` would reject it"
  - Enable typecheck in `vitest.config.mts` for `.test-d.ts` files first (needed to observe the type-level failures):
    - Add `typecheck: { enabled: true, include: ["lib/**/*.test-d.ts"] }` inside the `test` block
  - Run `npx vitest typecheck --run` — **EXPECTED OUTCOME**: type errors surface on the `simulated` call sites
  - Run `npx vitest run lib/stellar/__tests__/typed-call.test.ts` — **EXPECTED OUTCOME**: duck-type runtime assertion demonstrates the gap
  - Document counterexamples found to understand root cause for the five areas
  - Mark task complete when tests are written, run, and failures/gaps are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Runtime Unwrap Behaviour Unchanged
  - **IMPORTANT**: Follow observation-first methodology — observe `simulated`/`send` behaviour on non-buggy inputs before writing assertions
  - Observe: `simulated(tx)` where `tx.result` is a plain `bigint` returns that bigint (no Ok/Err path)
  - Observe: `simulated(tx)` where `tx.result` is a genuine `Ok(42n)` instance returns `42n`
  - Observe: `simulated(tx)` where `tx.result` is a genuine `Err(...)` throws `UserFacingError`
  - Observe: `simulated(tx)` where `tx.simulation.error` is set throws before unwrap
  - Observe: `send(tx)` returns `{ value, txHash }` with `txHash` from `sendTransactionResponse.hash`
  - Write property-based tests in `lib/stellar/__tests__/typed-call.test.ts` capturing these patterns from Preservation Requirements in design:
    - **PBT**: Generate random `bigint` / `string` / `boolean` inner values; wrap each in plain form and as a genuine `Ok(value)` instance; assert `simulated` always returns the same inner value — confirms behaviour to preserve
    - **PBT**: Generate random byte arrays (Uint8Array); assert `Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('')` produces the same hex as `bytesToHex(Buffer.from(bytes))` will — baseline for hex identity preservation
    - **Unit**: `simulated` with mock `Err(…)` throws `UserFacingError` (baseline)
    - **Unit**: `simulated` with host-error `tx.simulation.error` throws before unwrap (baseline)
    - **Unit**: `send` happy-path mock returns `{ value: 10n, txHash: "abc" }` (baseline)
  - Run tests: `npx vitest run lib/stellar/__tests__/typed-call.test.ts`
  - **EXPECTED OUTCOME**: All preservation tests PASS on unfixed code (confirms the baseline behaviour to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_

- [ ] 3. Implement typed-call helpers and migrate call sites

  - [ ] 3.1 Create `lib/stellar/typed-call.ts` with utility types and `read`/`submit`
    - Define `TxValue<Tx>` using tuple wrapping: `[Tx] extends [Result<infer T>] ? T : Tx`
    - Define `Unwrapped<T>` as `[T]` alias, `MethodValue<M>` extracting TxValue from a method's Promise return, `Value<C, K>` as `MethodValue<C[K]>`
    - Define `MarketCoreClient` and `RegistryClient` type aliases (avoids importing classes just for `typeof`)
    - Implement `bytesToHex(buf: Uint8Array | Buffer): string` replacing all `Array.from(…, b => b.toString(16).padStart(2,'0')).join('')` patterns
    - Implement `read<Tx>(tx: AssembledTransaction<Tx>, contract?: ContractName): Promise<TxValue<Tx>>` using `instanceof Ok` / `instanceof Err` (NOT duck-typing); surface errors via `describeError`
    - Implement `submit<Tx>(tx: AssembledTransaction<Tx>, contract?: ContractName): Promise<{ value: TxValue<Tx>; txHash: string | null }>` — calls `read` for simulation gate, then `signAndSend`; document the one necessary `as` cast at the XDR-decode boundary with inline comment
    - Add `@deprecated` re-export: `export { read as simulated }`
    - _Bug_Condition: isBugCondition(callSite) where callSite.callee IN ["simulated","send"] AND callSite.hasExplicitTypeArgument(), OR annotatedType is hand-written shape_
    - _Expected_Behavior: read(tx, contract) return type === binding.declaredReturnType(method); no explicit T at call site; instanceof Ok/Err used for discrimination_
    - _Preservation: non-Result returns pass through; Result::Ok unwraps; Result::Err throws UserFacingError; host-error throws before signAndSend; submit returns { value, txHash }_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 3.2 Migrate `lib/hooks/useStellar.ts`
    - Replace `import { simulated }` with `import { read, submit, bytesToHex }` from `../stellar/typed-call`
    - Replace all `simulated<T>(tx, contract)` calls with `read(tx, contract)` (remove explicit type args)
    - Replace all `send<T>(tx, contract)` calls with `submit(tx, contract)` (remove explicit type args)
    - In `useVerifiedTrace`: remove inline shape annotation; import `Trace` from `reasoning-registry` binding; replace `Array.from(trace.trace_hash, …)` with `bytesToHex(trace.trace_hash)`
    - _Requirements: 2.1, 2.2, 2.4_

  - [ ] 3.3 Migrate `app/reasoning/verify/page.tsx`
    - Replace `import { simulated }` with `import { read, bytesToHex }` from `lib/stellar/typed-call`
    - Remove the inline `{ trace_hash: Uint8Array; ipfs_cid: string; market_id: bigint }` annotation; let TypeScript infer from `read` or use `Value<RegistryClient, "get_trace">`
    - Replace `Array.from(onChain.trace_hash, …)` with `bytesToHex(onChain.trace_hash)`
    - _Requirements: 2.5_

  - [ ] 3.4 Migrate `e2e/testnet.e2e.test.ts`
    - Remove local `simulatedValue` helper and its hand-written `{ trace_hash: Uint8Array; ipfs_cid: string }` shape
    - Import `read` from `lib/stellar/typed-call`
    - Replace `simulatedValue<…>(…)` with `read(…)` (no type argument)
    - _Requirements: 2.6_

  - [ ] 3.5 Add ESLint guardrail in `eslint.config.mjs`
    - Add `no-restricted-syntax` rule forbidding explicit type arguments on `read`, `submit`, and `simulated` calls:
      ```js
      {
        selector: 'CallExpression[callee.name=/^(read|submit|simulated)$/] > TSTypeParameterInstantiation',
        message: 'Do not pass explicit type args to read/submit/simulated — the type is inferred from the binding.'
      }
      ```
    - _Requirements: 2.1, 2.2_

  - [ ] 3.6 Document in `docs/architecture.md`
    - Add "Reading contract results" section covering `read`/`submit`, the type utilities (`TxValue`, `Value<C,K>`), `bytesToHex`, and the ESLint `no-restricted-syntax` guardrail
    - _Requirements: 2.1, 2.7_

  - [ ] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Inferred Return Type Matches Binding
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The type-level test from task 1 now asserts `read` (not `simulated`) infers the correct binding type
    - Update the `.test-d.ts` assertions to reference `read` instead of `simulated` where appropriate (the test was written against `simulated` to show the bug; now assert `read` satisfies the same shape correctly)
    - Run: `npx vitest typecheck --run`
    - **EXPECTED OUTCOME**: All type-level tests PASS — `read` infers correct types, `not.toBeAny()` guards pass, `trace_hash` resolves to `Buffer`
    - Confirm `simulated<{ wrong: true }>(…)` now produces a lint error (ESLint guardrail)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Runtime Behaviour Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run: `npx vitest run lib/stellar/__tests__/typed-call.test.ts`
    - **EXPECTED OUTCOME**: All runtime preservation tests PASS — unwrap behaviour, error throwing, `{ value, txHash }` shape, and `bytesToHex` hex identity are all preserved
    - Confirm no regressions across non-Result, Result::Ok, Result::Err, host-error, and submit paths

- [ ] 4. Checkpoint — Ensure all tests pass
  - Run full type-check: `npx vitest typecheck --run`
  - Run full unit/PBT suite: `npx vitest run lib/stellar/__tests__/`
  - Run lint: `npx eslint lib/stellar/typed-call.ts lib/hooks/useStellar.ts app/reasoning/verify/page.tsx`
  - Confirm `npm run typecheck` (project-wide) fails if a binding return type is changed to something incompatible — the goal of requirement 2.7 is now enforced
  - Ensure all tests pass; ask the user if questions arise
