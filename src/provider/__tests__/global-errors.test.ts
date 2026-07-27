/**
 * @file provider/__tests__/global-errors.test.ts
 *
 * The rules these pin are the ones that make automatic error capture safe
 * to turn on by default: it must not replace other handlers, must not
 * suppress the browser's own reporting, must not recurse, and must be
 * removable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installGlobalErrorHandlers,
  uninstallGlobalErrorHandlers,
} from '../global-errors';
import type { Logger } from '../../core/types';

interface Recorded {
  level: string;
  message: unknown;
  data?: unknown;
}

/** A Logger stand-in that records instead of dispatching. */
function makeRecordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const make = (level: string) => (message: unknown, data?: unknown) =>
    void records.push({ level, message, data });

  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    assert: () => {},
    time: () => {},
    timeEnd: () => undefined,
    timer: () => ({ end: () => 0, elapsed: () => 0 }),
    flush: async () => {},
    child: () => logger,
  };

  return { logger, records };
}

type Listener = (event: unknown) => void;

interface FakeWindow {
  addEventListener: (type: string, handler: Listener, capture?: boolean) => void;
  removeEventListener: (type: string, handler: Listener, capture?: boolean) => void;
  listeners: Map<string, Listener[]>;
}

function installFakeWindow(): FakeWindow {
  const listeners = new Map<string, Listener[]>();
  const fake: FakeWindow = {
    listeners,
    addEventListener: (type, handler) => {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    removeEventListener: (type, handler) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((h) => h !== handler));
    },
  };
  Object.assign(globalThis, { window: fake });
  return fake;
}

function fire(win: FakeWindow, type: string, event: unknown): void {
  for (const handler of win.listeners.get(type) ?? []) handler(event);
}

let win: FakeWindow;

beforeEach(() => {
  uninstallGlobalErrorHandlers();
  win = installFakeWindow();
});

afterEach(() => {
  uninstallGlobalErrorHandlers();
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('installGlobalErrorHandlers', () => {
  it('logs an uncaught error with the Error object intact', () => {
    const { logger, records } = makeRecordingLogger();
    installGlobalErrorHandlers({ logger });

    const error = new TypeError('boom');
    fire(win, 'error', { error, message: 'boom', filename: 'a.js', lineno: 3, colno: 7 });

    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe('error');
    // The Error itself is passed through, not a stringified copy — that is
    // what gets it full stack/cause serialisation downstream.
    expect(records[0]!.message).toBe(error);
    expect(records[0]!.data).toMatchObject({
      source: 'window.onerror',
      location: 'a.js:3:7',
    });
  });

  it('logs unhandled promise rejections, Error or not', () => {
    const { logger, records } = makeRecordingLogger();
    installGlobalErrorHandlers({ logger });

    fire(win, 'unhandledrejection', { reason: new Error('rejected') });
    // `reject('nope')` is extremely common and must not produce garbage.
    fire(win, 'unhandledrejection', { reason: 'nope' });

    expect(records).toHaveLength(2);
    expect((records[0]!.message as Error).message).toBe('rejected');
    expect(records[1]!.message).toBe('nope');
  });

  it('distinguishes a failed resource load from a thrown error', () => {
    // A 404'd <img> fires the same event type with no `error` property. Left
    // undistinguished it produces a stream of "Error: undefined" lines.
    const { logger, records } = makeRecordingLogger();
    installGlobalErrorHandlers({ logger });

    fire(win, 'error', {
      target: { tagName: 'IMG', src: 'https://example.com/missing.png' },
    });

    expect(records[0]!.level).toBe('warn');
    expect(records[0]!.message).toBe('Resource failed to load');
    expect(records[0]!.data).toMatchObject({ tag: 'img', url: 'https://example.com/missing.png' });
  });

  it('never calls preventDefault, so the browser console and other reporters still see it', () => {
    const { logger } = makeRecordingLogger();
    installGlobalErrorHandlers({ logger });

    const preventDefault = vi.fn();
    fire(win, 'error', { error: new Error('x'), preventDefault });
    fire(win, 'unhandledrejection', { reason: new Error('y'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not recurse when logging the error itself throws', () => {
    let calls = 0;
    const { logger } = makeRecordingLogger();
    const exploding: Logger = {
      ...logger,
      child: () => exploding,
      error: () => {
        calls++;
        throw new Error('logger is broken');
      },
    };

    installGlobalErrorHandlers({ logger: exploding });

    expect(() => fire(win, 'error', { error: new Error('original') })).not.toThrow();
    expect(calls).toBe(1);
  });

  it('is idempotent — installing twice does not double every line', () => {
    const { logger, records } = makeRecordingLogger();
    installGlobalErrorHandlers({ logger });
    installGlobalErrorHandlers({ logger });

    fire(win, 'error', { error: new Error('once') });
    expect(records).toHaveLength(1);
  });

  it('removes its listeners on uninstall', () => {
    const { logger, records } = makeRecordingLogger();
    const uninstall = installGlobalErrorHandlers({ logger });
    uninstall();

    fire(win, 'error', { error: new Error('after uninstall') });
    expect(records).toHaveLength(0);
  });

  it('is a no-op with no window', () => {
    delete (globalThis as { window?: unknown }).window;
    const { logger, records } = makeRecordingLogger();
    expect(() => installGlobalErrorHandlers({ logger })()).not.toThrow();
    expect(records).toHaveLength(0);
  });
});
