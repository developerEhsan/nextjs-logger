/**
 * @file core/__tests__/timing.test.ts
 * Covers `log.time`/`timeEnd`, the concurrency-safe `log.timer`, `assert`,
 * and the `withLogging` wrapper.
 *
 * The invariants that matter most here are the ones about *not changing the
 * caller's behaviour*: `withLogging` must re-throw the original error
 * untouched, must not turn a sync function async, and must forward `this`.
 * A logging wrapper that quietly alters control flow is worse than no
 * wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log, createLogger } from '../logger';
import { withLogging, _resetTimers } from '../timing';

interface Emitted {
  level: string;
  message: string;
  data?: Record<string, unknown>;
  error?: { name: string; message: string };
}

function capture(fn: () => void | Promise<void>): Promise<Emitted[]> {
  const lines: string[] = [];
  const record = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(record);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(record);

  const done = (): Emitted[] => {
    out.mockRestore();
    err.mockRestore();
    return lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Emitted);
  };

  try {
    const result = fn();
    if (result instanceof Promise) return result.then(done, (e) => { done(); throw e; });
    return Promise.resolve(done());
  } catch (e) {
    done();
    throw e;
  }
}

beforeEach(() => {
  _resetTimers();
});

// ─── time / timeEnd ──────────────────────────────────────────────────────

describe('log.time / log.timeEnd', () => {
  it('logs the elapsed duration, both in the message and as structured data', async () => {
    const debugLogger = createLogger({ minLevel: 'debug' });
    const emitted = await capture(() => {
      debugLogger.time('checkout');
      debugLogger.timeEnd('checkout');
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.message).toMatch(/^checkout: [\d.]+ms$/);
    // `durationMs` is what makes a timing queryable downstream; a duration
    // that exists only inside the message string is not.
    expect(typeof emitted[0]!.data!.durationMs).toBe('number');
  });

  it('returns the elapsed milliseconds', () => {
    const debugLogger = createLogger({ minLevel: 'debug' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    debugLogger.time('t');
    const elapsed = debugLogger.timeEnd('t');
    vi.restoreAllMocks();

    expect(typeof elapsed).toBe('number');
    expect(elapsed!).toBeGreaterThanOrEqual(0);
  });

  it('warns instead of silently doing nothing for an unknown label', async () => {
    const emitted = await capture(() => {
      log.timeEnd('never-started');
    });

    expect(emitted[0]!.level).toBe('warn');
    expect(emitted[0]!.message).toContain('does not exist');
  });

  it('keeps labels separate per namespace', async () => {
    const a = createLogger({ minLevel: 'debug', namespace: 'a' });
    const b = createLogger({ minLevel: 'debug', namespace: 'b' });

    const emitted = await capture(() => {
      a.time('work');
      b.time('work');
      a.timeEnd('work');
      b.timeEnd('work');
    });

    // Both resolve — neither consumed the other's entry.
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.message.startsWith('work:'))).toBe(true);
  });
});

// ─── timer handle ────────────────────────────────────────────────────────

describe('log.timer', () => {
  it('does not share state between concurrent handles with the same label', async () => {
    const logger = createLogger({ minLevel: 'debug' });

    const emitted = await capture(async () => {
      // The exact scenario `time`/`timeEnd` cannot survive on a server:
      // two "requests" using one label, finishing out of order.
      const first = logger.timer('request');
      await new Promise((resolve) => setTimeout(resolve, 15));
      const second = logger.timer('request');
      second.end({ which: 'second' });
      first.end({ which: 'first' });
    });

    expect(emitted).toHaveLength(2);
    const [second, first] = emitted;
    // The one started earlier must report the longer duration; with shared
    // label state the second `end()` would have found nothing at all.
    expect(first!.data!.durationMs as number).toBeGreaterThan(
      second!.data!.durationMs as number,
    );
  });

  it('is idempotent — ending twice logs once', async () => {
    const logger = createLogger({ minLevel: 'debug' });
    const emitted = await capture(() => {
      const t = logger.timer('once');
      t.end();
      t.end();
    });

    expect(emitted).toHaveLength(1);
  });

  it('reports elapsed time without logging', async () => {
    const logger = createLogger({ minLevel: 'debug' });
    const emitted = await capture(() => {
      const t = logger.timer('peek');
      expect(typeof t.elapsed()).toBe('number');
    });

    expect(emitted).toHaveLength(0);
  });

  it('honours an explicit level', async () => {
    const emitted = await capture(() => {
      log.timer('slow', 'warn').end();
    });
    expect(emitted[0]!.level).toBe('warn');
  });
});

// ─── assert ──────────────────────────────────────────────────────────────

describe('log.assert', () => {
  it('logs nothing when the condition holds', async () => {
    const emitted = await capture(() => log.assert(true, 'never printed'));
    expect(emitted).toHaveLength(0);
  });

  it('logs at error level when the condition fails', async () => {
    const emitted = await capture(() => log.assert(0, 'count must be positive', { count: 0 }));
    expect(emitted[0]!.level).toBe('error');
    expect(emitted[0]!.message).toBe('count must be positive');
    expect(emitted[0]!.data).toEqual({ count: 0 });
  });

  it('has a default message', async () => {
    const emitted = await capture(() => log.assert(false));
    expect(emitted[0]!.message).toBe('Assertion failed');
  });
});

// ─── withLogging ─────────────────────────────────────────────────────────

describe('withLogging', () => {
  it('logs entry and completion with a duration', async () => {
    const wrapped = withLogging(async (n: number) => n * 2, {
      name: 'double',
      logger: createLogger({ minLevel: 'debug' }),
    });

    let result: number | undefined;
    const emitted = await capture(async () => {
      result = await wrapped(21);
    });

    expect(result).toBe(42);
    expect(emitted.map((e) => e.message)).toEqual(['→ double', '✓ double']);
    expect(typeof emitted[1]!.data!.durationMs).toBe('number');
  });

  it('logs the failure and re-throws the original error untouched', async () => {
    const boom = new Error('db down');
    const wrapped = withLogging(
      async () => {
        throw boom;
      },
      { name: 'save', entryLevel: false },
    );

    let caught: unknown;
    const emitted = await capture(async () => {
      await wrapped().catch((e: unknown) => {
        caught = e;
      });
    });

    // Same reference — nothing wrapped, re-typed, or swallowed.
    expect(caught).toBe(boom);
    expect(emitted[0]!.level).toBe('error');
    expect(emitted[0]!.message).toBe('✗ save');
    // Full serialisation, because the wrapper passes the error as
    // `data.error` and dispatch hoists it.
    expect(emitted[0]!.error!.message).toBe('db down');
  });

  it('keeps a synchronous function synchronous', () => {
    // A wrapper that returned a promise here would silently break every
    // sync caller and any Route Handler signature.
    const wrapped = withLogging(() => 'sync', { name: 's', entryLevel: false });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = wrapped();
    vi.restoreAllMocks();

    expect(result).toBe('sync');
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('logs and re-throws for a synchronous throw', () => {
    const wrapped = withLogging(
      () => {
        throw new Error('sync boom');
      },
      { name: 'sy', entryLevel: false },
    );

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => wrapped()).toThrow('sync boom');
    vi.restoreAllMocks();
  });

  it('forwards `this` so wrapped methods still work', () => {
    const object = {
      value: 7,
      getValue: withLogging(function (this: { value: number }) {
        return this.value;
      }, { name: 'getValue', entryLevel: false }),
    };

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = object.getValue();
    vi.restoreAllMocks();

    expect(result).toBe(7);
  });

  it('omits arguments and results unless explicitly asked', async () => {
    const wrapped = withLogging(async (secret: string) => `handled ${secret}`, {
      name: 'sensitive',
      entryLevel: false,
    });

    const emitted = await capture(async () => {
      await wrapped('sk_live_abc');
    });

    // Positional arguments are not reachable by `redactKeys`, which matches
    // on object keys — so they must be opt-in, not default.
    expect(JSON.stringify(emitted)).not.toContain('sk_live_abc');
  });

  it('includes arguments and results when asked', async () => {
    const wrapped = withLogging(async (n: number) => n + 1, {
      name: 'inc',
      entryLevel: 'debug',
      logArgs: true,
      logResult: true,
      logger: createLogger({ minLevel: 'debug' }),
    });

    const emitted = await capture(async () => {
      await wrapped(1);
    });

    expect(emitted[0]!.data!.args).toEqual([1]);
    expect(emitted[1]!.data!.result).toBe(2);
  });

  it('preserves the function name for Server Action registration', () => {
    const wrapped = withLogging(async function createOrder() {}, {});
    expect(wrapped.name).toBe('createOrder');
  });

  it('merges the static data option into every line', async () => {
    const wrapped = withLogging(async () => undefined, {
      name: 'tagged',
      entryLevel: false,
      data: { tenant: 'acme' },
    });

    const emitted = await capture(async () => {
      await wrapped();
    });

    expect(emitted[0]!.data!.tenant).toBe('acme');
  });
});
