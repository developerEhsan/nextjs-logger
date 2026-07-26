/**
 * @file instrumentation.ts
 * Runs once when the Next.js server starts (`register()`), and again
 * whenever a request escapes without being handled (`onRequestError()`).
 *
 * We use this file for two features that make the most sense configured
 * once, app-wide, rather than per log call:
 *
 *  - `configureLogger()` — extra redaction patterns, a demo pluggable
 *    transport, and per-level sampling.
 *  - `onRequestError` — automatically log any uncaught error from a Server
 *    Component, Route Handler, Server Action, or Proxy, without wrapping
 *    every handler in its own try/catch. Trigger this in the demo via the
 *    "Throw in a Route Handler" button on the home page.
 */

import { configureLogger, log, type LogTransport } from '@developerehsan/nextjs-logger';

/**
 * A minimal example of a pluggable transport (the `transports` feature).
 * In a real app this might forward to Sentry/Datadog/an error-budget
 * counter. Transports run isolated in their own try/catch — one throwing
 * transport can never suppress the terminal output or crash the app.
 */
const alertOnFatal: LogTransport = (entry) => {
  if (entry.level === 'fatal') {
    // Real usage: page on-call, increment a counter, etc. Left as a no-op
    // here so the demo terminal output stays legible.
  }
};

export function register() {
  configureLogger({
    // Extends (does not replace) the built-in defaults — password/token/
    // secret/etc. stay redacted even though we only add one pattern here.
    redactKeys: ['creditCardNumber'],
    // This demo page re-renders a lot; sample debug noise down so the
    // terminal stays readable while still showing occasional entries.
    sampleRate: { debug: 0.5 },
    transports: [alertOnFatal],
  });

  log.info('Server started', { runtime: process.env.NEXT_RUNTIME ?? 'nodejs' });
}

export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  log.error('Unhandled request error', {
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
    error: err instanceof Error
      ? { message: err.message, stack: err.stack }
      : String(err),
  });
}
