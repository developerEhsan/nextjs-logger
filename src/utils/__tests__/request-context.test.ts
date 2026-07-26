/**
 * @file utils/__tests__/request-context.test.ts
 * Regression test for a bug where `runWithRequestContext`/`getCurrentRequestId`
 * silently never worked on any runtime: the original implementation called
 * `require('node:async_hooks')`, but this package builds as ESM-only, and
 * ESM modules have no `require` global — the ReferenceError was swallowed
 * by a catch block, so request-ID correlation was a no-op from day one.
 */

import { describe, it, expect } from "vitest";
import {
  runWithRequestContext,
  getCurrentRequestId,
  generateRequestId,
} from "../request-context";

// AsyncLocalStorage is initialized asynchronously at module load (see
// request-context.ts for why) — give it a tick to settle before asserting.
async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runWithRequestContext / getCurrentRequestId", () => {
  it("propagates the request ID to code running inside the callback", async () => {
    await nextTick();
    const requestId = generateRequestId();

    await runWithRequestContext(requestId, async () => {
      expect(getCurrentRequestId()).toBe(requestId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getCurrentRequestId()).toBe(requestId);
    });
  });

  it("returns undefined outside of any request context", () => {
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it("isolates concurrent request contexts from each other", async () => {
    await nextTick();
    const idA = generateRequestId();
    const idB = generateRequestId();

    const [seenA, seenB] = await Promise.all([
      runWithRequestContext(idA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentRequestId();
      }),
      runWithRequestContext(idB, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getCurrentRequestId();
      }),
    ]);

    expect(seenA).toBe(idA);
    expect(seenB).toBe(idB);
  });
});

describe("generateRequestId", () => {
  it("produces unique, URL-safe IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
