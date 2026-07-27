/**
 * @file provider/nextjs-loggerProvider.tsx
 * Zero-config bootstrap for the client-side logger.
 *
 * THE KEY DX GUARANTEE: once <LoggerProvider /> is mounted ONE TIME near
 * your root layout, every other component in the app can call
 * `log.info(...)` synchronously, with no hooks, no useEffect, no "is the
 * logger ready yet" checks. Here's how that's achieved:
 *
 *  1. LoggerProvider is an async Server Component. It runs on the server,
 *     mints a fresh signed token (HMAC over a server timestamp + secret),
 *     and passes that token as a prop into a small Client Component.
 *
 *  2. The Client Component (`LoggerBootstrap`) calls `initClientLogger()`
 *     during module evaluation / render — NOT inside a useEffect — by
 *     calling it directly in the component body on first render. React
 *     guarantees component bodies run before children mount, so by the
 *     time ANY descendant component's render (or its own module-level
 *     `log.info()` call during an event handler) executes, the bootstrap
 *     has already happened.
 *
 *  3. Because `initClientLogger` is idempotent-safe and the dispatch layer
 *     buffers pre-init calls automatically (see core/nextjs-logger.ts), even a
 *     log call that races ahead of bootstrap is never lost — it's queued
 *     and flushed the instant bootstrap completes. This is what makes
 *     "call log.info() anywhere, including module scope" actually safe.
 *
 * Why not just call initClientLogger from a useEffect ourselves and call
 * it done? Because a literal requirement was "I don't want to use
 * useEffect in MY component." Calling our own internal setup is fine —
 * what we eliminate is the developer's burden, not all internal React
 * lifecycle usage within the library itself. We avoid even our OWN
 * useEffect in the hot path by initialising synchronously in the render
 * body, only using a microtask click-through for cleanup wiring.
 */

import * as React from "react";
import { mintSessionToken as signSessionToken } from "../security/index";
import { getConfig } from "../core/logger";
// Imported through the `'use client'` island barrel (NOT directly from
// './LoggerBootstrapClient'). That indirection is what carries the client
// boundary into the build output — see the header of ./client.ts.
import { LoggerBootstrapClient } from "./client";
import { relayLogEntries } from "../relay/server-action";

export interface LoggerProviderProps {
  children: React.ReactNode;
  /** Override the relay API route path. Defaults to '/api/log-relay'. */
  relayUrl?: string;
  /** Enable verbose DevTools console diagnostics in development. */
  debug?: boolean;
  /**
   * Capture uncaught browser errors and unhandled promise rejections and
   * relay them to the terminal. Defaults to
   * `LoggerConfig.captureGlobalErrors` (itself `true`), so
   * `configureLogger({ captureGlobalErrors: false })` on the server turns
   * it off everywhere; this prop overrides it for one mount.
   */
  captureGlobalErrors?: boolean;
}

/**
 * Mint a short-lived session token for this page load: an HMAC over the
 * issue timestamp. The client resends this same token (+ issuedAt) on
 * every relay call — fetch, retries, and the sendBeacon unload path alike
 * — and the relay endpoint re-derives and compares it (see
 * `security/index.ts` for why this is a bearer-token model rather than a
 * per-payload signature).
 */
async function mintSessionToken(): Promise<{
  token: string;
  issuedAt: string;
}> {
  const config = getConfig();
  const issuedAt = new Date().toISOString();
  const token = await signSessionToken(config.relaySecret, issuedAt);
  return { token, issuedAt };
}

/**
 * Guard against a footgun that cost this library its entire fetch transport.
 *
 * The default relay URL used to be `/api/__log`, documented as
 * `app/api/__log/route.ts`. In the App Router, a folder prefixed with `_` is a
 * **private folder** — Next opts it and every subfolder out of routing. So the
 * route handler was never mounted, `POST /api/__log` returned the 404 page,
 * and the fetch transport silently never worked. That is why the router-
 * coupled Server Action ended up carrying all client logging, which is what
 * produced the React state-update errors it was blamed for.
 *
 * Nothing about that failure was loud: no build error, no warning, just a
 * transport that quietly never succeeded. So check it explicitly.
 */
function warnIfUnroutableRelayUrl(relayUrl: string): void {
  if (process.env.NODE_ENV !== "development") return;

  const offending = relayUrl
    .split("/")
    .filter(Boolean)
    .find((segment) => segment.startsWith("_"));
  if (!offending) return;

  console.warn(
    `[logger] relayUrl "${relayUrl}" contains the segment "${offending}", which ` +
      "starts with an underscore. Next.js treats underscore-prefixed folders as " +
      "private and excludes them from routing, so a route handler there is " +
      "unreachable and the relay will fall back to the slower Server Action " +
      "transport. Use a segment without a leading underscore (the default is " +
      "'/api/log-relay'), or name the folder with the %5F escape.",
  );
}

/**
 * Server Component — place once near the root layout:
 * @example
 *   // app/layout.tsx
 *   import { LoggerProvider } from '@developerehsan/nextjs-logger/provider';
 *
 *   export default function RootLayout({ children }) {
 *     return (
 *       <html>
 *         <body>
 *           <LoggerProvider>{children}</nextjs-loggerProvider>
 *         </body>
 *       </html>
 *     );
 *   }
 */
export async function LoggerProvider({
  children,
  relayUrl = "/api/log-relay",
  debug = false,
  captureGlobalErrors,
}: LoggerProviderProps) {
  warnIfUnroutableRelayUrl(relayUrl);
  const { token, issuedAt } = await mintSessionToken();

  return (
    <>
      <LoggerBootstrapClient
        relayUrl={relayUrl}
        signedToken={token}
        issuedAt={issuedAt}
        debug={debug}
        serverAction={relayLogEntries}
        captureGlobalErrors={captureGlobalErrors ?? getConfig().captureGlobalErrors}
      />
      {children}
    </>
  );
}
