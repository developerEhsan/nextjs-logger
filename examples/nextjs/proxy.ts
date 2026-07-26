/**
 * @file examples/proxy.ts
 * Example `proxy.ts` (Next.js 16 renamed `middleware.ts` → `proxy.ts`).
 *
 * This is OPTIONAL — the logger works perfectly without it. Adding it
 * gives you a `requestId` field stamped on every log line produced while
 * handling a given incoming request, which is invaluable for correlating
 * scattered log lines (e.g. "which request caused this error 200ms ago?")
 * in a busy terminal.
 *
 * Copy this file to your project root as `proxy.ts`.
 */

import { NextResponse } from 'next/server';
import { generateRequestId } from '@developerehsan/nextjs-logger';

export function proxy() {
  const requestId = generateRequestId();

  const response = NextResponse.next();
  // Propagate the ID via a response header so Server Components/Route
  // Handlers downstream in the same request can pick it up if needed,
  // and so it's visible in browser DevTools for client/server correlation.
  response.headers.set('x-request-id', requestId);

  return response;
}

export const config = {
  matcher: '/:path*',
};
