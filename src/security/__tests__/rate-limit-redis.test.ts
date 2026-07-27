/**
 * @file security/__tests__/rate-limit-redis.test.ts
 *
 * Two behaviours carry the weight here: the TTL must be set exactly once
 * per window (setting it on every increment means a steadily-loaded client
 * never sees the window reset, so it is banned forever), and Redis being
 * down must fail *open* (failing closed would silently delete every browser
 * log during an unrelated outage).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRedisRateLimiter,
  upstashRedisClient,
  _resetRedisRateLimitWarning,
  type RedisClient,
} from '../rate-limit-redis';

const policy = { limit: 3, windowMs: 10_000 };

/** An in-memory stand-in that records the commands it received. */
function fakeRedis(overrides: Partial<RedisClient> = {}) {
  const counters = new Map<string, number>();
  const commands: string[] = [];

  const client: RedisClient = {
    async incr(key) {
      commands.push(`INCR ${key}`);
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async pexpire(key, ms) {
      commands.push(`PEXPIRE ${key} ${ms}`);
      return 1;
    },
    async pttl() {
      return 4_200;
    },
    ...overrides,
  };

  return { client, commands, counters };
}

beforeEach(() => {
  _resetRedisRateLimitWarning();
  vi.restoreAllMocks();
});

describe('createRedisRateLimiter', () => {
  it('allows up to the limit and rejects past it', async () => {
    const { client } = fakeRedis();
    const check = createRedisRateLimiter(client);

    for (let i = 0; i < 3; i++) {
      expect((await check('1.2.3.4', policy)).allowed).toBe(true);
    }
    expect((await check('1.2.3.4', policy)).allowed).toBe(false);
  });

  it('counts each key separately', async () => {
    const { client } = fakeRedis();
    const check = createRedisRateLimiter(client);

    for (let i = 0; i < 3; i++) await check('a', policy);
    expect((await check('a', policy)).allowed).toBe(false);
    expect((await check('b', policy)).allowed).toBe(true);
  });

  it('sets the TTL only on the first increment of a window', async () => {
    // Extending the TTL on every call means a client at steady load resets
    // the expiry forever and is never let back in.
    const { client, commands } = fakeRedis();
    const check = createRedisRateLimiter(client);

    await check('k', policy);
    await check('k', policy);
    await check('k', policy);

    expect(commands.filter((c) => c.startsWith('PEXPIRE'))).toHaveLength(1);
  });

  it('encodes the window in the key so each window expires on its own', async () => {
    const { client, commands } = fakeRedis();
    const check = createRedisRateLimiter(client, { prefix: 'p:' });
    await check('k', policy);

    // No reset step to race on — a new window is simply a new key.
    expect(commands[0]).toMatch(/^INCR p:k:\d+$/);
  });

  it('separates windows in time', async () => {
    const { client } = fakeRedis();
    const check = createRedisRateLimiter(client);
    const now = Date.now();

    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 3; i++) await check('k', policy);
    expect((await check('k', policy)).allowed).toBe(false);

    // Next window — a different key, so the count starts over.
    vi.spyOn(Date, 'now').mockReturnValue(now + policy.windowMs);
    expect((await check('k', policy)).allowed).toBe(true);
  });

  it('reports retry-after from PTTL when rejecting', async () => {
    const { client } = fakeRedis();
    const check = createRedisRateLimiter(client);
    for (let i = 0; i < 3; i++) await check('k', policy);

    expect((await check('k', policy)).retryAfterSeconds).toBe(5); // ceil(4200 / 1000)
  });

  it('falls back to the full window when PTTL is unavailable', async () => {
    const { client } = fakeRedis({ pttl: undefined });
    const check = createRedisRateLimiter(client);
    for (let i = 0; i < 3; i++) await check('k', policy);

    expect((await check('k', policy)).retryAfterSeconds).toBe(10);
  });

  it('fails open when Redis errors, and reports it', async () => {
    // The alternative — failing closed — means a Redis outage silently
    // deletes every browser log. This guards a logging endpoint, not a
    // payment API.
    const onError = vi.fn();
    const check = createRedisRateLimiter(
      {
        incr: async () => {
          throw new Error('ECONNREFUSED');
        },
        pexpire: async () => 1,
      },
      { onError },
    );

    expect((await check('k', policy)).allowed).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails open when only PEXPIRE errors', async () => {
    const check = createRedisRateLimiter({
      incr: async () => 1,
      pexpire: async () => {
        throw new Error('timeout');
      },
    });

    expect((await check('k', policy)).allowed).toBe(true);
  });

  it('warns at most once by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = createRedisRateLimiter({
      incr: async () => {
        throw new Error('down');
      },
      pexpire: async () => 1,
    });

    await check('k', policy);
    await check('k', policy);
    await check('k', policy);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('upstashRedisClient', () => {
  it('returns null when nothing is configured', () => {
    // Lets an app wire this up unconditionally and simply fall back to the
    // in-memory limiter where there is no Redis.
    const previous = { ...process.env };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(upstashRedisClient()).toBeNull();
    Object.assign(process.env, previous);
  });

  it('issues Upstash REST commands', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200, json: async () => ({ result: 7 }) } as Response;
      }),
    );

    const client = upstashRedisClient({ url: 'https://r.upstash.io/', token: 't' })!;
    expect(await client.incr('k')).toBe(7);
    await client.pexpire('k', 5_000);

    expect(requests).toEqual([
      ['INCR', 'k'],
      ['PEXPIRE', 'k', 5000],
    ]);
    vi.unstubAllGlobals();
  });

  it('throws on an HTTP error so the limiter can fail open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    );

    const client = upstashRedisClient({ url: 'https://r.upstash.io', token: 't' })!;
    await expect(client.incr('k')).rejects.toThrow('500');
    vi.unstubAllGlobals();
  });

  it('throws on an Upstash-level error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ error: 'WRONGTYPE' }) }) as Response,
      ),
    );

    const client = upstashRedisClient({ url: 'https://r.upstash.io', token: 't' })!;
    await expect(client.incr('k')).rejects.toThrow('WRONGTYPE');
    vi.unstubAllGlobals();
  });
});
