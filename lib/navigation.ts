/**
 * Returns `value` as a same-origin path (pathname, query and hash), or null.
 *
 * Only single-slash paths are accepted, so `//host` and `/\host` cannot leave
 * the site. The URL is parsed and its origin checked as well, which catches
 * tricks such as tabs inside the path. Used for `returnTo`, which can come
 * from a query string (deep links), so it is an open-redirect guard.
 */
export function safeReturnTo(value: string | null | undefined, base?: string): string | null {
  const origin = base ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
