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
 * This component renders nothing (`null`) — it exists purely to cross the
 * server/client boundary and run one synchronous setup call.
 */

'use client';

import * as React from 'react';
import { initClientLogger } from '../core/logger';
import type { LogEntry } from '../core/types';

export interface LoggerBootstrapClientProps {
  relayUrl: string;
  signedToken: string;
  issuedAt: string;
  debug: boolean;
  serverAction: (entries: LogEntry[]) => Promise<void>;
}

/** Guards against double-initialization across StrictMode / remounts. */
let bootstrapped = false;

export function LoggerBootstrapClient({
  relayUrl,
  signedToken,
  issuedAt,
  debug,
  serverAction,
}: LoggerBootstrapClientProps): null {
  // Intentionally NOT a useEffect. Running this during render guarantees
  // the logger is ready before any sibling/child component's render
  // phase or first event handler fires. Synchronous, idempotent, side-
  // effect-free from React's perspective (no DOM writes).
  if (!bootstrapped) {
    bootstrapped = true;
    initClientLogger({ relayUrl, signedToken, issuedAt, serverAction, debug });
  }

  return null;
}
