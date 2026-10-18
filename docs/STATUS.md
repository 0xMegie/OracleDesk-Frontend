# Status

Last updated: 2026-10-18. The latest issue verification is below; the original Stellar port record follows it. "Verified" means a command was run and its output observed in the session that wrote this file. The backend's [docs/STATUS.md](https://github.com/OracleDesk/OracleDesk-Backend/blob/main/docs/STATUS.md) covers the server side.

## Wallet activity issues #39–#42 (2026-10-18)

- #39: confirmed bigint position/balance deltas, ledger guards, reconciliation,
  pending/awaiting-RPC labels and transaction links.
- #40: contract-spec Trade filters/decoding, backward window probing, cursor
  pagination, live deduplication, retention notices and a bounded virtual tape.
- #41: shared socket delivery once per frame, bounded catch-up, rolling burst
  summaries, static burst rows, memoized home rows and reduced motion.
- #42: address/network-scoped IndexedDB inbox, explicit persisted read state,
  own-wallet classification, resolution/redemption polling and a real bell count.

Validation: `check:bindings`, `typecheck`, `lint`, `test` and `build` pass.
The suite has 176 tests across 25 files; lint reports 31 existing warnings and
no errors. Production prerender still reports the existing Recharts container
size warnings. Baseline merge defects in trading-hook imports, SDK 16 trustline
calls, ledger-clock RPC access, transaction review and tracker polling were
repaired because these paths are required by the four issues.
The lockfile also includes the wallet kit's peer dependency tree, so plain
`npm ci` can validate and install it without `--legacy-peer-deps`.
Clean installation succeeds. npm reports 69 dependency advisories (18 low,
16 moderate, 30 high, 5 critical); dependency security upgrades are outside
these four issues and were not applied.

Browser checks in headless Chrome (1440×1100): the actual app rendered both
feeds without exceptions; hidden-tab simulation held the feed DOM unchanged,
then delivered eight visible rows and an overflow summary for 1,000 events.
Emulated reduced motion left all feed-row transforms at `none`. A separate
temporary component harness using actual inbox/tape components and fixture
wallets/RPC confirmed read state after reload, switching A→B→A without leaking
A's fills, disconnect clearing the inbox, and **25 DOM rows for 2,000 trades**
(24 data rows plus a spacer, both at the top and after scrolling).

Profiler comparison: 500 synthetic trades per sample, normal motion,
development React Profiler, Node 24.15.0, Next 16.2.6, React 19.2.4. The baseline
uses the `develop@529912f` feed implementations with the same profiler wrapper;
the final feed uses the shared batcher. Each row sums the measured intervals
including the final settling interval. These are single local samples, not a
hardware-independent FPS claim. See CONTRIBUTING.md for reproduction.

| Feed | Events/second | Before commits | After commits | Before render ms | After render ms |
|---|---:|---:|---:|---:|---:|
| Market | 500 | 40 | 57 | 463.1 | 247.0 |
| Market | 50 | 323 | 496 | 3,191.4 | 2,112.5 |
| Home | 500 | 102 | 61 | 232.8 | 203.1 |
| Home | 50 | 497 | 499 | 1,412.1 | 1,007.3 |

The slower baseline market feed coalesces more events under main-thread load;
its lower commit count does not mean it delivered more responsive updates.
The new scheduler emits at most one subscriber batch per frame and removes
animation wrappers during sustained bursts. Render time decreased in these
samples, while the ring bounds and scheduler behavior are also unit tested.

Still manual: signing buy/sell/redeem with a real browser wallet, real
two-wallet event delivery, and live seeded-market resolution/redemption. No
transactions were submitted during verification. Event decoding tests use
contract-shaped XDR fixtures, not a newly captured testnet trade. Follow the
new checklist in [manual-test.md](manual-test.md).

[Production inbox screenshot, disconnected](images/notifications-disconnected.png).

## ⚠️ Action required before anything else

1. **Your local `.env` holds private keys under `NEXT_PUBLIC_*` names.** It isn't committed, but it defines `NEXT_PUBLIC_DEPLOYER_PRIVATE_KEY` and `NEXT_PUBLIC_POLYGON_PRIVATE_KEY` (both 66 characters, i.e. EVM private keys), `NEXT_PUBLIC_CIRCLE_API_KEY`, `NEXT_PUBLIC_CIRCLE_ENTITY_SECRET` and `NEXT_PUBLIC_POLYMARKET_API_KEY`. Next.js compiles every *referenced* `NEXT_PUBLIC_*` value into browser JavaScript. No tracked code ever referenced these (`git log -S` over all history: 0 hits), and none of the values appear in the new build's `.next/static`. Still:
   - Delete them from `.env` (the new app reads only the variables in `.env.example`).
   - Remove them from any hosting environment (e.g. Vercel project settings).
   - If a deployment ever shipped them, treat the keys as compromised.
