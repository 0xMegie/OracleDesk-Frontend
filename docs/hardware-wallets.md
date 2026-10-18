# Hardware Wallet Support (Ledger, Trezor)

OracleDesk-Frontend supports hardware wallets through the Stellar Wallets Kit, which provides integration with Ledger and Trezor devices.

## Supported Devices

- **Ledger Nano S/S Plus/X**: USB connection via Ledger Live or ledger.com browser extension
- **Ledger Stax**: Bluetooth connection via Ledger Live
- **Trezor Model One/T**: USB connection via Trezor browser extension

## Enabled Modules

The app includes all wallet modules via `@creit.tech/stellar-wallets-kit/modules/utils`:

```typescript
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
// Includes: Freighter, WalletConnect, Ledger, Trezor, and others
```

## Browser Support

| Device | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| Ledger (USB HID) | ✅ | ✅ | ✅ (11+) | ✅ |
| Trezor | ✅ | ✅ | ⚠️ Limited | ✅ |

USB HID (required for direct USB connection) is supported in all modern browsers except Safari (uses WebHID).

## Using Hardware Wallets

### 1. Ledger

**Via browser extension (recommended):**
- Install [Ledger Live](https://www.ledgerwallet.com/) browser extension
- Or use [Ledger Stellar App](https://ledger.com/pages/ledger-stellar)
- Connect your device
- Open OracleDesk

**Via USB:**
- Connect Ledger device
- Open OracleDesk in a browser that supports WebHID (all except Safari)
- Select Ledger from wallet picker

**Transaction signing:**
1. OracleDesk displays "Confirm on device"
2. Review transaction on Ledger screen
3. Press right button to approve (or left to reject)

### 2. Trezor

**Via browser extension:**
- Install [Trezor Bridge](https://wallet.trezor.io/) or use browser extension
- Connect your device
- Open OracleDesk

**Via USB:**
- Connect Trezor device
- Open OracleDesk in a browser that supports WebHID
- Select Trezor from wallet picker

**Transaction signing:**
1. A browser popup window appears
2. Review transaction details
3. Click "Confirm" on device (or reject)

## SEP-10 Challenge Signing

Hardware wallets sign SEP-10 challenge transactions before the user can trade:

1. User clicks "Connect Wallet" → selects hardware wallet
2. OracleDesk requests a SEP-10 challenge from the backend
3. Challenge is validated before signing (see `lib/stellar/sep10-validator.ts`)
4. User confirms signature on device
5. Backend verifies signature and returns JWT

This prevents the user from accidentally signing arbitrary transactions.

## Troubleshooting

### "Device not found"
- Ensure device is connected and unlocked
- Try refreshing the page
- Check browser console for errors
- For Ledger: open Ledger Live and switch to browser mode

### "User rejected transaction"
- User cancelled on the device
- Try again or use a different account

### "Signature verification failed"
- Device may have outdated firmware; update via Ledger Live or Trezor Wallet
- Try a different account if available

### Safari limitations
- Safari doesn't support WebHID (required for direct USB connection)
- Use browser extensions (Ledger Live) instead
- Or switch to Chrome/Firefox/Edge

## Development

To test hardware wallet support:

```bash
npm run dev
# Open http://localhost:3000
# Connect any supported hardware wallet
# Try signing a transaction (trades auto-redirect to /markets after login)
```

The `lib/stellar/WalletProvider.tsx` initializes the Stellar Wallets Kit and handles wallet connection, disconnection, and signing.
