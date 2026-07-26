/**
 * @file examples/instrumentation.ts
 * Next.js 16 supports an `instrumentation.ts` file at the project root for
 * hooking into server lifecycle events. We use `onRequestError` here to
 * automatically log any uncaught error that escapes a Server Component,
 * Route Handler, or Server Action — without the developer needing to
 * wrap every handler in a try/catch.
 *
 * Copy this file to your project root as `instrumentation.ts`.
 */

import { log } from '@developerehsan/nextjs-logger';

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
