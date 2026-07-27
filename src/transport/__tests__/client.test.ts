/**
 * @file transport/__tests__/client.test.ts
 *
 * Pins the transport *ordering*, which is a correctness constraint rather than
 * a performance preference.
 *
 * The Server Action used to be the primary transport. Calling one from client
 * code is not a plain function call — React's Flight client routes it through
 * Next's `callServer`, which dispatches into the App Router's action queue,
 * which is a React state update on the Router. A logger fires at arbitrary
 * times, so that produced a console error on ordinary page loads:
 *
 *   • from a render body                 → "Cannot update a component
 *                                           (`Router`) while rendering a
 *                                           different component (`X`)"
 *   • from a timer, pre-hydration        → "Can't perform a React state update
 *                                           on a component that hasn't mounted
 *                                           yet"
 *
 * A plain fetch to a Route Handler has no such coupling, so it must be tried
 * first. These tests fail if that ordering is ever flipped back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  relayEntries,
  markReactMounted,
  _resetTransportState,
  type ClientTransportOptions,
} from '../client';
import type { LogEntry } from '../../core/types';

function makeEntry(message: string): LogEntry {
  return {
    level: 'info',
    message,
    context: { runtime: 'client', timestamp: new Date().toISOString(), sequence: 0 },
  };
}

function baseOpts(over: Partial<ClientTransportOptions> = {}): ClientTransportOptions {
  return {
    relayUrl: '/api/log-relay',
    signedToken: 'session-token',
    issuedAt: new Date().toISOString(),
    ...over,
  };
}

function mockFetch(...responses: Partial<Response>[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({ ok: r.status === undefined || r.status < 400, ...r });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  _resetTransportState();
  // The mount gate is resolved once per module lifetime; resolving it up front
  // keeps the Server Action tests from paying the 5 s timeout.
  markReactMounted();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('relay transport ordering', () => {
  it('uses fetch, not the Server Action, when the route handler responds', async () => {
    const fetchMock = mockFetch({ status: 200 });
    const serverAction = vi.fn().mockResolvedValue(undefined);

    await relayEntries([makeEntry('hello')], baseOpts({ serverAction }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // THE regression guard: the router-coupled path must stay untouched while
    // the React-free one is working.
    expect(serverAction).not.toHaveBeenCalled();
  });

  it('falls back to the Server Action when the route handler is missing (404)', async () => {
    mockFetch({ status: 404 });
    const serverAction = vi.fn().mockResolvedValue(undefined);

    await relayEntries([makeEntry('hello')], baseOpts({ serverAction }));

    expect(serverAction).toHaveBeenCalledTimes(1);
  });

  it('stops re-probing a missing route handler on subsequent batches', async () => {
    const fetchMock = mockFetch({ status: 404 });
    const serverAction = vi.fn().mockResolvedValue(undefined);
    const opts = baseOpts({ serverAction });

    await relayEntries([makeEntry('one')], opts);
    await relayEntries([makeEntry('two')], opts);
    await relayEntries([makeEntry('three')], opts);

    // A 404 is a setup problem, not a transient one — probe once, then commit
    // to the fallback rather than burning a doomed round-trip per batch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(serverAction).toHaveBeenCalledTimes(3);
  });

  it('resolves without throwing when a batch is permanently rejected', async () => {
    mockFetch({ status: 403 });
    const serverAction = vi.fn().mockResolvedValue(undefined);

    // A disallowed origin will not start working on retry, so the batch is
    // dropped rather than handed back to the queue — and the Server Action is
    // NOT tried, since it would be rejected for the same reason.
    await expect(
      relayEntries([makeEntry('hello')], baseOpts({ serverAction })),
    ).resolves.toBeUndefined();
    expect(serverAction).not.toHaveBeenCalled();
  });

  it('treats 429 as transient so a rate-limited batch is retried, not dropped', async () => {
    mockFetch({ status: 429 }, { status: 429 }, { status: 429 });

    await expect(
      relayEntries([makeEntry('hello')], baseOpts()),
    ).rejects.toThrow(/all transports exhausted/);
  });
});

describe('session renewal', () => {
  it('adopts a renewed session handed back by the relay', async () => {
    const renewed = { token: 'fresh-token', issuedAt: '2026-07-27T02:00:00.000Z' };
    mockFetch({ status: 200, json: async () => ({ ok: true, session: renewed }) } as never);
    const onSessionRenewed = vi.fn();

    await relayEntries([makeEntry('hello')], baseOpts({ onSessionRenewed }));

    expect(onSessionRenewed).toHaveBeenCalledWith(renewed);
  });

  it('does not treat a missing or unparseable body as a failure', async () => {
    mockFetch({
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as never);
    const onSessionRenewed = vi.fn();

    // The batch landed; only the optional renewal is absent.
    await expect(
      relayEntries([makeEntry('hello')], baseOpts({ onSessionRenewed })),
    ).resolves.toBeUndefined();
    expect(onSessionRenewed).not.toHaveBeenCalled();
  });

  /**
   * The 6h-idle-tab recovery path. A token that aged out cannot be refreshed
   * by retrying the fetch — it only gets older. The Server Action needs no
   * token of ours, so it both delivers the batch and mints a replacement,
   * putting the tab back on the cheap transport instead of dropping every log
   * from then on.
   */
  it('recovers an expired session via the Server Action and re-establishes a token', async () => {
    mockFetch({ status: 401 });
    const renewed = { token: 'reissued', issuedAt: '2026-07-27T02:00:00.000Z' };
    const serverAction = vi.fn().mockResolvedValue({ ok: true, session: renewed });
    const onSessionRenewed = vi.fn();

    await relayEntries(
      [makeEntry('hello')],
      baseOpts({ serverAction, onSessionRenewed }),
    );

    expect(serverAction).toHaveBeenCalledTimes(1);
    expect(onSessionRenewed).toHaveBeenCalledWith(renewed);
  });

  it('rejects when every transport fails transiently, so the queue can retry', async () => {
    mockFetch({ status: 500 }, { status: 500 }, { status: 500 });

    await expect(
      relayEntries([makeEntry('hello')], baseOpts()),
    ).rejects.toThrow(/all transports exhausted/);
  });

  it('drops the batch without throwing when the route is missing and there is no fallback', async () => {
    mockFetch({ status: 404 });

    // No Server Action configured and no route handler mounted: the condition
    // is permanent, so making the queue retry three more times is pure waste.
    await expect(
      relayEntries([makeEntry('hello')], baseOpts()),
    ).resolves.toBeUndefined();
  });
});
