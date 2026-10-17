# Bugfix Requirements Document

## Introduction

The frontend assumes every trader is an ed25519 keypair wallet (a `G…` address). Stellar supports contract accounts — passkey smart wallets — that are identified by a `C…` address and authenticate via WebAuthn (secp256r1) rather than ed25519. Three concrete bugs prevent these accounts from trading:

1. The `Signer` type only models ed25519 accounts, so there is no way to represent a contract-account signer. Every write path reads `signer.publicKey` as the trader address and calls `tx.signAndSend()` (which signs a whole envelope), both of which are wrong for a contract account.
2. The backend login flow (`signInWithWallet` / `assertStellarAccount`) issues a SEP-10 challenge transaction and expects an ed25519 signature; a contract account cannot sign that challenge.
3. UI copy and error messages were written for ed25519 accounts: the wallet dropdown says "Account history" and links to an account explorer page, and `describeError` can surface trustline advice that has no meaning for contract-account holders.

This spec gates all fixes behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS === "true"` so the existing path is never disturbed.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user connects a passkey smart wallet (`C…` address) and attempts to buy, sell, redeem, or transfer THEN the system uses `signer.publicKey` as the trader address, which is `undefined` for a contract signer, causing the transaction to be built with an invalid source and the trade to fail.

1.2 WHEN a user connects a passkey smart wallet and the write path calls `tx.signAndSend()` THEN the system attempts to sign the full transaction envelope with the contract address, which is not a valid ed25519 signer, causing submission to fail.

1.3 WHEN a user connects a passkey smart wallet and `openModal` or `ensureSession` is called THEN the system calls `signInWithWallet`, which POSTs to `/auth/challenge`, receives a SEP-10 challenge transaction, and expects the wallet to call `signTransaction`; a contract account cannot sign a transaction envelope, so authentication always fails.

1.4 WHEN the connected address is a `C…` contract address and an error occurs during a trade THEN the system may surface a trustline-missing message (e.g. "Add the USDC asset in your wallet first"), which does not apply to contract accounts and misleads the user.

1.5 WHEN the connected address is a `C…` contract address and the user opens the wallet dropdown THEN the system displays "Account history" and links to a Stellar Expert account page formatted for ed25519 accounts, which is incorrect for contract addresses.

1.6 WHEN `useWriteGuard` runs an `isWrongNetwork` check for a passkey signer THEN the system has no network passphrase from the wallets kit for a passkey flow, so the check always evaluates incorrectly, potentially blocking valid trades or allowing wrong-network trades.

---

### Expected Behavior (Correct)

2.1 WHEN a user connects a passkey smart wallet (`C…` address) and attempts to buy, sell, redeem, or transfer THEN the system SHALL use `signerAddress(signer)` (i.e. the `C…` address) as the trader address so the transaction is built correctly.

2.2 WHEN a user connects a passkey smart wallet and a write operation is initiated THEN the system SHALL sign only the Soroban authorization entries (via `signAuthEntry`) rather than the whole envelope, and SHALL submit the assembled transaction through a relayer or fee-paying source account (not via `tx.signAndSend()`).

2.3 WHEN a user connects a passkey smart wallet and authentication is required THEN the system SHALL use a contract-account challenge flow (SEP-45 or equivalent contract-auth challenge) that signs a 32-byte payload hash via WebAuthn rather than a transaction envelope, and SHALL gate this flow behind `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS`.

2.4 WHEN the connected address is a `C…` contract address and an error occurs during a trade THEN the system SHALL suppress trustline-related error messages for contract addresses and instead show a generic "Something went wrong" or a contract-specific error message.

2.5 WHEN the connected address is a `C…` contract address and the user opens the wallet dropdown THEN the system SHALL display "Wallet history" (not "Account history") and SHALL link to the Stellar Expert contract explorer page (`/contract/…`) instead of the account page.

2.6 WHEN `useWriteGuard` runs network checks for a passkey signer THEN the system SHALL bypass the `isWrongNetwork` check (since network identity is derived from the contract, not the wallets kit), so valid passkey trades are never incorrectly blocked.

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user connects a standard ed25519 wallet (`G…` address) and attempts to buy, sell, redeem, or transfer THEN the system SHALL CONTINUE TO use `signer.publicKey` as the trader address and submit via `tx.signAndSend()` exactly as today.

3.2 WHEN a user connects a standard ed25519 wallet and authenticates THEN the system SHALL CONTINUE TO use the SEP-10 challenge-transaction flow (`signInWithWallet`) without any change to that code path.

3.3 WHEN a standard ed25519 wallet triggers a trustline-missing error THEN the system SHALL CONTINUE TO display the trustline advice message ("Add the USDC asset in your wallet first").

3.4 WHEN a standard ed25519 wallet is connected and the wallet dropdown is open THEN the system SHALL CONTINUE TO display "Account history" and link to the Stellar Expert account explorer page.

3.5 WHEN `NEXT_PUBLIC_EXPERIMENTAL_PASSKEYS` is not set or is set to any value other than `"true"` THEN the system SHALL CONTINUE TO show no passkey connection option in the UI and SHALL CONTINUE TO route all sign-in and trade operations through the existing ed25519 paths.

3.6 WHEN a standard ed25519 wallet is connected and `useWriteGuard` runs THEN the system SHALL CONTINUE TO enforce the `isWrongNetwork` check and block trades on the wrong network.

3.7 WHEN read operations (usePosition, useUsdcBalance, useOnChainMarket) are called with any address THEN the system SHALL CONTINUE TO work unchanged, since reads already accept any address and do not depend on signer kind.
