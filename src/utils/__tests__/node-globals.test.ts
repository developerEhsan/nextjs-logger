/**
 * @file utils/__tests__/node-globals.test.ts
 * Regression test for two related Edge Runtime bugs:
 *
 *  1. `deriveRelaySecret()`/`buildDefaultConfig()` used to derive the relay
 *     secret *eagerly* at module-import time, so any app that only used
 *     server-side `log.info()` (never wiring up the client relay) would
 *     crash on import in production if `LOGGER_RELAY_SECRET` wasn't set.
 *  2. Direct literal references to `process.stdout`/`process.stderr`/
 *     `process.cwd()`/`Buffer.from()` get flagged by Next.js's build-time
 *     Edge Runtime scanner in any consumer app that imports this package
 *     from an Edge-eligible file (middleware, an Edge Route Handler),
 *     even though `isServer()`/`isEdgeRuntime()` guards make sure that
 *     code never actually executes there.
 *
 * `src/utils/node-globals.ts` fixes #2 by accessing these APIs through a
 * computed property instead of a literal one. These tests simulate the
 * Edge Runtime (no `process`/`Buffer` globals at all) and assert the
 * accessors degrade to `undefined` instead of throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getNodeProcess, getNodeStream, getNodeCwd, getNodeBuffer } from '../node-globals';

describe('node-globals on a Node.js-like runtime', () => {
  it('getNodeProcess returns the real process object', () => {
    expect(getNodeProcess()).toBe(globalThis.process);
  });

  it('getNodeStream returns process.stdout / process.stderr', () => {
    expect(getNodeStream('stdout')).toBe(process.stdout);
    expect(getNodeStream('stderr')).toBe(process.stderr);
  });

  it('getNodeCwd returns process.cwd()', () => {
    expect(getNodeCwd()).toBe(process.cwd());
  });

  it('getNodeBuffer returns the global Buffer constructor', () => {
    expect(getNodeBuffer()).toBe(Buffer);
  });
});

describe('node-globals on a simulated Edge Runtime (no process/Buffer globals)', () => {
  const realProcess = globalThis.process;
  const realBuffer = globalThis.Buffer;

  beforeEach(() => {
    // @ts-expect-error - simulating an environment with no Node globals
    delete globalThis.process;
    // @ts-expect-error - simulating an environment with no Node globals
    delete globalThis.Buffer;
  });

  afterEach(() => {
    globalThis.process = realProcess;
    globalThis.Buffer = realBuffer;
  });

  it('getNodeProcess degrades to undefined instead of throwing', () => {
    expect(() => getNodeProcess()).not.toThrow();
    expect(getNodeProcess()).toBeUndefined();
  });

  it('getNodeStream degrades to undefined instead of throwing', () => {
    expect(() => getNodeStream('stdout')).not.toThrow();
    expect(getNodeStream('stdout')).toBeUndefined();
    expect(getNodeStream('stderr')).toBeUndefined();
  });

  it('getNodeCwd degrades to undefined instead of throwing', () => {
    expect(() => getNodeCwd()).not.toThrow();
    expect(getNodeCwd()).toBeUndefined();
  });

  it('getNodeBuffer degrades to undefined instead of throwing', () => {
    expect(() => getNodeBuffer()).not.toThrow();
    expect(getNodeBuffer()).toBeUndefined();
  });
});
