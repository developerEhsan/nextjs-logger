/**
 * @file core/__tests__/client-dispatch.test.ts
 *
 * Covers the browser half of `dispatch()` — the path that was completely dead
 * in a shipped release and had no test coverage at all.
 *
 * Background: `LoggerBootstrapClient` lost its `'use client'` directive during
 * bundling, so Next.js never shipped it to the browser and
 * `initClientLogger()` only ever ran on the server. In the browser
 * `clientBootstrap` therefore stayed null forever, and every `log.*()` call
 * went into `preInitBuffer` and was never flushed — silently, with no error.
 *
 * The build-level cause is guarded by `src/__tests__/build-contract.test.ts`.
 * These tests pin the *behavioural* contract that made the failure survivable
 * in principle and silent in practice:
 *
 *   • a log emitted before bootstrap must be buffered, not dropped;
 *   • it must actually be flushed to the relay once bootstrap happens;
 *   • the buffer must be bounded so a never-bootstrapped page cannot grow it
 *     without limit.
 *
 * If the flush-on-init link is ever broken again, the first test here fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LogEntry } from '../types';

vi.mock('../../transport/client', () => ({
  relayEntries: vi.fn().mockResolvedValue(undefined),
  relayEntriesBeacon: vi.fn(),
}));

/** Minimal browser globals: enough for isServer() to be false and for
 *  ClientQueue's unload-handler registration to succeed. */
function installFakeBrowser(): void {
  const listeners = new Map<string, unknown>();
  const target = { addEventListener: (t: string, h: unknown) => listeners.set(t, h) };
  Object.assign(globalThis, {
    window: target,
    document: { ...target, visibilityState: 'visible' },
  });
}

function removeFakeBrowser(): void {
  for (const k of ['window', 'document']) {
    delete (globalThis as Record<string, unknown>)[k];
  }
}

const BOOTSTRAP = {
  relayUrl: '/api/log-relay',
  signedToken: 'session-token',
  issuedAt: new Date().toISOString(),
  debug: false,
};

/**
 * Load a pristine copy of core/logger with browser globals in place.
 * Fresh modules matter: `clientBootstrap` and `preInitBuffer` are module-level
 * state with no public reset.
 */
async function loadLoggerInBrowser() {
  removeFakeBrowser();
  installFakeBrowser();
  vi.resetModules();
  const logger = await import('../logger');
  // Re-imported after resetModules so we hold the *current* mock instance.
  const transport = await import('../../transport/client');
  return { ...logger, relayEntries: transport.relayEntries as ReturnType<typeof vi.fn> };
}

/** Every entry handed to the relay across all calls, flattened. */
function relayedEntries(relayEntries: ReturnType<typeof vi.fn>): LogEntry[] {
  return relayEntries.mock.calls.flatMap((call) => call[0] as LogEntry[]);
}

afterEach(() => {
  removeFakeBrowser();
  vi.clearAllMocks();
});

