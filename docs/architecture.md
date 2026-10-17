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

## Amounts

USDC has 7 decimals. Anything that can reach a transaction is a `bigint` in base units (`lib/stellar/units.ts`). Parsing rejects floats in exponent form and more than 7 decimals. Display floats exist only at the edge of the UI.

## Errors

`lib/stellar/errors.ts` turns SDK, wallet and contract failures into plain sentences. Contract errors are named from the `Error(Contract, #N)` code through each binding's `Errors` table. Wallet rejection, insufficient USDC and a missing USDC trustline are matched first, because token errors raised inside `market_core.buy` carry the token contract's own codes, which overlap with market-core's.

## Generated code

`lib/stellar/generated/` is copied from the pinned `contracts` submodule by `scripts/sync-bindings.mjs`, with a do-not-edit header and `// @ts-nocheck`. CI fails if it's stale. `CATEGORY_TAGS` in `clients.ts` has a compile-time exhaustiveness check against the binding's `Category` type, so a contract enum change breaks the build rather than the UI.

## Rendering

All routes prerender as static pages. Pages that read query parameters (`/markets/quick-view`, `/copy-trade`, `/reasoning/verify`) keep `useSearchParams` inside a `<Suspense>` boundary; without it the production build fails.
