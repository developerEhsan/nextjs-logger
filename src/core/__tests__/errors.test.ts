/**
 * @file core/__tests__/errors.test.ts
 *
 * The bug this covers: `log.error(err)` produced `{}`, because every
 * interesting field on an `Error` is non-enumerable or on the prototype.
 * These tests assert against *captured terminal output*, not just the
 * serialiser in isolation, because that is where the failure was visible —
 * a serialiser that works while the formatter drops the result is the same
 * bug with extra steps.
 */

import { describe, it, expect, vi } from 'vitest';
import { serializeError, isErrorLike, normalizeErrorsDeep } from '../errors';
import { writeToTerminal } from '../../transport/server';
import { log } from '../logger';
import type { LogEntry } from '../types';

// ─── Capture helpers ─────────────────────────────────────────────────────

function captureStreams(fn: () => void): string {
  const chunks: string[] = [];
  const record = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(record);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(record);
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return chunks.join('');
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'error',
    message: 'boom',
    context: { runtime: 'server', timestamp: '2026-01-01T10:00:00.000Z', sequence: 0 },
    ...overrides,
  };
}

// ─── serializeError ──────────────────────────────────────────────────────

describe('serializeError', () => {
  it('captures the fields JSON.stringify silently loses', () => {
    // The regression itself, stated plainly.
    const err = new TypeError('cannot read x');
    expect(JSON.stringify(err)).toBe('{}');

    const serialized = serializeError(err);
    expect(serialized.name).toBe('TypeError');
    expect(serialized.message).toBe('cannot read x');
    expect(serialized.stack?.length).toBeGreaterThan(0);
    expect(serialized.stack?.[0]).toMatch(/^at /);
  });

  it('does not mistake the "Name: message" header for a stack frame', () => {
    const err = new Error('line one\nline two');
    const serialized = serializeError(err);
    // Both header lines must be excluded; every kept line is a real frame.
    for (const frame of serialized.stack ?? []) {
      expect(frame.startsWith('at ') || /@.+:\d+/.test(frame)).toBe(true);
    }
    expect(serialized.message).toBe('line one\nline two');
  });

  it('walks the cause chain', () => {
    const root = new Error('connection refused');
    const middle = new Error('query failed', { cause: root });
    const top = new Error('checkout failed', { cause: middle });

    const serialized = serializeError(top);
    expect(serialized.cause?.message).toBe('query failed');
    expect(serialized.cause?.cause?.message).toBe('connection refused');
  });

  it('caps the cause chain rather than recursing forever', () => {
    let err = new Error('depth-0');
    for (let i = 1; i < 20; i++) err = new Error(`depth-${i}`, { cause: err });

    const serialized = serializeError(err);
    let depth = 0;
    let node = serialized.cause;
    while (node) {
      depth++;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(5);
  });

  it('survives a cause cycle', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b; // a → b → a

    const serialized = serializeError(a);
    expect(serialized.message).toBe('a');
    expect(JSON.stringify(serialized)).toContain('circular error reference');
  });

  it('serialises AggregateError members', () => {
    const aggregate = new AggregateError(
      [new Error('first'), new TypeError('second')],
      'all failed',
    );

    const serialized = serializeError(aggregate);
    expect(serialized.message).toBe('all failed');
    expect(serialized.errors).toHaveLength(2);
    expect(serialized.errors?.[1]?.name).toBe('TypeError');
    expect(serialized.errors?.[1]?.message).toBe('second');
  });

  it('keeps own enumerable extras like code, statusCode and digest', () => {
    const err = Object.assign(new Error('not found'), {
      code: 'ENOENT',
      statusCode: 404,
      // Next.js attaches this to every Server Component error; losing it
      // means losing the only handle you have on a production RSC failure.
      digest: '3821046392',
    });

    const serialized = serializeError(err);
    expect(serialized.properties).toEqual({
      code: 'ENOENT',
      statusCode: 404,
      digest: '3821046392',
    });
  });

  it('does not blow up on a throwing getter', () => {
    const err = new Error('weird');
    Object.defineProperty(err, 'hostile', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });

    expect(() => serializeError(err)).not.toThrow();
    expect(serializeError(err).message).toBe('weird');
  });

  it('handles non-Error throws', () => {
    expect(serializeError('boom')).toMatchObject({ name: 'NonError', message: 'boom' });
    expect(serializeError(null)).toMatchObject({ name: 'NonError' });
    expect(serializeError({ code: 42 })).toMatchObject({
      name: 'NonError',
      properties: { code: 42 },
    });
  });

  it('recognises a cross-realm error by shape, not just instanceof', () => {
    // An error that came back over the relay is a plain object with the
    // right fields; `instanceof Error` is false for it.
    const relayed = { name: 'RangeError', message: 'out of range', stack: 'at x (a.js:1:1)' };
    expect(relayed instanceof Error).toBe(false);
    expect(isErrorLike(relayed)).toBe(true);
    expect(serializeError(relayed).name).toBe('RangeError');
  });
});

