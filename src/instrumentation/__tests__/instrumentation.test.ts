/**
 * @file instrumentation/__tests__/instrumentation.test.ts
 *
 * `onRequestError` runs on the error path of a request that is already
 * failing, so the contract is mostly negative: it must not throw, must not
 * return a promise Next.js would await, and must not depend on anything
 * about the shape of what Next.js hands it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRequestErrorLogger,
  onRequestError,
  registerProcessErrorHandlers,
  _resetProcessErrorHandlers,
} from '../index';

interface Emitted {
  level: string;
  message: string;
  namespace?: string;
  data?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string[] };
}

function capture(fn: () => void): Emitted[] {
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
    .map((line) => JSON.parse(line) as Emitted);
}

describe('onRequestError', () => {
  it('logs the error with request and route context', () => {
    const emitted = capture(() =>
      onRequestError(
        new Error('render failed'),
        { path: '/orders/42', method: 'GET' },
        { routerKind: 'App Router', routePath: '/orders/[id]', routeType: 'render' },
      ),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.level).toBe('error');
    expect(emitted[0]!.namespace).toBe('request');
    expect(emitted[0]!.error!.message).toBe('render failed');
    expect(emitted[0]!.error!.stack!.length).toBeGreaterThan(0);
    expect(emitted[0]!.data).toMatchObject({
      method: 'GET',
      path: '/orders/42',
      routePath: '/orders/[id]',
      routeType: 'render',
    });
  });

  it('keeps the digest Next.js attaches to Server Component errors', () => {
    // In production this is the *only* identifier tying a user-visible
    // error page back to a server log line.
    const error = Object.assign(new Error('boom'), { digest: '2938471' });
    const emitted = capture(() => onRequestError(error, {}, {}));

    expect(JSON.stringify(emitted[0]!.error)).toContain('2938471');
  });

  it('omits optional context fields rather than logging undefined', () => {
    const emitted = capture(() => onRequestError(new Error('x'), {}, {}));
    expect(emitted[0]!.data).not.toHaveProperty('renderSource');
    expect(emitted[0]!.data).not.toHaveProperty('revalidateReason');
  });

  it('returns undefined synchronously — Next.js awaits this hook', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = onRequestError(new Error('x'), {}, {});
    vi.restoreAllMocks();
    expect(result).toBeUndefined();
  });

  it('does not throw when handed nothing useful', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() =>
      onRequestError(
        undefined,
        undefined as unknown as Record<string, never>,
        undefined as unknown as Record<string, never>,
      ),
    ).not.toThrow();
    vi.restoreAllMocks();
  });

  it('honours a custom namespace and level', () => {
    const handler = createRequestErrorLogger({ namespace: 'rsc', level: 'fatal' });
    const emitted = capture(() => handler(new Error('x'), {}, {}));

    expect(emitted[0]!.namespace).toBe('rsc');
    expect(emitted[0]!.level).toBe('fatal');
  });
});

describe('registerProcessErrorHandlers', () => {
  beforeEach(() => {
    _resetProcessErrorHandlers();
  });

  it('registers both process listeners exactly once', () => {
    const on = vi.spyOn(process, 'on').mockImplementation(() => process);

    registerProcessErrorHandlers();
    registerProcessErrorHandlers(); // second call must be a no-op

    const events = on.mock.calls.map((call) => call[0]);
    expect(events).toEqual(['uncaughtException', 'unhandledRejection']);
    on.mockRestore();
  });

  it('logs an uncaught exception at fatal level without exiting by default', () => {
    const handlers = new Map<string, (arg: unknown) => void>();
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
      return process;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    registerProcessErrorHandlers();
    const emitted = capture(() => handlers.get('uncaughtException')!(new Error('fatal boom')));

    expect(emitted[0]!.level).toBe('fatal');
    expect(emitted[0]!.error!.message).toBe('fatal boom');
    // Registering the listener already suppressed Node's default crash;
    // exiting is opt-in precisely because that trade-off belongs to the app.
    expect(exit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('exits when asked to', () => {
    const handlers = new Map<string, (arg: unknown) => void>();
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
      return process;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    registerProcessErrorHandlers({ exitOnUncaught: true });
    handlers.get('uncaughtException')!(new Error('boom'));

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
