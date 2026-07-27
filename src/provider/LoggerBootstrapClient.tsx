/**
 * @file provider/nextjs-loggerBootstrapClient.tsx
 * The thin Client Component half of the bootstrap.
 *
 * Initialisation happens DURING RENDER (module-scope guarded), not inside
 * a useEffect. This is intentional and safe because:
 *
 *   • `initClientLogger` is a pure synchronous assignment (it just stores
 *     references) — it has no side effects that violate React's render
 *     purity rules (no DOM mutation, no subscriptions opened here).
 *   • We guard with a module-level boolean so repeated renders (StrictMode
 *     double-invocation, re-renders from parent state changes) don't
 *     re-run the bootstrap or open duplicate event listeners.
 *   • The actual event listener registration (`visibilitychange`,
 *     `beforeunload`) happens lazily inside `ClientQueue`'s constructor,
 *     which itself is only constructed once via the singleton guard in
 *     `getOrCreateClientQueue`. So even though we call init from render,
 *     the *queue itself* — including all its addEventListener calls — is
 *     still only ever created exactly once per page session.
 *
 * There IS one `useEffect` here, added deliberately: it signals the transport
 * that React has committed, which the Server Action fallback must wait for.
 * It is not part of initialisation — bootstrap still happens during render, so
 * a log call racing ahead of mount is still captured. See the effect's own
 * comment, and the "Why the Server Action is NOT the primary transport"
 * section in `transport/client.ts`.
 *
 * This component renders nothing (`null`) — it exists purely to cross the
 * server/client boundary and run one synchronous setup call.
 */

'use client';

import * as React from 'react';
import { initClientLogger, log } from '../core/logger';
import { markReactMounted, type ServerActionRelay } from '../transport/client';
import { installGlobalErrorHandlers } from './global-errors';

export interface LoggerBootstrapClientProps {
  relayUrl: string;
  signedToken: string;
  issuedAt: string;
  debug: boolean;
  serverAction: ServerActionRelay;
  /**
   * Install `window.onerror` / `unhandledrejection` capture. Resolved from
   * `LoggerConfig.captureGlobalErrors` on the server and passed down, so
   * one `configureLogger()` call controls both halves.
   */
  captureGlobalErrors?: boolean;
}

/** Guards against double-initialization across StrictMode / remounts. */
let bootstrapped = false;

export function LoggerBootstrapClient({
  relayUrl,
  signedToken,
  issuedAt,
  debug,
  serverAction,
  captureGlobalErrors = true,
}: LoggerBootstrapClientProps): null {
  // Intentionally NOT a useEffect. Running this during render guarantees
  // the logger is ready before any sibling/child component's render
  // phase or first event handler fires. Synchronous, idempotent, side-
  // effect-free from React's perspective (no DOM writes).
  if (!bootstrapped) {
    bootstrapped = true;
    initClientLogger({ relayUrl, signedToken, issuedAt, serverAction, debug });
  }

  // The one internal effect in the library. It exists solely to tell the
  // transport that React has committed, which is a precondition for the
  // Server Action fallback: dispatching an action goes through Next's router,
  // and doing that before the Router mounts throws
  //   "Can't perform a React state update on a component that hasn't mounted yet".
  //
  // This does not weaken the zero-hook guarantee — that guarantee is about
  // what *consumers* write, and they still write none. The default fetch
  // transport doesn't need this gate at all; only the fallback does.
  React.useEffect(() => {
    markReactMounted();

    // Global error capture is installed here rather than in the render body
    // above, unlike `initClientLogger`. The distinction is real: init is a
    // pure assignment, whereas this calls `addEventListener`, which is a
    // side effect on a shared object and must not happen during render (a
    // discarded concurrent render would leak the listener).
    //
    // Nothing is lost by waiting for commit. An uncaught error thrown
    // *during* the first render is not something a `window` listener would
    // have caught anyway — that path belongs to an error boundary.
    if (!captureGlobalErrors) return;
    return installGlobalErrorHandlers({ logger: log, debug });
  }, [captureGlobalErrors, debug]);

  return null;
}
