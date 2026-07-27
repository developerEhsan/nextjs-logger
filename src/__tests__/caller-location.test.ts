/**
 * @file utils/__tests__/caller.test.ts
 *
 * The regression this pins: `getCallerLocation()` matched a hardcoded list of
 * path fragments to decide which stack frames belonged to the library, and
 * that list never matched `utils/caller.ts` itself. So the first frame it
 * examined — its own `new Error()` — always won, and every server log line
 * reported a constant:
 *
 *   caller: "src/utils/caller.ts:37"
 *
 * Inert, but still paying for a stack capture on every call. The fragments
 * were also wrong for installed consumers, where library code lives in a
 * bundled `dist/chunk-*.js` and matched none of them.
 *
 * A test that only asserts "returns a string" would have passed throughout.
 * These assert it points somewhere *other than the library*.
 */

import { describe, it, expect } from 'vitest';
import { getCallerLocation } from '../utils/caller';

describe('getCallerLocation', () => {
  it('never reports a frame inside the logger itself', () => {
    const location = getCallerLocation();

    expect(location).toBeDefined();
    expect(location).not.toContain('utils/caller');
    expect(location).not.toContain('core/logger');
  });

  it('reports the file and line of the actual caller', () => {
    const location = getCallerLocation();

    expect(location).toContain('caller-location.test.ts');
    // "path/file.ts:LINE" — column stripped for compact terminal output.
    expect(location).toMatch(/caller-location\.test\.ts:\d+$/);
  });

  it('reports the nearest non-library frame through a wrapper', () => {
    function appLevelWrapper(): string | undefined {
      return getCallerLocation();
    }

    // The wrapper is application code, so it is the correct answer here —
    // the filter skips library frames, not every frame.
    expect(appLevelWrapper()).toMatch(/caller-location\.test\.ts:\d+$/);
  });

  it('returns undefined in a browser-like environment', () => {
    // Client stacks are minified and must never reach the terminal anyway.
    Object.assign(globalThis, { window: {} });
    try {
      expect(getCallerLocation()).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('restores Error.stackTraceLimit after capturing', () => {
    const before = Error.stackTraceLimit;
    getCallerLocation();
    expect(Error.stackTraceLimit).toBe(before);
  });
});
