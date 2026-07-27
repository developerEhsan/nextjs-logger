/**
 * @file security/rate-limit-redis.ts
 * Fleet-wide relay rate limiting backed by Redis.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * `security/rate-limit.ts` keeps its counters in memory, so on serverless
 * it limits each *warm instance* rather than the deployment. With N
 * instances the effective cap is N × the configured limit, and N is chosen
 * by the platform's autoscaler in response to the very traffic being
 * limited. That is not a bug in the in-memory limiter — it is the ceiling
 * of what in-memory state can promise — but it does mean the documented cap
 * is not the real one.
 *
 * A shared counter fixes it. Any Redis works; Upstash is the default shape
 * because its REST API needs no TCP socket, which is what makes it usable
 * from the Edge Runtime and from a serverless function that cannot hold a
 * connection pool.
 *
 * ── No dependency, again ─────────────────────────────────────────────────
 * `@upstash/redis` is not imported. The REST API is two HTTP calls
 * (`INCR`, `PEXPIRE`) and taking a dependency — even optional — to make
 * them would be more code than making them. A `RedisClient` interface is
 * also accepted, so `ioredis`, `node-redis` or a test double drop straight
 * in.
 *
 * ── Fail open, deliberately ──────────────────────────────────────────────
 * If Redis is unreachable, requests are **allowed**, and the in-memory
 * limiter (which the route handler still runs) remains as a floor. The
 * alternative — failing closed — means a Redis outage silently deletes all
 * your browser logs, which is both the more likely incident and the worse
 * outcome: this limiter protects a *logging endpoint*, not a payment API.
 * `onError` exists so the outage is visible rather than inferred.
 *
 * ── Why the window is fixed, not sliding ─────────────────────────────────
 * `INCR` + `PEXPIRE` on first increment is one round trip in the common
 * case and needs no Lua, no sorted set, and no clock agreement between
 * instances. A sliding window needs a sorted set per key and a ZREMRANGEBYSCORE
 * on every call — several times the cost, to make the boundary behaviour of
 * a log-flood cap slightly smoother. Not worth it here.
 */

import type { RateLimitPolicy } from './rate-limit';

/**
 * The two commands this needs. Satisfied by `ioredis`, `node-redis`, and
 * `@upstash/redis` alike — all three expose `incr` and `pexpire` with these
 * signatures.
 */
export interface RedisClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  /** Optional: used to report the exact reset time. */
  pttl?(key: string): Promise<number>;
}

export interface RedisRateLimitOptions {
  /** Key prefix, so this cannot collide with the app's own Redis keys. */
  prefix?: string;
  /**
   * Called when Redis is unreachable or errors. The request is allowed
   * regardless — see "fail open" above. Defaults to a one-time
   * `console.warn`, because an outage that only manifests as "the cap
   * quietly stopped applying" is the failure mode to avoid.
   */
  onError?: (error: unknown) => void;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Build an async rate-limit checker backed by a Redis client.
 *
 * @example
 *   import { Redis } from '@upstash/redis';
 *   const limiter = createRedisRateLimiter(Redis.fromEnv());
 *   configureLogger({ relayRateLimitAsync: limiter });
 */
export function createRedisRateLimiter(
  client: RedisClient,
  options: RedisRateLimitOptions = {},
): (key: string, policy: RateLimitPolicy) => Promise<RateLimitResult> {
  const prefix = options.prefix ?? 'logger:rl:';
  const onError = options.onError ?? warnOnce;

  return async function check(key, policy) {
    // The window is encoded in the key, which is what makes a plain INCR a
    // correct fixed-window counter: each window is a distinct key that
    // expires on its own, so there is no reset step to race on.
    const window = Math.floor(Date.now() / policy.windowMs);
    const redisKey = `${prefix}${key}:${window}`;

    try {
      const count = await client.incr(redisKey);

      // Only the first increment sets the TTL. Doing it every time would
      // continuously extend the window, so a client at steady load would
      // never see it reset.
      if (count === 1) {
        await client.pexpire(redisKey, policy.windowMs);
      }

      if (count > policy.limit) {
        return {
          allowed: false,
          retryAfterSeconds: await resetSeconds(client, redisKey, policy),
        };
      }

      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      onError(error);
      // Fail open — see the header.
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}

async function resetSeconds(
  client: RedisClient,
  redisKey: string,
  policy: RateLimitPolicy,
): Promise<number> {
  if (typeof client.pttl !== 'function') {
    return Math.ceil(policy.windowMs / 1000);
  }
  try {
    const ttl = await client.pttl(redisKey);
    // -1 (no expiry) and -2 (no key) both mean "can't say" — fall back to
    // the full window rather than telling the caller to retry immediately.
    return ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : Math.ceil(policy.windowMs / 1000);
  } catch {
    return Math.ceil(policy.windowMs / 1000);
  }
}

// ─── Upstash REST client ─────────────────────────────────────────────────

export interface UpstashOptions extends RedisRateLimitOptions {
  /** `UPSTASH_REDIS_REST_URL`. */
  url?: string;
  /** `UPSTASH_REDIS_REST_TOKEN`. */
  token?: string;
  /** Abort a Redis call after this long. Default 1s. */
  timeoutMs?: number;
}

/**
 * A `RedisClient` speaking Upstash's REST API over `fetch`.
 *
 * Reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` by default,
 * matching `Redis.fromEnv()`. Returns `null` when neither is configured, so
 * an app can wire this up unconditionally and simply get the in-memory
 * limiter in environments that have no Redis.
 *
 * The timeout defaults to **one second**, much tighter than a normal Redis
 * client's, on purpose: this call sits in front of every relay request, and
 * a slow limiter would add latency to the thing it is protecting. A timeout
 * fails open, exactly like an error.
 */
export function upstashRedisClient(options: UpstashOptions = {}): RedisClient | null {
  const url = options.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = options.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const timeoutMs = options.timeoutMs ?? 1_000;
  const base = url.replace(/\/$/, '');

  async function command(...args: (string | number)[]): Promise<unknown> {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`[logger] Upstash responded ${response.status}`);
    }

    const payload = (await response.json()) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(`[logger] Upstash error: ${payload.error}`);
    return payload.result;
  }

  return {
    async incr(key) {
      return Number(await command('INCR', key));
    },
    async pexpire(key, milliseconds) {
      return command('PEXPIRE', key, milliseconds);
    },
    async pttl(key) {
      return Number(await command('PTTL', key));
    },
  };
}

let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[logger] Redis rate limiter unavailable — relay requests are being allowed ' +
      'and only the per-instance in-memory cap applies. ' +
      `(${error instanceof Error ? error.message : String(error)})\n` +
      '(further occurrences of this warning are suppressed)',
  );
}

/** Test seam. */
export function _resetRedisRateLimitWarning(): void {
  warned = false;
}