// ─── Errors nested in data ───────────────────────────────────────────────

describe('normalizeErrorsDeep', () => {
  it('replaces errors nested inside structured data', () => {
    const out = normalizeErrorsDeep({
      attempt: 3,
      failures: [{ err: new Error('inner') }],
    }) as { attempt: number; failures: { err: { message: string } }[] };

    expect(out.attempt).toBe(3);
    expect(out.failures[0]!.err.message).toBe('inner');
  });

  it('returns the same reference when there is nothing to rewrite', () => {
    // The hot path: no allocation for the overwhelmingly common case.
    const data = { userId: 42, tags: ['a', 'b'] };
    expect(normalizeErrorsDeep(data)).toBe(data);
  });

  it('does not recurse into class instances', () => {
    class Client {
      constructor(public secretHandle = {}) {}
    }
    const data = { client: new Client() };
    expect(normalizeErrorsDeep(data)).toBe(data);
  });
});

// ─── End-to-end: what actually reaches the terminal ──────────────────────

describe('error output', () => {
  /**
   * Parse the JSON line the default (non-development) config emits. These
   * assertions go through the real `log` singleton rather than calling
   * `writeToTerminal` directly, so they cover `dispatch`'s argument
   * normalisation as well as the formatter.
   */
  function logAndParse(fn: () => void): {
    message: string;
    data?: Record<string, unknown>;
    error?: { name: string; message: string; stack?: string[] };
  } {
    const output = captureStreams(fn).trim();
    return JSON.parse(output);
  }

  it('captures name, message and stack instead of an empty object', () => {
    const parsed = logAndParse(() => log.error(new TypeError('cannot read x')));

    // The regression: this used to serialise to `{}`.
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.name).toBe('TypeError');
    expect(parsed.error!.message).toBe('cannot read x');
    expect(parsed.error!.stack!.length).toBeGreaterThan(0);
    // The error also becomes the entry's message, so the terminal line is
    // readable without expanding the structured payload.
    expect(parsed.message).toBe('TypeError: cannot read x');
  });

  it('accepts an error as the second argument, keeping the caller message', () => {
    const parsed = logAndParse(() => log.error('checkout failed', new Error('card declined')));

    expect(parsed.message).toBe('checkout failed');
    expect(parsed.error!.message).toBe('card declined');
  });

  it('hoists an error out of data.error so it still gets a stack', () => {
    const parsed = logAndParse(() =>
      log.error('checkout failed', { orderId: 'o_1', error: new Error('card declined') }),
    );

    expect(parsed.error!.message).toBe('card declined');
    expect(parsed.error!.stack!.length).toBeGreaterThan(0);
    // The rest of the data object survives the hoist.
    expect(parsed.data).toEqual({ orderId: 'o_1' });
  });

  it('renders the cause chain', () => {
    const output = captureStreams(() => {
      writeToTerminal(
        entry({ error: serializeError(new Error('outer', { cause: new Error('inner') })) }),
        { prettyPrint: true },
      );
    });

    expect(output).toContain('Error: outer');
    expect(output).toContain('caused by:');
    expect(output).toContain('Error: inner');
  });

  it('includes the error in JSON output', () => {
    const output = captureStreams(() => {
      writeToTerminal(entry({ error: serializeError(new Error('json mode')) }), {
        prettyPrint: false,
      });
    });

    const parsed = JSON.parse(output.trim()) as { error: { name: string; message: string } };
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('json mode');
  });

  it('redacts secrets carried on the error object', () => {
    const err = Object.assign(new Error('auth failed'), { token: 'sk_live_abc' });
    const output = captureStreams(() => {
      writeToTerminal(entry({ error: serializeError(err) }), {
        prettyPrint: true,
        redactKeys: ['token'],
      });
    });

    expect(output).not.toContain('sk_live_abc');
    expect(output).toContain('[REDACTED]');
  });

  /**
   * A stack is the one field that is *printed as multiple lines*, which
   * makes a relayed frame the most attractive log-forgery vector in the
   * payload — the exact class of bug `sanitiseMessage` was hardened against
   * for `message` and `context`.
   */
  it('cannot be used to forge a log line through a crafted stack frame', () => {
    const forged = entry({
      error: {
        name: 'Error',
        message: 'ok',
        stack: ['at real (a.ts:1:1)\n01:02:03 [FATAL] credentials rotated'],
      },
    });

    const output = captureStreams(() => writeToTerminal(forged, { prettyPrint: true }));

    // The forged text survives, escaped, on the frame's own line — it never
    // becomes a line of its own.
    expect(output).toContain('\\n01:02:03');
    for (const line of output.split('\n')) {
      expect(line.trimStart().startsWith('01:02:03 [FATAL]')).toBe(false);
    }
  });

  it('strips ANSI escapes from a crafted error name', () => {
    const output = captureStreams(() =>
      writeToTerminal(
        entry({ error: { name: '\x1B]0;pwned\x07Error', message: 'x' } }),
        { prettyPrint: true },
      ),
    );
    expect(output).not.toContain('pwned');
  });
});
