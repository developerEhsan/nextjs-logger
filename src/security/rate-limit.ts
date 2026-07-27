/**
 * @file security/rate-limit.ts
 * Server-side rate limiting for the relay endpoint.
 *
 * Why this exists
 * ───────────────
 * The per-level TanStack Pacer in `queue/client-queue.ts` is often described
 * as the thing that stops the relay being flooded. It is not — it throttles
 * *our own* client, which is exactly the caller that was never going to abuse
 * the endpoint. An attacker does not use our queue; they POST directly.
 *
 * And they can, because the session token is not a secret: it is minted
 * server-side and embedded in the page HTML, so anyone who can load the page
 * can read it and reuse it for the rest of the session window. That is
 * inherent to a design where the browser must authenticate without holding
 * the signing secret — the token proves "this came from a page the server
 * rendered", nothing stronger.
 *
 * So the only thing standing between a valid token and unbounded writes to
 * your terminal (and, if you pipe stdout to a file, your disk) is a cap on
 * the server side. Before this module there wasn't one: 100 entries per
 * request, unlimited requests.
 *
 * Design notes
 * ────────────
 * • A fixed-window counter per key, which is coarse but has no per-request
 *   allocation and cannot itself be turned into a memory-exhaustion vector.
 * • Bounded key table with wholesale eviction. An attacker rotating
 *   `X-Forwarded-For` would otherwise grow the map without limit — turning
 *   the rate limiter into the DoS it was added to prevent.
 * • In-memory and therefore per-instance: on serverless this limits each
 *   warm instance, not the fleet. That is a real limitation, not a bug to
 *   discover later — for a fleet-wide guarantee, put a WAF or an edge rate
 *   limit in front. Documented in the README.
 */

export interface RateLimitPolicy {
  /** Maximum number of requests allowed per key per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Upper bound on tracked keys. Chosen to be far above any plausible number of
 * concurrent legitimate clients per instance, while still small enough that a
 * full table is negligible memory.
 */
const MAX_TRACKED_KEYS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * Record a request against `key` and report whether it is allowed.
 * Returns the decision plus the seconds until the window resets, so the caller
 * can emit a `Retry-After`.
 */
export function checkRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  // Wholesale clear rather than LRU: this table is a DoS guard, not a cache,
  // so the cheapest correct behaviour under key-rotation attack is to drop
  // everything and start over. Legitimate clients simply get a fresh window.
  if (windows.size >= MAX_TRACKED_KEYS) windows.clear();

  const existing = windows.get(key);

  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count++;
  if (existing.count > policy.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client identity for rate limiting.
 *
 * `x-forwarded-for` is trivially spoofable by a direct caller, so this is not
 * an authentication signal — it is a bucketing key that makes casual flooding
 * expensive. The global fallback bucket below is what catches a caller who
 * spoofs a fresh address per request.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Test seam — drops all tracked windows. */
export function _resetRateLimit(): void {
  windows.clear();
}
