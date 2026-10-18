# Frontend architecture

## Where data comes from

The frontend has two sources that can disagree, and it says which one a value came from (the small `chain` / `backend` tags in the UI).

| Data | Source | Why |
|---|---|---|
| Prices, reserves, market status, positions, USDC balance | **Chain**, via simulated contract calls (`lib/hooks/useStellar.ts`) | The contract is the truth; the backend's copy can lag. |
| Question text, category, reasoning traces (metadata), subscriptions, platform counts | **Backend** (`lib/api/*`, `docs/api.md`) | Not stored on-chain in readable form. |
| Trace content | **IPFS**, then hash-checked against `reasoning_registry.get_trace` | Gateways are not authenticated; content is shown only if its sha256 matches the chain (`lib/stellar/trace.ts`). |
| Per-market trade tape | **Chain** `Trade` events, extended by validated socket events | Contract-spec topic filters select one market. Backward ledger windows with forward cursor pagination find the newest rows; RPC retention limits history. Socket copies are replaced by decoded RPC copies on refetch. |
| Wallet inbox | **IndexedDB**, populated from validated own-wallet events and the transaction tracker | Scoped by address and network passphrase. It contains no agent portfolio data. Resolution/redemption events are polled every 60 seconds while visible; current contract status catches resolutions outside retention. |

