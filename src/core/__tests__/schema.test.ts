/**
 * @file core/__tests__/schema.test.ts
 *
 * The rule that matters most: a schema violation must never suppress the
 * log line. Validation exists to keep structured logs queryable, and the
 * one thing worse than an inconsistently-shaped log is a missing one —
 * especially since the calls most likely to violate a schema are the ones
 * written in a hurry during an incident.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerSchema, clearSchemas, validateEntryData } from '../schema';
import type { StandardSchemaV1 } from '../schema';
import { createLogger } from '../logger';
import type { LogEntry } from '../types';

/**
 * A minimal Standard Schema implementation — the point of the spec is that
 * a validator needs nothing from us, so the test brings its own rather than
 * pulling in Zod.
 */
function objectSchema(required: Record<string, string>): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const issues: { message: string; path: string[] }[] = [];
        const data = (value ?? {}) as Record<string, unknown>;
        for (const [key, type] of Object.entries(required)) {
          if (typeof data[key] !== type) {
            issues.push({ message: `expected ${type}`, path: [key] });
          }
        }
        return issues.length > 0 ? { issues } : { value };
      },
    },
  };
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    message: 'm',
    context: {
      runtime: 'server',
      timestamp: '2026-01-01T00:00:00.000Z',
      sequence: 0,
      ...overrides.context,
    },
    ...overrides,
  } as LogEntry;
}

function capture(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const record = (chunk: unknown): boolean => {
    lines.push(String(chunk));
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
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  clearSchemas();
});

afterEach(() => {
  clearSchemas();
  vi.restoreAllMocks();
});

describe('validateEntryData', () => {
  it('passes matching data', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }));
    expect(
      validateEntryData(
        entry({ data: { orderId: 'o_1' }, context: { namespace: 'checkout' } as never }),
      ),
    ).toBeUndefined();
  });

  it('describes what is wrong, with the field path', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }));
    const problem = validateEntryData(
      entry({ data: { order_id: 'o_1' }, context: { namespace: 'checkout' } as never }),
    );

    // The drift case this whole feature exists for: `order_id` vs `orderId`.
    expect(problem).toContain('orderId');
    expect(problem).toContain('expected string');
  });

  it('applies to child namespaces', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }));
    expect(
      validateEntryData(entry({ data: {}, context: { namespace: 'checkout:payment' } as never })),
    ).toBeDefined();
  });

  it('ignores namespaces with no registered schema', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }));
    expect(
      validateEntryData(entry({ data: {}, context: { namespace: 'billing' } as never })),
    ).toBeUndefined();
  });

  it('lets a later registration win over an earlier, more general one', () => {
    registerSchema('a', objectSchema({ x: 'string' }));
    registerSchema('a:b', objectSchema({ y: 'string' }));

    const problem = validateEntryData(
      entry({ data: { y: 'ok' }, context: { namespace: 'a:b' } as never }),
    );
    expect(problem).toBeUndefined();
  });

  it('accepts a plain predicate', () => {
    registerSchema('p', (data) => (data as { ok?: boolean })?.ok === true || 'ok must be true');

    expect(
      validateEntryData(entry({ data: { ok: true }, context: { namespace: 'p' } as never })),
    ).toBeUndefined();
    expect(
      validateEntryData(entry({ data: { ok: false }, context: { namespace: 'p' } as never })),
    ).toBe('ok must be true');
  });

  it('reports rather than propagates a throwing validator', () => {
    registerSchema('t', () => {
      throw new Error('validator exploded');
    });

    expect(
      validateEntryData(entry({ data: {}, context: { namespace: 't' } as never })),
    ).toContain('validator exploded');
  });

  it('skips an async validator rather than blocking or floating it', () => {
    // `dispatch` is synchronous to the terminal write; there is nowhere to
    // await. Skipping is the honest option — the alternatives are a
    // floating promise or making every log call async.
    registerSchema('async', {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => ({ issues: [{ message: 'nope', path: ['x'] }] }),
      },
    });

    expect(
      validateEntryData(entry({ data: {}, context: { namespace: 'async' } as never })),
    ).toBeUndefined();
  });
});

describe('integration with dispatch', () => {
  it('logs the entry anyway and annotates it', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }), 'annotate');
    const logger = createLogger({ namespace: 'checkout' });

    const emitted = capture(() => logger.info('order placed', { order_id: 'o_1' }));

    // Never suppressed. The evidence survives; the problem is attached.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.message).toBe('order placed');
    const data = emitted[0]!.data as Record<string, unknown>;
    expect(data.order_id).toBe('o_1');
    expect(String(data.__schemaError)).toContain('orderId');
  });

  it('warns on the process console, not through the logger', () => {
    // Routing the warning through `log` would re-enter dispatch and, for a
    // schema on the same namespace, recurse.
    registerSchema('checkout', objectSchema({ orderId: 'string' }), 'warn');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger({ namespace: 'checkout' });

    const emitted = capture(() => logger.info('bad', {}));

    expect(warn).toHaveBeenCalledOnce();
    expect(emitted).toHaveLength(1);
  });

  it('does nothing in ignore mode', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }), 'ignore');
    const logger = createLogger({ namespace: 'checkout' });

    const emitted = capture(() => logger.info('bad', { nope: 1 }));
    expect(emitted[0]!.data).toEqual({ nope: 1 });
  });

  it('leaves matching entries untouched', () => {
    registerSchema('checkout', objectSchema({ orderId: 'string' }), 'annotate');
    const logger = createLogger({ namespace: 'checkout' });

    const emitted = capture(() => logger.info('good', { orderId: 'o_1' }));
    expect(emitted[0]!.data).toEqual({ orderId: 'o_1' });
  });

  it('costs nothing when no schema is registered', () => {
    const logger = createLogger({ namespace: 'anything' });
    const emitted = capture(() => logger.info('x', { a: 1 }));
    expect(emitted[0]!.data).toEqual({ a: 1 });
  });

  it('wraps a non-object data value rather than losing it', () => {
    registerSchema('scalar', () => 'always fails', 'annotate');
    const logger = createLogger({ namespace: 'scalar' });

    const emitted = capture(() => logger.info('x', 'a plain string'));
    expect(emitted[0]!.data).toMatchObject({
      value: 'a plain string',
      __schemaError: 'always fails',
    });
  });
});