2. **Rotate the Circle credentials** committed in the backend's `.env.example` history (details in the backend STATUS).

## Toolchain

Node v24.13.1, npm 11.8.0 (CI: Node 22 via `.nvmrc`), Next.js 16.2.6 (Turbopack), React 19.2.4, TypeScript 5.9.3, `@tanstack/react-query` 5.100.10, `@stellar/stellar-sdk` 16.3.1, `@creit.tech/stellar-wallets-kit` 2.5.0 (pinned exactly), Vitest 5.0.3, gitleaks 8.30.1, Stellar CLI 27.1.0. Contracts submodule at `OracleDesk-SmartContract@eb5f3fd` (that repo's `main` HEAD).

## Phases

| Phase | Status | Evidence |
|---|---|---|
| 0. Recon and safety | ✅ | Submodule fixed; scrap files deleted; gitleaks clean; `docs/PORTING.md`; baseline below |
| A. API contract | ✅ | `docs/api.md` (copy of the backend's) maps every `lib/api` call |
| C1. Dependencies | ✅ | No `wagmi`/`viem`/`@reown`/`@rainbow-me` import or dependency (grep below) |
| C2. Bindings sync | ✅ | `npm run check:bindings` |
| C3. `lib/stellar` | ✅ code, ⚠️ wallet unverified | Unit tests; the wallet provider needs a browser extension |
| C4. Hooks | ✅ reads verified live, ⚠️ writes unverified | `npm run e2e:testnet` exercises reads; writes need a wallet |
| C5. Pages | ✅ build, ⚠️ not clicked through | All routes prerender; manual plan in `docs/manual-test.md` |
| C6. Suspense build failure | ✅ | Reproduced and fixed (below) |
| C7. Tests | ✅ | 21 Vitest tests |
| D. End to end | ✅ read paths | See below |
| E. Contributor readiness | ✅ files, ⚠️ CI never ran on GitHub | README, CONTRIBUTING, SECURITY, CoC, LICENSE, templates, CI |
| F. Backlog | ✅ | 14 drafts in `docs/wave-issues/` (5 good first issues) |

## Baseline (before any change)

- `npx tsc --noEmit`: exit 0.
- `npx eslint`: **exit 1, 319 errors and 104 warnings.** About 290 errors came from linting the vendored `OracleDesk-Backend/dist` and `contracts/` submodules; 31 errors were in app code.
- `npx next build`: exit 0. Every route was dynamic (ƒ), because the layout called `headers()` for wagmi. That's why the known `useSearchParams` prerender failure did **not** reproduce at baseline.
- `git clone --recurse-submodules` was broken: the recorded `OracleDesk-Backend` commit `207464d` doesn't exist on GitHub.

## Secrets scan

- `gitleaks detect --log-opts=--all` (19 commits): no leaks.
- Regex sweep of `git log -p --all`: `MAX_UINT256` constants and a Polymarket builder code (`0xe4e1…`, a public identifier). No secrets.
- Every commit on this branch was scanned first with `gitleaks git --pre-commit --staged`.

## Fully verified (commands run, output observed)

- `npm run typecheck` 0 · `npm run lint` 0 · `npm run check:bindings` 0 · `npm test` 0 (4 files, 21 tests) · `npm run build` 0 with all 27 routes prerendered as static.
- `grep -rnE "from ['\"](wagmi|viem|@reown|@rainbow-me)" app components lib` → no matches; package.json has none of them.
- **C6:** with the `<Suspense>` boundary temporarily removed from `/markets/quick-view`, `next build` failed with "useSearchParams() should be wrapped in a suspense boundary at page /markets/quick-view … Export encountered an error". With it restored, the build passes. `/copy-trade` and `/reasoning/verify` use the same pattern.
- A fresh `git clone --recurse-submodules -b feat/stellar-port` of this repo checks out `contracts` at `eb5f3fd`, and `npm ci`, `check:bindings`, `typecheck`, `lint`, `test` and `build` pass in it.
- The built app served by `next start`: `/`, `/markets`, `/markets/quick-view?onChainId=1`, `/reasoning/verify?onChainTraceId=1`, `/premium`, `/copy-trade` → HTTP 200. The backend's CORS preflight from `http://localhost:3000` → 204 with `Access-Control-Allow-Origin: http://localhost:3000` and credentials allowed.

## Phase D: `npm run e2e:testnet` against the local backend (dry-run) and live testnet

```
API_URL=http://localhost:8000/api/v1 EXPECTED_YES_BPS=5319 MARKET_ID=1 \
DEMO_TRACE_FILE=<rebuilt demo trace bytes> DEMO_TRACE_ID=1 npm run e2e:testnet
→ Tests 3 passed (3)
```

1. Backend market `e2e-market-1` (seeded in the local DB with `onChainMarketId = "1"`) joined to `get_market(1)`: yesBps 5319, Resolved, category matches. The backend's cached `currentYesProb` was 0.5, which shows why the UI labels each value's source.
2. FPMM `yesBps` 5319 = binding `get_price` 5319 = CLI `stellar contract invoke … -- get_price --market_id 1 --outcome Yes` → 5319.
3. Login with a throwaway keypair: backend `scripts/smoke.sh`, passed.
4. Trace #1 from `scripts/demo.sh`: bytes rebuilt from the script's template hash to the on-chain `38f728a8…` and verify; a tampered copy is a mismatch; the real gateway can't serve the placeholder CID, so it's `unavailable` and no content is rendered.

## Not verified (and how to verify)

Everything that needs a browser wallet. Follow [docs/manual-test.md](manual-test.md), which lists every click:

| Item | Blocker |
|---|---|
| Connect, persisted session restore, no redirect on reload | Needs a wallet extension |
| SEP-10 sign-in from the browser (the backend side is verified by script) | Needs a wallet |
| Buy, position update, slippage failure | Needs a wallet, test USDC (deployer key mints) and an **open** market (both testnet markets are closed; `seed-market.sh` makes one) |
| Daily-pass payment + backend verification | Needs a wallet and test USDC |
| Wrong-network label | Needs a wallet on a non-testnet network |
| Trace shown as **verified** in the UI | Needs a trace whose content is really on IPFS (demo traces use a placeholder CID) |
| `useSell`, `useRedeem` | Implemented, no UI yet (backlog #01, #02) |
| x402 per-trace unlock | No client yet (backlog #09); no x402 facilitator is known |
| CI workflow | Never pushed |

## Decisions made, and why

- **Removed the `OracleDesk-Backend` submodule** rather than bumping it: the frontend talks to the backend over HTTP only, and the recorded commit was unpushed. Its unpushed commit (`207464d`, a padded `/portfolio/stats` endpoint) was preserved as the backend branch `rescued/platform-stats-207464d`. The local checkout was moved, not deleted, to `../OracleDesk-Frontend.backend-submodule-backup` (it had an untracked `prisma/dev.db`).
- **Wallets Kit 2.5.0, pinned exactly.** 2.6+ depends on SDK 17, while the bindings are generated for SDK 16. 2.5.0 keeps a single SDK copy. `^2.5.0` would have floated to 2.7.
- **`@types/node` 20 → 22,** required by Vitest 5; matches the Node 22 CI.
- **Premium page shows the backend's real product** (a 24-hour pass, default 0.50 USDC) instead of "$20 / $50 per month" tiers nothing implemented. Card payment is marked not available.
- **Copy-trade uses the backend for intent and access checks, and the wallet signs `market_core.buy` directly.** It refuses with no trace or zero edge.
- **Demo data is labelled, not replaced** with new invented numbers, where no real data source exists yet (stats panels, home feeds, wallet history, transaction screens).
- **ESLint ignores `contracts/` and generated code.** Two real bugs were found while fixing the remaining lint errors: the positions table read `pos.amount`, which the backend never sends (the field is `size`), and labelled every row "POLYMARKET". Both are fixed.
- **Admin pages are a UI gate only;** the backend enforces `ADMIN_ADDRESSES`. Matching is exact, because G-addresses are uppercase (the old code lowercased them).
- **License: MIT,** matching the contracts repo (the frontend had none).

## Decisions left for a human

1. Clear the `NEXT_PUBLIC_*` secrets from `.env` and hosting; rotate the Circle credentials (top of this file).
2. **Where payments go:** `NEXT_PUBLIC_PAYMENTS_RECIPIENT` defaults to the treasury, which makes subscription revenue agent trading capital. Must match the backend's `PAYMENTS_RECIPIENT`.
3. **EURC:** dropped (single-collateral contracts). See the backend STATUS.
4. **Submodules:** `contracts` kept and pinned at `eb5f3fd`; `OracleDesk-Backend` removed. Delete `../OracleDesk-Frontend.backend-submodule-backup` once you're happy nothing in it is needed.
5. **License:** MIT. Confirm.
6. **SECURITY contact:** placeholder `SECURITY-CONTACT-TBD@example.invalid` in `SECURITY.md`.
7. **Pricing:** what the paid tiers should be, now that the page shows the one product the backend sells.
8. **Test USDC access** for outside contributors: today only the deployer key can mint (contract-requests #3).