A backend market links to the chain through `onChainMarketId` (market-core's `u64` id, a decimal string in JSON). On-chain markets the backend doesn't know are still listed on `/markets`, with on-chain data only.

## Wallet and login

`lib/stellar/WalletProvider.tsx` wraps `@creit.tech/stellar-wallets-kit` 2.5.0 (pinned: the last release built on `@stellar/stellar-sdk` 16, the same major as the contract bindings). The application and bindings share SDK 16; hardware-wallet internals can carry separate transitive versions.

- The kit is imported dynamically in an effect, because it reads `localStorage` when its module loads.
- A session the kit persisted is restored without prompting and without redirecting. Only a connect completed in the modal redirects to `/markets`.
- After connecting, the wallet signs the backend's SEP-10 style challenge transaction (`signTransaction`, which every Stellar wallet supports; `signMessage` is not universal). The backend returns a JWT. A stored session for a different address is cleared, never reused.
- `useWallet()` exposes `address`, `isWrongNetwork`, a `signer` for the binding clients, `openModal`, `ensureSession` and `disconnect`.

## Contract calls

- `lib/stellar/clients.ts` builds a generated binding `Client` per contract, optionally with the wallet as signer. The USDC Stellar Asset Contract has no Wasm and so no bindings; `token.balance` and `token.transfer` are built with `AssembledTransaction.build`.
- Reads are simulations (no fee, no signature).
- Writes (`useBuy`, `useSell`, `useRedeem`, `useUsdcTransfer`) check that a wallet is connected and on the right network, run fresh contract preflight checks, simulate, then `signAndSend`. A per-address queue serializes complete build/sign/send jobs in this tab and coordinates browser tabs with Web Locks (or a local-storage lease fallback); stale-sequence errors receive one fresh-build retry. The buy, sell, redeem, and USDC-transfer paths can decode the final simulated contract invocation and show its arguments and transaction envelope for review before the wallet prompt.
- `useBuy` quotes again immediately before building the transaction and sets `min_shares_out = minOut(quote, slippageBps)`, so slippage is enforced on-chain.

### Confirmed wallet updates and reconciliation

Position and USDC balance caches hold `{ value, ledger, provisional?, awaitingRpc? }`; existing hooks select `value`, while `usePositionState` and `useUsdcBalanceState` expose the metadata. Simulations supply the read ledger. A confirmed buy/sell/redeem applies only contract-returned bigint amounts, using the confirmed transaction ledger, and immediately updates an existing cache. Cached values already read at or above that ledger are left alone. Missing caches and unknown transaction ledgers use invalidation instead.

Reads are cancelled before signing and again before the confirmed delta is applied. No delta is applied while awaiting a signature, so rejection and simulation failure leave values unchanged. Consecutive confirmations compose against the latest cache. Negative deltas that exceed cached holdings or balance trigger invalidation. No quote cache is invalidated by this flow.

Reconciliation refetches after 1, 3 and 8 seconds. Reads below the cached ledger cannot overwrite it. At or above that ledger, matching reads remove the provisional marker; different reads replace the value and log `[optimistic] mismatch`. After three lagging reads, the value remains labelled **awaiting RPC**, with its transaction link, until an authoritative read arrives. Query removal on disconnect disposes reconciliation timers. Fee previews are rebuilt with the current wallet before transaction review and signing.
## Write path and transaction lifecycle

Every state-changing write (`useBuy`, `useSell`, `useRedeem`, `useUsdcTransfer`) follows an explicit, observable lifecycle governed by `TxLifecycle` in `lib/stellar/tx-lifecycle.ts`:

1. **Fee Preview & Simulation**: Before signing, `usePrepareBuy` and `usePrepareUsdcTransfer` simulate the transaction. `lib/stellar/fees.ts` calculates `feeBreakdown` (inclusion fee, resource fee, and Soroban resource footprint) and computes `spendableXlm` from the account ledger entry following CAP-33 rules (`minBalance = (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve`). If spendable XLM is below the estimated total fee, the UI disables submission with an exact deficit warning.
2. **Observable Lifecycle Phases**: `useTxRunner` drives the transaction through typed phases:
   - `building` → `simulating` → `awaiting-signature` → `submitting` (hash available) → `pending` (polling with backoff) → `confirmed` | `failed` | `expired`.
   - Expiration is determined from `latestLedgerCloseTime` reported by Stellar RPC, not the browser clock.
   - Statuses and errors (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`, `txBadSeq`, `op_low_reserve`, etc.) are mapped cleanly to `TxDescribedError`.
3. **Session Transaction Tracker (`lib/stellar/tx-tracker.tsx`)**:
   - `TransactionTrackerProvider` mounted in `WalletProvider` captures every submitted transaction as soon as the hash is known.
   - Transactions are serialized to `sessionStorage` (`oracledesk_pending_txs`) with BigInt amounts as strings, resuming polling on page reload.
   - Polling across multiple browser tabs is coordinated with `BroadcastChannel("oracledesk-tx")` to ensure only one tab polls the RPC server.
   - Upon confirmation, `tradeInvalidationKeys` performs React Query cache invalidations across market, positions, and balance queries even if the initiating component unmounted.
   - The `<TxToastContainer />` component (`components/ui/tx-toast.tsx`) renders accessible toasts announcing state transitions and supports resuming premium daily pass activation follow-ups.

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

### Realtime lists and storage bounds

`RealtimeProvider` owns one socket and one mixed-event scheduler. Valid payloads enter a 500-event bounded batch; subscribers receive at most one batch per animation frame. Hidden tabs accumulate a bounded backlog without updating realtime DOM, then receive one catch-up batch with overflow counts. Feed rings retain six home rows and eight market rows with event IDs as keys. A rolling second above ten events suppresses row animations and displays a summary; reduced motion also disables the ticker and realtime row animations.

The market tape retains at most 2,000 trades per market and 32 cached markets. A fixed eight-row viewport with overscan renders at most 24 data rows plus spacer rows. USDC, shares and fees remain bigint base units; post-trade price uses the pinned FPMM calculation. Each row links to its trader and transaction. Event retention is shown explicitly, including empty histories.

`InboxProvider` remounts for each address/network pair, closes its previous database handle, and renders nothing from the previous owner. `oracledesk-inbox` stores deterministic item IDs, read state and the last processed ledger. Duplicate deliveries preserve read state and creation time. The inbox retains 500 items, pruning oldest read items first, and displays the newest 200. Storage failures fall back to memory with a visible notice. Reading a page does not mark anything read; the user explicitly marks one item or all items. Held-market discovery uses the owner's saved fills and already-read position queries; it does not scan all ledger keys or use the treasury agent's portfolio.
