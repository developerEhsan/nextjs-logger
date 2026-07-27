/**
 * @file utils/request-context.ts
 * Per-request context propagation using Node's AsyncLocalStorage.
 *
 * Why: Next.js Server Components / Route Handlers / Server Actions all run
 * within the same Node.js process concurrently for different requests.
 * Without AsyncLocalStorage, there is no reliable way to tag a log line
 * with "which incoming request produced this" — you'd have to thread a
 * requestId through every function call manually, which defeats the goal
 * of "use log.info() anywhere, zero plumbing."
 *
 * AsyncLocalStorage is available in the Node.js runtime. It is NOT available
 * in the Edge Runtime — we detect that and gracefully degrade (requestId
 * will simply be omitted on Edge, which only affects log readability, not
 * correctness or security).
 */

import { getActiveSpanContext, type TraceContext } from './trace-context';

export interface RequestContextData {
  requestId: string;
  /**
   * W3C trace context for this request, if the inbound `traceparent` header
   * carried one. Stored alongside `requestId` rather than in a second
   * AsyncLocalStorage instance because they have identical lifetimes and
   * one store means one `getStore()` on the log path.
   */
  trace?: TraceContext;
}

// AsyncLocalStorage import must be conditional — it does not exist in
// the Edge Runtime and importing 'node:async_hooks' there throws.
//
// This package builds as ESM only (see package.json), so a CJS-style
// `require('node:async_hooks')` is NOT available here on any runtime —
// ESM modules have no `require` global. Using dynamic `import()` instead
// works in both ESM and CJS consumers and still resolves to nothing (via
// the .catch below) on Edge. Because `getAls()` below is synchronous (so
// `runWithRequestContext`/`getCurrentRequestId` stay synchronous, matching
// every other call in this library), we kick this off once, eagerly, at
// module load and cache the resolved instance — by the time any real
// request handler calls into this module, the import has settled in
// virtually every real case. If it hasn't (e.g. the very first call ever
// made, before any microtask has run), this degrades exactly like Edge
// does: no request context, correctness unaffected, only log readability.
let alsInstance: import('node:async_hooks').AsyncLocalStorage<RequestContextData> | null = null;

function initAls(): void {
  // Browser check FIRST, and it cannot be folded into the `process` check
  // below: bundlers shim a `process` object into the client bundle, so
  // `typeof process === 'undefined'` is FALSE in the browser and
  // `NEXT_RUNTIME` is undefined there — meaning both of the checks below
  // pass and the browser would go on to attempt the dynamic import. Because
  // the specifier is deliberately non-static (see the comment below), the
  // browser treats "node:async_hooks" as a URL and fires a real network
  // request for it, producing a CORS error in DevTools on every single page
  // load of every consuming app. The `.catch()` keeps it non-fatal, which is
  // exactly why it went unnoticed.
  //
  // This was masked until the `'use client'` build fix landed: before that,
  // the chunk holding this module never reached the client bundle at all
  // (which was itself the bug that broke all browser logging). Fixing that
  // exposed this. AsyncLocalStorage is only ever needed server-side, so the
  // browser should never even try.
  if (typeof window !== 'undefined') return;

  if (typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge') {
    return;
  }
  // The specifier is built at runtime (not a string literal) so bundlers
  // (esbuild/tsup, Turbopack/webpack in consuming apps) can't statically
  // resolve or rewrite it — both are known to either strip the `node:`
  // prefix or attempt eager module resolution for a literal
  // `import('node:async_hooks')`, which breaks this exact conditional-
  // import-on-Node-only pattern. A dynamic specifier defers resolution to
  // the real runtime import(), which only ever executes in this branch
  // (Node.js), never on Edge.
  const specifier = ['node', 'async_hooks'].join(':');
  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)
    .then((mod: { AsyncLocalStorage: new () => import('node:async_hooks').AsyncLocalStorage<RequestContextData> }) => {
      alsInstance = new mod.AsyncLocalStorage();
    })
    .catch(() => {
      // Runtime doesn't support async_hooks — degrade gracefully.
    });
}

initAls();

function getAls() {
  return alsInstance;
}

/**
 * Run `fn` within a request context tagged with `requestId`.
 * Intended to be called once per request, e.g. from a top-level
 * middleware/proxy or root layout's instrumentation hook.
 */
export function runWithRequestContext<T>(
  requestId: string,
  fn: () => T,
  trace?: TraceContext,
): T {
  const store = getAls();
  if (!store) return fn(); // Edge Runtime / unsupported — degrade gracefully
  return store.run({ requestId, trace }, fn);
}

/** Read the current request's ID, if any context is active. */
export function getCurrentRequestId(): string | undefined {
  const store = getAls();
  return store?.getStore()?.requestId;
}

/**
 * Trace/span IDs for the current request, for stamping onto a log entry.
 *
 * An active OpenTelemetry span wins over the stored `traceparent`: the
 * header describes the *inbound* request, while the active span reflects
 * where execution actually is, including spans the app created itself. When
 * only the header is available the header's span ID is used, which is the
 * parent span — correct, and the best available answer without an SDK.
 */
export function getCurrentTraceIds(): { traceId: string; spanId?: string } | undefined {
  const fromSpan = getActiveSpanContext();
  if (fromSpan) return fromSpan;

  const trace = getAls()?.getStore()?.trace;
  if (!trace) return undefined;
  return { traceId: trace.traceId, spanId: trace.spanId };
}

/** Generate a short, URL-safe request ID without external dependencies. */
export function generateRequestId(): string {
  // 12 chars of base36 timestamp + 8 chars of random — short but unique
  // enough for correlating logs within a single request lifecycle.
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${time}-${rand}`;
}
