# Typed Binding Results Bugfix Design

## Overview

The application's contract-call helpers (`simulated<T>` / `send<T>`) accept a
caller-supplied type argument and use `as` casts and duck-typed `"isOk" in raw`
checks internally. This means the TypeScript compiler never ties the inferred
type back to the binding's declared return type, so type drift (e.g. `Uint8Array`
vs `Buffer` for `trace_hash`) silently propagates and binding changes never fail
`npm run typecheck`.

The fix introduces two new helpers in `lib/stellar/typed-call.ts` — `read` and
`submit` — whose return types are fully inferred from the `AssembledTransaction`
generic via utility types. `instanceof Ok/Err` replaces duck-typing, a
`bytesToHex` utility replaces the repeated `Array.from` pattern, and every
hand-written shape is replaced by an import of the binding's own type. A new
type-level test file (`typed-call.test-d.ts`) and ESLint `no-restricted-syntax`
rule prevent the drift from recurring.

## Glossary

- **Bug_Condition (C)**: Any call site where `simulated<T>` or `send<T>` is
  invoked with an explicit type argument, OR where the return value is annotated
  with a hand-written shape instead of a binding-imported type.
- **Property (P)**: The correct behaviour — `read(tx, contract)` returns a value
  whose TypeScript type is identical to what the binding declares, with no
  explicit type argument required at the call site.
- **Preservation**: All runtime behaviour (unwrapping `Result::Ok`, throwing on
  `Result::Err`, returning `{ value, txHash }` from writes) must remain
  byte-for-byte identical; only the static types and the `instanceof` check
  change.
- **`AssembledTransaction<Tx>`**: The SDK class returned by every binding method.
  Its single type parameter `Tx` is the raw XDR-decoded value (may be
  `Result<T>`, `T`, `Position`, `u64`, …).
- **`TxValue<Tx>`**: Utility type that extracts `T` from `Result<T>`, or returns
  `Tx` unchanged for non-Result types.
- **`Unwrapped<T>`**: Tuple-wrapped form `[T]` used to prevent TypeScript's
  conditional-type distribution over union members.
- **`MethodValue<M>`**: Infers `TxValue` for a single binding method type
  signature.
- **`Value<C, K>`**: Looks up method `K` on client `C` and resolves its
  `MethodValue` — the public API for deriving shapes at call sites.
- **`read`**: Replaces `simulated`. Infers return type from `tx`; no explicit `T`
  allowed.
- **`submit`**: Replaces `send`. Same inference story for writes.
- **`bytesToHex`**: `(buf: Uint8Array | Buffer) => string` — shared conversion
  replacing the repeated `Array.from` pattern.
- **`Ok` / `Err`**: Classes exported from `@stellar/stellar-sdk/contract` used
  for `instanceof` checks instead of duck-typing.

## Bug Details

### Fault Condition

The bug manifests at every call site where the caller must explicitly supply a
type argument (`simulated<Market>(…)`, `send<bigint>(…)`) and wherever a
hand-written interface is used instead of the binding's own type. In both cases
the TypeScript compiler accepts whatever type the caller writes without checking
it against the binding's declared return type.

**Formal Specification:**

```
FUNCTION isBugCondition(callSite)
  INPUT:  callSite — a TypeScript call expression in the source tree
  OUTPUT: boolean

  RETURN (
    callSite.callee IN ["simulated", "send"]
    AND callSite.hasExplicitTypeArgument()
  )
  OR (
    callSite.annotatedType IS hand-written shape
    AND correspondingBindingType EXISTS
    AND callSite.annotatedType != correspondingBindingType
  )
  OR (
    callSite.resultDiscriminator USES duck-type check "isOk" in value
  )
END FUNCTION
```

### Examples

- `simulated<{ trace_hash: Uint8Array; ipfs_cid: string }>(await reasoningRegistry().get_trace(…))` —
  `Uint8Array` vs binding's `Buffer`; TypeScript never complains.
- `send<bigint>(tx)` in `useBuy` — if `buy` changed to `Result<{ shares: bigint }>` the caller
  would silently receive a `Result` object typed as `bigint`.
- `"isOk" in raw && typeof raw.isOk === "function"` — a plain object `{ isOk: 42 }` passes
  the first guard, then the second guard throws because `42()` is not a function.
