/** USDC on Stellar (the SAC in deployments.testnet.json) has 7 decimals. */
export const USDC_DECIMALS = 7;
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);
export const BPS = 10_000n;

/**
 * Parses a decimal USDC string into base units. Accepts "1", "1.5", "0.0000001".
 * Rejects exponents ("1e5"), signs, spaces inside, empty strings and more
 * than 7 decimal places. Never goes through a float.
 */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed) ?? /^()\.(\d+)$/.exec(trimmed);
  if (!match) throw new Error(`Enter an amount like 10 or 2.5`);
  const [, whole, frac = ""] = match;
  if (frac.length > USDC_DECIMALS) throw new Error(`USDC has at most ${USDC_DECIMALS} decimal places`);
  return BigInt(whole || "0") * USDC_UNIT + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Like parseUsdc but returns null instead of throwing. */
export function tryParseUsdc(input: string): bigint | null {
  try {
    return parseUsdc(input);
  } catch {
    return null;
  }
}

export const XLM_DECIMALS = 7;
export const XLM_UNIT = 10n ** BigInt(XLM_DECIMALS);

function formatFixed(
  raw: bigint,
  decimals: number,
  opts: { minDecimals?: number; maxDecimals?: number; grouping?: boolean } = {},
): string {
  const { minDecimals = 0, maxDecimals = decimals, grouping = false } = opts;
  const unit = 10n ** BigInt(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = (abs / unit).toString();
  let frac = (abs % unit).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  const wholeOut = grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  return `${negative ? "-" : ""}${wholeOut}${frac ? `.${frac}` : ""}`;
}

/**
 * Formats base units as a decimal string. Trailing zeros are trimmed unless
 * `minDecimals` asks for some; `maxDecimals` truncates (never rounds up).
 */
export function formatUsdc(raw: bigint, opts: { minDecimals?: number; maxDecimals?: number; grouping?: boolean } = {}): string {
  return formatFixed(raw, USDC_DECIMALS, opts);
}

/**
 * Formats stroops as a decimal XLM string with 7 decimal places.
 */
export function formatXlm(stroops: bigint, opts: { minDecimals?: number; maxDecimals?: number; grouping?: boolean } = {}): string {
  return formatFixed(stroops, XLM_DECIMALS, opts);
}

/** Display-only conversion. Never feed the result back into a transaction. */
export const usdcToNumber = (raw: bigint) => Number(formatUsdc(raw));

/**
 * Minimum acceptable output for a quote with `slippageBps` tolerance.
 * Rounds down, i.e. against the user: the bound is never looser than asked.
 */
export function minOut(quote: bigint, slippageBps: number | bigint): bigint {
  const bps = BigInt(slippageBps);
  if (quote < 0n || bps < 0n || bps > BPS) throw new Error("Invalid slippage");
  return (quote * (BPS - bps)) / BPS;
}

/**
 * Maximum acceptable input for a target with `slippageBps` tolerance.
 * Rounds up, against the user.
 */
export function maxIn(target: bigint, slippageBps: number | bigint): bigint {
  const bps = BigInt(slippageBps);
  if (target < 0n || bps < 0n) throw new Error("Invalid slippage");
  const numerator = target * (BPS + bps);
  return (numerator + BPS - 1n) / BPS;
}

/** Share of `amount` given in basis points, rounded down. */
export const shareOf = (amount: bigint, bps: number | bigint) => (amount * BigInt(bps)) / BPS;

export const bpsToPercent = (bps: number | bigint, decimals = 1) => `${(Number(bps) / 100).toFixed(decimals)}%`;

export function shortAddress(address: string | null | undefined, lead = 4, tail = 4): string {
  if (!address) return "";
  return address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