describe('client dispatch — pre-bootstrap buffering', () => {
  it('buffers a log emitted before bootstrap instead of dropping it', async () => {
    const { log, relayEntries } = await loadLoggerInBrowser();

    log.info('logged before bootstrap');

    // Nothing can be relayed yet — there is no session token and no queue.
    expect(relayEntries).not.toHaveBeenCalled();
  });

  it('flushes buffered pre-bootstrap logs the moment initClientLogger() runs', async () => {
    // THE regression test for the shipped bug: browser logs were buffered and
    // then never flushed, because bootstrap never ran in the browser at all.
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    log.info('first');
    log.warn('second');
    log.error('third');

    initClientLogger(BOOTSTRAP);
    await log.flush();

    expect(relayedEntries(relayEntries).map((e) => e.message)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('preserves level and namespace through the buffer', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    log.child('checkout').error('payment failed', { orderId: 'o_1' });

    initClientLogger(BOOTSTRAP);
    await log.flush();

    const [entry] = relayedEntries(relayEntries);
    expect(entry?.level).toBe('error');
    expect(entry?.context.namespace).toBe('checkout');
    expect(entry?.context.runtime).toBe('client');
    expect(entry?.data).toEqual({ orderId: 'o_1' });
  });

  it('bounds the pre-init buffer at 200 entries so a never-bootstrapped page cannot leak', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    for (let i = 0; i < 250; i++) log.info(`entry-${i}`);

    initClientLogger(BOOTSTRAP);
    await log.flush();

    const messages = relayedEntries(relayEntries).map((e) => e.message);
    expect(messages).toHaveLength(200);
    // The cap keeps the OLDEST 200 (it stops accepting once full).
    expect(messages[0]).toBe('entry-0');
    expect(messages.at(-1)).toBe('entry-199');
  });

  it('routes logs emitted after bootstrap straight to the queue', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    initClientLogger(BOOTSTRAP);
    log.info('after bootstrap');
    await log.flush();

    expect(relayedEntries(relayEntries).map((e) => e.message)).toContain('after bootstrap');
  });

  it('marks browser-originated entries as runtime "client"', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    initClientLogger(BOOTSTRAP);
    log.info('from the browser');
    await log.flush();

    for (const entry of relayedEntries(relayEntries)) {
      expect(entry.context.runtime).toBe('client');
    }
  });

  it('honours minLevel on the client before anything reaches the buffer', async () => {
    const { createLogger, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    const quiet = createLogger({ minLevel: 'error' });
    quiet.info('should be filtered');
    quiet.error('should survive');

    initClientLogger(BOOTSTRAP);
    await quiet.flush();

    expect(relayedEntries(relayEntries).map((e) => e.message)).toEqual(['should survive']);
  });

  it('never writes to the terminal from the client path', async () => {
    // The library's core promise is that browser logs reach the terminal via
    // the relay only — a direct stdout write from client code would mean the
    // server/client branch in dispatch() had regressed.
    const { log, initClientLogger } = await loadLoggerInBrowser();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    initClientLogger(BOOTSTRAP);
    log.info('browser log');
    await log.flush();

    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});

describe('client dispatch — nothing happens on the caller stack', () => {
  /**
   * `log.*()` is documented as safe to call from a React render body. That
   * makes the caller's stack a render stack, so the call must not reach the
   * network: the relay Server Action dispatches through Next's router, and
   * touching the router mid-render produces
   *
   *   Cannot update a component (`Router`) while rendering a different
   *   component (`LoggerPlayground`).
   *
   * Both paths below run during render in a real app — the component-body log
   * call, and `initClientLogger()` draining the pre-init buffer from inside
   * `LoggerBootstrapClient`'s body.
   */
  it('does not relay synchronously when a log is emitted after bootstrap', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    initClientLogger(BOOTSTRAP);
    log.info('emitted from a render body');

    expect(relayEntries).not.toHaveBeenCalled();

    await log.flush();
    expect(relayedEntries(relayEntries).map((e) => e.message)).toContain(
      'emitted from a render body',
    );
  });

  it('does not relay synchronously when initClientLogger() drains the pre-init buffer', async () => {
    const { log, initClientLogger, relayEntries } = await loadLoggerInBrowser();

    log.info('buffered before bootstrap');
    initClientLogger(BOOTSTRAP);

    expect(relayEntries).not.toHaveBeenCalled();

    await log.flush();
    expect(relayedEntries(relayEntries).map((e) => e.message)).toContain(
      'buffered before bootstrap',
    );
  });
});

describe('server dispatch — unaffected by the client path', () => {
  beforeEach(() => {
    removeFakeBrowser();
    vi.resetModules();
  });

  it('writes synchronously and never touches the pre-init buffer', async () => {
    const { createLogger } = await import('../logger');
    const { relayEntries } = await import('../../transport/client');

    const seen: LogEntry[] = [];
    const serverLog = createLogger({ transports: [(e) => seen.push(e)] });
    serverLog.info('server side');

    // Written immediately — no bootstrap, no queue, no relay involved.
    expect(seen.map((e) => e.message)).toEqual(['server side']);
    expect(seen[0]?.context.runtime).toBe('server');
    expect(relayEntries).not.toHaveBeenCalled();
  });
});