- `npm run typecheck` passes today when `quote_buy` returns `Result<i128>`; if the binding
  changes to `Result<{ shares: i128; fee: i128 }>` all callers still compile.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- A simulated call that returns a non-`Result` value (e.g. `market_count → u64`,
  `get_position → Position`) SHALL continue to return that value directly.
- A simulated call that returns `Result::Ok(v)` SHALL continue to return `v`
  unwrapped.
- A simulated call that returns `Result::Err` SHALL continue to throw a
  `UserFacingError` via `describeError`.
- A simulation host-error (tx.simulation.error set) SHALL continue to surface via
  `describeError` before `signAndSend` is called.
- `submit` (`buy`, `sell`, `redeem`) SHALL continue to return `{ value, txHash }`
  with `txHash` from `sent.sendTransactionResponse?.hash`.
- `useUsdcTransfer` SHALL continue to throw `UserFacingError` when `txHash` is
  null.
- `useVerifiedTrace` SHALL continue to produce the same hex string from the bytes
  the contract returns; `Buffer` and `Uint8Array` share the same underlying
  `Array.from` byte access so the hex output is identical.
- `token.balance` and `token.transfer` (built with explicit `parseResultXdr`) are
  already correctly typed at source and SHALL NOT be changed.

**Scope:**
All inputs that do NOT match the bug condition — mouse/touch interactions,
non-contract UI events, `token.*` calls, calls that already use the new `read`/
`submit` — are completely unaffected.

## Hypothesized Root Cause

1. **Unconstrained generic on helpers**: `simulated<T>` and `send<T>` accept any
   `T` because they are declared as `function simulated<T>(tx: AssembledTransaction<unknown>, …): T`.
   The `unknown` severs the link between `T` and the binding's actual type
   parameter.

2. **Duck-typed Result detection**: The `"isOk" in raw` guard pre-dates the SDK
   exporting `Ok`/`Err` classes. The SDK now exports them from
   `@stellar/stellar-sdk/contract`; `instanceof` is both safer and more
   idiomatic.

3. **`// @ts-nocheck` in generated files**: The bindings opt out of type-checking
   entirely. `npm run typecheck` only covers app code, so a mismatch between the
   binding's declared type and the hand-written shape is invisible.

4. **No type-level test coverage**: There are no `.test-d.ts` files using
   `expectTypeOf` to assert that helpers return the right types.

5. **No lint guardrail**: Nothing prevents a future developer from reintroducing
   `read<SomeType>(…)` with an explicit type argument that defeats the inference.

## Correctness Properties

Property 1: Fault Condition — Inferred Return Type Matches Binding

_For any_ call `read(tx, contract)` where `tx` is the return value of a binding
method, the TypeScript type of the result SHALL be identical to the type the
binding declares for that method (unwrapping `Result<T>` to `T` where applicable),
with NO explicit type argument at the call site. A TypeScript compiler error SHALL
be produced if the inferred type is used incorrectly.

**Validates: Requirements 2.1, 2.2, 2.7**

Property 2: Preservation — Runtime Behaviour Unchanged

_For any_ input where the bug condition does NOT hold (calls that already work
correctly at runtime — non-`Result` returns, `Result::Ok` unwrapping,
`Result::Err` throwing, `{ value, txHash }` from writes, hex conversion from
`trace_hash`), the fixed `read`/`submit` SHALL produce exactly the same runtime
output as the original `simulated`/`send`, preserving all observable side-effects.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8**

## Fix Implementation

### Changes Required

**New file: `lib/stellar/typed-call.ts`**

1. **Utility types**:
   - `TxValue<Tx>` — extracts `T` from `Result<T>`; passes `Tx` through otherwise.
     Uses tuple wrapping `[Tx] extends [Result<infer T>] ? T : Tx` to avoid
     conditional-type distribution over unions.
   - `Unwrapped<T>` — alias for `[T]` to make the tuple intent explicit.
   - `MethodValue<M>` — extracts `TxValue` from a method's `Promise<AssembledTransaction<…>>` signature.
   - `Value<C, K>` — `MethodValue<C[K]>` — the call-site API.
   - `MarketCoreClient` and `RegistryClient` — type aliases for the generated clients (avoids importing the class just for `typeof`).

2. **`bytesToHex(buf: Uint8Array | Buffer): string`** — shared utility replacing
   the `Array.from(…, b => b.toString(16).padStart(2,'0')).join('')` pattern.

