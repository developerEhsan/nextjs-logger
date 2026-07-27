/**
 * @file utils/__tests__/request-context.test.ts
 * Regression test for a bug where `runWithRequestContext`/`getCurrentRequestId`
 * silently never worked on any runtime: the original implementation called
 * `require('node:async_hooks')`, but this package builds as ESM-only, and
 * ESM modules have no `require` global — the ReferenceError was swallowed
 * by a catch block, so request-ID correlation was a no-op from day one.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("browser safety — must never attempt to load node:async_hooks", () => {
  const realProcess = globalThis.process;

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    // Restore the real process global — one test below swaps in a bundler-style
    // shim, and leaving that in place would poison anything running after it.
    globalThis.process = realProcess;
    vi.resetModules();
  });

  it("does not call import() at all when a window global is present", async () => {
    // Regression test for a console error visible in EVERY consuming app.
    //
    // The eager AsyncLocalStorage bootstrap was guarded only by
    // `typeof process === 'undefined'` and a NEXT_RUNTIME==='edge' check.
    // Bundlers shim `process` into the client bundle, so in a browser BOTH
    // guards pass. Combined with the deliberately non-static specifier
    // (built at runtime so bundlers can't rewrite it), the browser resolved
    // "node:async_hooks" as a URL and issued a real network request for it,
    // producing a CORS error on every page load. `.catch()` made it
    // non-fatal, which is exactly why it went unnoticed for so long.
    //
    // It stayed hidden until the 'use client' build fix, because before that
    // the chunk containing this module never reached the browser at all.
    Object.assign(globalThis, {
      window: {},
      // A process shim shaped like the one bundlers inject — deliberately
      // NOT edge, so the old guards would both have let this through.
      process: { env: {} },
    });
    vi.resetModules();

    const mod = await import("../request-context");

    // The bootstrap runs at module load. Give any stray promise a tick.
    await new Promise((r) => setTimeout(r, 10));

    // Degrades exactly like the Edge Runtime: no context, no crash.
    expect(mod.getCurrentRequestId()).toBeUndefined();
    expect(mod.runWithRequestContext("req_1", () => "ok")).toBe("ok");
    // ...and critically, no requestId is fabricated client-side.
    expect(mod.runWithRequestContext("req_1", () => mod.getCurrentRequestId())).toBeUndefined();
  });

  it("still works normally on the server (no window global)", async () => {
    vi.resetModules();
    const mod = await import("../request-context");
    await new Promise((r) => setTimeout(r, 10));

    expect(mod.runWithRequestContext("req_server", () => mod.getCurrentRequestId())).toBe(
      "req_server",
    );
  });
});
