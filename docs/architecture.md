# Frontend architecture

## Where data comes from

The frontend has two sources that can disagree, and it says which one a value came from (the small `chain` / `backend` tags in the UI).

| Data | Source | Why |
|---|---|---|
| Prices, reserves, market status, positions, USDC balance | **Chain**, via simulated contract calls (`lib/hooks/useStellar.ts`) | The contract is the truth; the backend's copy can lag. |
| Question text, category, reasoning traces (metadata), subscriptions, platform counts | **Backend** (`lib/api/*`, `docs/api.md`) | Not stored on-chain in readable form. |
| Trace content | **IPFS**, then hash-checked against `reasoning_registry.get_trace` | Gateways are not authenticated; content is shown only if its sha256 matches the chain (`lib/stellar/trace.ts`). |

A backend market links to the chain through `onChainMarketId` (market-core's `u64` id, a decimal string in JSON). On-chain markets the backend doesn't know are still listed on `/markets`, with on-chain data only.

## Wallet and login

`lib/stellar/WalletProvider.tsx` wraps `@creit.tech/stellar-wallets-kit` 2.5.0 (pinned: the last release built on `@stellar/stellar-sdk` 16, the same major as the contract bindings, so the app ships one SDK copy).

- The kit is imported dynamically in an effect, because it reads `localStorage` when its module loads.
- A session the kit persisted is restored without prompting and without redirecting. Only a connect completed in the modal redirects to `/markets`.
- After connecting, the wallet signs the backend's SEP-10 style challenge transaction (`signTransaction`, which every Stellar wallet supports; `signMessage` is not universal). The backend returns a JWT. A stored session for a different address is cleared, never reused.
- `useWallet()` exposes `address`, `isWrongNetwork`, a `signer` for the binding clients, `openModal`, `ensureSession` and `disconnect`.

## Contract calls

- `lib/stellar/clients.ts` builds a generated binding `Client` per contract, optionally with the wallet as signer. The USDC Stellar Asset Contract has no Wasm and so no bindings; `token.balance` and `token.transfer` are built with `AssembledTransaction.build`.
- Reads are simulations (no fee, no signature).
- Writes (`useBuy`, `useSell`, `useRedeem`, `useUsdcTransfer`) check that a wallet is connected and on the right network, simulate, then `signAndSend`.
- `useBuy` quotes again immediately before building the transaction and sets `min_shares_out = minOut(quote, slippageBps)`, so slippage is enforced on-chain.
- `useSell` turns "sell N shares" into the exact `collateral_out` the contract needs, using the contract's own FPMM math (`generated/fpmm.ts`) on freshly read reserves, with `max_shares_in` slightly above N (see the contracts repo's `docs/frontend-integration.md`).

## Reading contract results

All contract results must be read through `read(tx, contract)` for simulations and `submit(tx, contract)` for transactions (`lib/stellar/typed-call.ts`).

- **Type inference**: `read` and `submit` automatically infer their return types from the binding method's return type using the `Unwrapped<TxValue<Tx>>` type utility. Contract `Result<T>` values are unwrapped to `T`, while plain return values (such as `Position` or `u64`) are passed through unchanged.
- **No manual type arguments or hand-written shapes**: Never pass explicit generic type parameters to `read` or `submit` (e.g. `read<MyType>(...)`), and never write out return interfaces by hand. An ESLint `no-restricted-syntax` rule enforces that call sites cannot pass type arguments to `read`, `submit`, or `simulated`.
- **Runtime Result detection**: Contract `Result` values are identified using SDK `instanceof Ok` and `instanceof Err` checks from `@stellar/stellar-sdk/contract`. Plain objects that happen to have an `isOk` property are never mistaken for Results.
- **Trace hash conversion**: The byte buffer (`Buffer` or `Uint8Array`) returned from `get_trace` must be converted to hex using `bytesToHex(trace.trace_hash)` rather than ad-hoc `Array.from` routines.
- **Pinning types**: Whenever the application starts using a new contract binding method, add corresponding type assertions to `lib/stellar/__tests__/typed-call.test-d.ts` (using `Value<Client, Method>` and argument parameter shapes) with `.not.toBeAny()` guards. This ensures that any upstream contract signature changes fail the test suite immediately.

## Amounts

USDC has 7 decimals. Anything that can reach a transaction is a `bigint` in base units (`lib/stellar/units.ts`). Parsing rejects floats in exponent form and more than 7 decimals. Display floats exist only at the edge of the UI.

## Errors

`lib/stellar/errors.ts` turns SDK, wallet and contract failures into plain sentences. Contract errors are named from the `Error(Contract, #N)` code through each binding's `Errors` table. Wallet rejection, insufficient USDC and a missing USDC trustline are matched first, because token errors raised inside `market_core.buy` carry the token contract's own codes, which overlap with market-core's.

## Generated code

`lib/stellar/generated/` is copied from the pinned `contracts` submodule by `scripts/sync-bindings.mjs`, with a do-not-edit header and `// @ts-nocheck`. CI fails if it's stale. `CATEGORY_TAGS` in `clients.ts` has a compile-time exhaustiveness check against the binding's `Category` type, so a contract enum change breaks the build rather than the UI.

## Rendering

All routes prerender as static pages. Pages that read query parameters (`/markets/quick-view`, `/copy-trade`, `/reasoning/verify`) keep `useSearchParams` inside a `<Suspense>` boundary; without it the production build fails.
