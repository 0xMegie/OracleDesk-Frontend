/**
 * JWT lifecycle management: expiry checking, invalid token handling,
 * single-flight re-authentication to prevent thundering herd.
 */

interface JWTPayload {
  exp: number;
  iat: number;
  [key: string]: unknown;
}

/**
 * Decode JWT payload without verification (client-side only).
 * Does not validate signature; use on decoded tokens only.
 */
export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Check if a token is expired (exp claim in the past).
 * Returns true if expired or invalid.
 */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJWT(token);
  if (!payload || typeof payload.exp !== "number") {
    return true;
  }

  const expiresAt = payload.exp * 1000; // JWT exp is in seconds
  const now = Date.now();
  // Consider token expired if within 30s of expiry (skew + time for request)
  const bufferMs = 30 * 1000;

  return now > expiresAt - bufferMs;
}

/**
 * Get time remaining until token expires (in milliseconds).
 * Returns 0 if already expired.
 */
export function getTokenTTL(token: string): number {
  const payload = decodeJWT(token);
  if (!payload || typeof payload.exp !== "number") {
    return 0;
  }

  const expiresAt = payload.exp * 1000;
  const now = Date.now();
  return Math.max(0, expiresAt - now);
}

/**
 * Single-flight re-auth: track in-flight auth requests to prevent
 * multiple concurrent re-auth attempts.
 */
let reAuthPromise: Promise<void> | null = null;

export function setReAuthPromise(promise: Promise<void> | null) {
  reAuthPromise = promise;
}

export function getReAuthPromise() {
  return reAuthPromise;
}

/**
 * Check if re-auth is currently in flight.
 */
export function isReAuthInFlight(): boolean {
  return reAuthPromise !== null;
}

/**
 * Wait for in-flight re-auth to complete (if any).
 * No-op if no re-auth in progress.
 */
export async function waitForReAuth(): Promise<void> {
  if (reAuthPromise) {
    try {
      await reAuthPromise;
    } catch {
      // Re-auth failed; let the caller handle it
    }
  }
}