3. **`read<Tx>(tx: AssembledTransaction<Tx>, contract?: ContractName)`** — infers
   `TxValue<Tx>` as the return type; uses `instanceof Ok` / `instanceof Err`;
   surfaces errors via `describeError`. No caller-supplied type argument is
   accepted (the parameter is on `tx`, not the function).

4. **`submit<Tx>(tx: AssembledTransaction<Tx>, contract?: ContractName)`** —
   calls `read` first (simulation gate), then `signAndSend`. The one necessary
   `as` cast at the XDR-decode boundary is documented with an inline comment.
   Returns `{ value: TxValue<Tx>; txHash: string | null }`.

5. **Deprecated re-export** — `export { read as simulated }` marked `@deprecated`
   so existing imports continue to compile with a deprecation warning.

**Changes to `lib/hooks/useStellar.ts`**:
- Replace all `import { simulated }` usages with `read` from `typed-call`.
- Replace all `send<T>(tx)` calls with `submit(tx)`.
- In `useVerifiedTrace`: remove the inline shape annotation; import `Trace` from
  `reasoning-registry` binding; replace `Array.from(trace.trace_hash, …)` with
  `bytesToHex(trace.trace_hash)`.

**Changes to `app/reasoning/verify/page.tsx`**:
- Replace `import { simulated }` with `import { read }` from `typed-call`.
- Remove the inline `{ trace_hash: Uint8Array; ipfs_cid: string; market_id: bigint }` annotation.
- Use `Value<RegistryClient, "get_trace">` (or let TypeScript infer) for the
  `onChain` variable.
- Replace `Array.from(onChain.trace_hash, …)` with `bytesToHex`.

**Changes to `e2e/testnet.e2e.test.ts`**:
- Remove the local `simulatedValue` helper.
- Import `read` from `lib/stellar/typed-call`.
- Replace `simulatedValue<…>(…)` with `read(…)` (no type argument).

**New file: `lib/stellar/__tests__/typed-call.test-d.ts`**:
- Type-level assertions using `expectTypeOf` (vitest):
  - `read(await marketCore().market_count())` → `bigint`
  - `read(await marketCore().get_market(…))` → `Market`
  - `read(await marketCore().get_position(…))` → `Position`
  - `read(await marketCore().quote_buy(…))` → `bigint`
  - `read(await marketCore().buy(…))` → `bigint`
  - `read(await reasoningRegistry().get_trace(…))` → `Trace`
  - All of the above: `.not.toBeAny()` guards
  - `Value<MarketCoreClient, "get_market">` resolves to `Market`
  - `Value<RegistryClient, "get_trace">` resolves to `Trace`

**New file: `lib/stellar/__tests__/typed-call.test.ts`**:
- Runtime unit tests for `read` and `submit` using mock `AssembledTransaction` objects.

**Changes to `vitest.config.mts`**:
- Add `typecheck: { enabled: true, include: ["lib/**/*.test-d.ts"] }` inside `test`.

**Changes to `eslint.config.mjs`**:
- Add a `no-restricted-syntax` rule that forbids explicit type arguments on calls
  to `read`, `submit`, and `simulated`:

  ```js
  {
    selector: 'CallExpression[callee.name=/^(read|submit|simulated)$/] > TSTypeParameterInstantiation',
    message: 'Do not pass explicit type args to read/submit/simulated — the type is inferred from the binding.'
  }
  ```

**Changes to `docs/architecture.md`**:
- Add a "Reading contract results" section documenting `read`/`submit`, the type
  utilities, and the `no-restricted-syntax` guardrail.

## Testing Strategy

### Validation Approach

Two-phase: first surface counterexamples on the unfixed code to confirm the root
cause, then verify the fix and preservation properties hold.

### Exploratory Fault Condition Checking

**Goal**: Surface counterexamples that demonstrate the drift BEFORE the fix.
Confirm that the type-parameter inference does not exist today, and that
`instanceof Ok` would work where duck-typing may not.

**Test Plan**: Write a type-level test asserting `read` infers the correct type
without an explicit type argument, and run it against the current (unfixed)
`simulated` to observe a type error or `any` inference. Also write a runtime test
using an object `{ isOk: () => true, unwrap: () => 42 }` vs a genuine `Ok`
instance to confirm the duck-type gap.

