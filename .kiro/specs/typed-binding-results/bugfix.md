# Bugfix Requirements Document

## Introduction

The generated Stellar contract bindings (`market-core`, `reasoning-registry`) carry precise return types for every method, but the application discards this type information entirely. `lib/hooks/useStellar.ts` exposes two helpers — `simulated<T>` and `send<T>` — where the caller supplies `T` manually as a type parameter and the bodies use `as` casts or duck-typed `"isOk" in raw` checks instead of the SDK's real `Ok`/`Err` classes. Two call sites (`useVerifiedTrace` and `app/reasoning/verify/page.tsx`) inline the result shape by hand rather than importing `Trace` from the binding, and those shapes have already drifted (`trace_hash: Uint8Array` vs the binding's `Buffer`). The end-to-end test duplicates the same duck-typing locally. Nothing catches this drift: the generated files carry `// @ts-nocheck` and `npm run typecheck` passes even if a binding's return type changes completely.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `simulated<T>(tx, contract)` is called THEN the system accepts any caller-supplied `T` regardless of the actual return type of `tx`, providing no compile-time guarantee that `T` matches the binding's declared output type.

1.2 WHEN `send<T>(tx, contract)` is called THEN the system unwraps the result with `as` casts (`(value as { unwrap(): T }).unwrap()` and `value as T`) that are not verified against the binding's declared type, silently producing incorrect values if the binding changes.

1.3 WHEN `simulated` detects a `Result` wrapper THEN the system duck-types it via `"isOk" in raw && typeof raw.isOk === "function"` instead of using `instanceof Ok`/`instanceof Err` from `@stellar/stellar-sdk/contract`, which can mis-classify plain objects that happen to have an `isOk` method.

1.4 WHEN `useVerifiedTrace` reads a `Trace` from `reasoningRegistry().get_trace()` THEN the system writes out `{ market_id: bigint; agent: string; action: string; trace_hash: Uint8Array; ipfs_cid: string; published_at: bigint }` by hand instead of importing the `Trace` type from the binding, and declares `trace_hash` as `Uint8Array` while the binding declares it as `Buffer`.

1.5 WHEN `app/reasoning/verify/page.tsx` reads a trace THEN the system writes out `{ trace_hash: Uint8Array; ipfs_cid: string; market_id: bigint }` by hand, again mistyping `trace_hash` as `Uint8Array` and omitting fields present in the binding's `Trace`.

1.6 WHEN `e2e/testnet.e2e.test.ts` calls `reasoningRegistry().get_trace()` THEN the system uses a locally-defined `simulatedValue` helper with a hand-written `{ trace_hash: Uint8Array; ipfs_cid: string }` shape, duplicating the same drift-prone pattern outside the main codebase.

1.7 WHEN a binding method's return type changes (e.g. `quote_buy` changes from `i128` to a struct) THEN the system does not surface a type error at any call site, so `npm run typecheck` passes with the wrong type silently flowing through the application.

### Expected Behavior (Correct)

2.1 WHEN `read(tx, contract)` is called THEN the system SHALL infer the return type directly from `tx`'s generic parameter, requiring no caller-supplied type argument and producing a compile error if the inferred type is misused.

2.2 WHEN `submit(tx, contract)` is called THEN the system SHALL infer the return type from `tx` using the same type utilities, with no `as` casts in its body beyond one documented boundary at the XDR decode point.

2.3 WHEN a `Result`-wrapped value is encountered at runtime THEN the system SHALL detect it using `instanceof Ok` / `instanceof Err` from `@stellar/stellar-sdk/contract` instead of duck-typing.

2.4 WHEN `useVerifiedTrace` reads a trace THEN the system SHALL use the `Trace` type imported from the `reasoning-registry` binding, and the `trace_hash` field SHALL be typed as `Buffer` (matching the binding), with any `Uint8Array`-typed usage downstream handled by an explicit, documented conversion.

2.5 WHEN `app/reasoning/verify/page.tsx` reads a trace THEN the system SHALL derive the trace shape from the binding's `Trace` type via the `Value<C, K>` utility rather than an inline hand-written shape.

2.6 WHEN `e2e/testnet.e2e.test.ts` reads a trace THEN the system SHALL use the new `read` helper (or a thin equivalent) instead of a locally-defined duck-typing helper, and the result type SHALL be inferred from the binding.

2.7 WHEN a binding method's return type changes THEN the system SHALL produce a TypeScript compile error at every affected call site, and `npm run typecheck` SHALL fail.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a simulated call succeeds with a non-`Result` return (e.g. `market_count`, `token.balance`) THEN the system SHALL CONTINUE TO return the unwrapped value to the caller without errors.

3.2 WHEN a simulated call returns a `Result::Ok` (e.g. `get_market`, `get_position`, `quote_buy`) THEN the system SHALL CONTINUE TO unwrap and return the inner value.

3.3 WHEN a simulated call returns a `Result::Err` THEN the system SHALL CONTINUE TO throw a `UserFacingError` described via `describeError`.

3.4 WHEN a simulation itself fails (host error in `tx.simulation`) THEN the system SHALL CONTINUE TO surface the error through `describeError` before the wallet is asked to sign anything.

3.5 WHEN `send` / `submit` is called for `buy`, `sell`, or `redeem` THEN the system SHALL CONTINUE TO return `{ value, txHash }` with `txHash` sourced from `sent.sendTransactionResponse?.hash`.

3.6 WHEN `token.balance` or `token.transfer` is called THEN the system SHALL CONTINUE TO work correctly; these use `AssembledTransaction.build` with explicit `parseResultXdr` and are already correctly typed at the source.

3.7 WHEN the `USDC` transfer completes THEN the system SHALL CONTINUE TO throw `UserFacingError` if no `txHash` is returned.

3.8 WHEN `useVerifiedTrace` converts `trace_hash` to a hex string THEN the system SHALL CONTINUE TO produce the same hex string from the bytes returned by the contract, regardless of whether the field is typed as `Buffer` or `Uint8Array` at the call site.