**Test Cases**:
1. **Type inference test** — assert `expectTypeOf(read(await marketCore().market_count())).toEqualTypeOf<bigint>()` compiles with `read` but not with `simulated<bigint>` dropped (will fail on unfixed code).
2. **`not.toBeAny()` guard** — assert the inferred type is not `any` (will fail today since `simulated<T>` returns `T` which is `unknown` at the call site after stripping the annotation).
3. **`instanceof Ok` runtime test** — create `{ isOk: () => true, unwrap: () => 99 }` and show the duck-typed guard would accept it; `instanceof Ok` would not.
4. **`trace_hash` type test** — assert `Value<RegistryClient, "get_trace">` has `trace_hash: Buffer`, not `Uint8Array`.

**Expected Counterexamples**:
- `simulated<Market>(…)` compiles even if the annotated `Market` is replaced with `{ wrong: true }`.
- The duck-typed guard accepts a plain object with an `isOk` method.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds (call sites
with explicit type args, or hand-written shapes), the fixed helpers enforce the
correct type.

**Pseudocode:**
```
FOR ALL callSite WHERE isBugCondition(callSite) DO
  result := read(callSite.tx)           -- no explicit type arg
  ASSERT TypeOf(result) == binding.declaredReturnType(callSite.method)
  ASSERT NOT TypeOf(result) == any
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, `read`
and `submit` produce the same runtime output as `simulated` and `send`.

**Pseudocode:**
```
FOR ALL tx WHERE NOT isBugCondition(tx) DO
  ASSERT read(tx) === simulated_original(tx)  -- same unwrapped value
  ASSERT submit(tx) deepEquals send_original(tx)  -- same { value, txHash }
END FOR
```

**Testing Approach**: Property-based testing is recommended for the runtime
preservation because:
- It generates many `AssembledTransaction` mock shapes automatically.
- It catches edge cases (Result wrapping levels, null txHash, void inner type)
  that unit tests might miss.
- It gives strong guarantees that the `instanceof` swap doesn't change any
  observable runtime output.

**Test Cases**:
1. **Non-Result preservation** — `read` with a mock tx whose `.result` is a plain
   `bigint` returns that bigint; no `Ok`/`Err` path taken.
2. **`Result::Ok` preservation** — `read` with a mock `Ok(42n)` returns `42n`.
3. **`Result::Err` preservation** — `read` with a mock `Err(...)` throws
   `UserFacingError`.
4. **Host-error preservation** — `read` with `tx.simulation.error` set throws
   before attempting unwrap.
5. **`submit` returns `{ value, txHash }`** — mock `signAndSend` returning
   `{ result: Ok(10n), sendTransactionResponse: { hash: "abc" } }` yields
   `{ value: 10n, txHash: "abc" }`.
6. **`bytesToHex` round-trip** — `bytesToHex(Buffer.from([0x0a, 0xff]))` ===
   `"0aff"` matches the old `Array.from` path.

### Unit Tests

- `read` with plain value, `Ok`, `Err`, and host-error mock transactions.
- `submit` happy path, simulation-failure gate, and `signAndSend` error.
- `bytesToHex` with `Buffer`, `Uint8Array`, and empty input.
- `@deprecated` `simulated` re-export still delegates to `read` at runtime.

### Property-Based Tests

- Generate random `bigint` / `string` / `boolean` inner values; wrap each in
  both a plain form and `Ok(value)`; assert `read` always returns the same inner
  value regardless of wrapping.
- Generate random error codes; wrap in `Err`; assert `read` always throws
  `UserFacingError` with a message matching `describeError`.
- Generate random byte arrays; assert `bytesToHex(Buffer.from(bytes))` ===
  `bytesToHex(new Uint8Array(bytes))` (Buffer/Uint8Array identity).

### Integration Tests

- `useVerifiedTrace` query function runs against a mock `reasoningRegistry` client
  that returns a genuine `Ok(Trace)` — the full path from `read` through
  `bytesToHex` to the `VerifiedTrace` shape is exercised.
- `app/reasoning/verify/page.tsx` (render test) — the `onChain` variable is
  correctly typed as `Trace`; `storedHash` is a hex string.
- `e2e/testnet.e2e.test.ts` compiles without the local `simulatedValue` helper
  after the import is swapped to `read`.
