/**
 * @file instrumentation/index.ts
 * Ready-made handlers for Next.js's `instrumentation.ts` hooks, plus
 * process-level capture for the failures that happen outside any request.
 *
 * Usage — `instrumentation.ts` at the project root:
 *
 *   export { onRequestError } from '@developerehsan/nextjs-logger/instrumentation';
 *
 *   export async function register() {
 *     const { registerProcessErrorHandlers } = await import(
 *       '@developerehsan/nextjs-logger/instrumentation'
 *     );
 *     registerProcessErrorHandlers();
 *   }
 *
 * That is the whole integration. `onRequestError` is a Next.js 15+ hook
 * that fires for every server-side error the framework catches — thrown
 * Server Components, failed Server Actions, Route Handlers that reject,
 * and errors surfaced during streaming, which are otherwise the hardest
 * class to see because the response has already begun.
 *
 * ── Why the export is a plain function, not a factory call ───────────────
 * `instrumentation.ts` is one of the files Next.js is fussiest about: it is
 * loaded in a special context, before most of the app exists, on both the
 * Node.js and Edge runtimes. A bare `export { onRequestError }` re-export
 * is the shape the framework documents and the shape least likely to break.
 * `createRequestErrorLogger()` exists for anyone who needs to customise the
 * level or namespace, and for composing with another reporter.
 */

import { log as defaultLog } from '../core/logger';
import type { Logger, LogLevel } from '../core/types';

/**
 * The shape Next.js passes to `onRequestError`. Declared structurally
 * rather than imported from `next/server` so this module carries no
 * framework import at all — `instrumentation.ts` is loaded early enough
 * that a stray import is a real risk, and these fields have been stable
 * since the hook was introduced.
 */
export interface RequestErrorRequest {
  path?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined> | Headers;
}

export interface RequestErrorContext {
  /** 'render' | 'route' | 'action' | 'middleware' — where it was thrown. */
  routerKind?: string;
  /** The route path pattern, e.g. `/orders/[id]`. */
  routePath?: string;
  /** 'render' | 'route-handler' | 'server-action' | … */
  routeType?: string;
  /** Present when the error surfaced during a revalidation/render retry. */
  renderSource?: string;
  revalidateReason?: string;
}

export interface RequestErrorLoggerOptions {
  /** Logger to emit through. Defaults to the package singleton. */
  logger?: Logger;
  /** Namespace applied to emitted entries. Defaults to `'request'`. */
  namespace?: string;
  /** Level for captured errors. Defaults to `'error'`. */
  level?: LogLevel;
}

export type RequestErrorHandler = (
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
) => void;

/**
 * Build an `onRequestError` handler.
 *
 * The handler never throws and never returns a promise: Next.js awaits this
 * hook on the error path of a request that is already failing, so anything
 * that could reject or hang here makes a bad situation worse.
 */
export function createRequestErrorLogger(
  options: RequestErrorLoggerOptions = {},
): RequestErrorHandler {
  const { namespace = 'request', level = 'error' } = options;

  return function onRequestError(error, request, context): void {
    try {
      const logger = (options.logger ?? defaultLog).child(namespace);
      logger[level](error, {
        method: request?.method,
        path: request?.path,
        routerKind: context?.routerKind,
        routePath: context?.routePath,
        routeType: context?.routeType,
        // Only present on revalidation paths; omitted rather than logged as
        // `undefined` so the common case stays a tight one-line object.
        ...(context?.renderSource ? { renderSource: context.renderSource } : {}),
        ...(context?.revalidateReason
          ? { revalidateReason: context.revalidateReason }
          : {}),
      });
    } catch {
      // Never let error reporting be the thing that fails the request.
    }
  };
}

/**
 * Default `onRequestError` export — re-export this straight from your
 * `instrumentation.ts`.
 */
export const onRequestError: RequestErrorHandler = createRequestErrorLogger();

// ─── Process-level capture ───────────────────────────────────────────────

let processHandlersRegistered = false;

export interface ProcessErrorHandlerOptions {
  logger?: Logger;
  namespace?: string;
  /**
   * Re-throw after logging an `uncaughtException`, restoring Node's default
   * crash-on-uncaught behaviour. Defaults to `false`.
   *
   * The default is a genuine trade-off, not an oversight. Registering an
   * `uncaughtException` listener *suppresses* the default crash, which
   * leaves the process running in a state the language considers undefined.
   * That is usually wrong for a production service — but Next.js's own dev
   * server, and most process managers, already handle their own lifecycle,
   * and a logger that killed the dev server on a stray async throw would be
   * unusable. Set this to `true` in production if you want crash-only
   * semantics, and let your supervisor restart the process.
   */
  exitOnUncaught?: boolean;
}

/**
 * Log `uncaughtException` and `unhandledRejection` — the server-side
 * counterparts of the browser handlers in `provider/global-errors.ts`.
 *
 * Call from `register()` in `instrumentation.ts`. Idempotent, and a no-op
 * on the Edge Runtime, which has no `process.on`.
 */
export function registerProcessErrorHandlers(
  options: ProcessErrorHandlerOptions = {},
): void {
  if (processHandlersRegistered) return;

  const proc = (globalThis as { process?: NodeJS.Process }).process;
  if (!proc || typeof proc.on !== 'function') return; // Edge Runtime

  processHandlersRegistered = true;

  const logger = (options.logger ?? defaultLog).child(options.namespace ?? 'process');

  proc.on('uncaughtException', (error: Error) => {
    try {
      logger.fatal(error, { source: 'uncaughtException' });
    } catch {
      // nothing safe left to do
    }
    if (options.exitOnUncaught) {
      // Re-throwing here would just be caught again. Exit non-zero so a
      // supervisor restarts, matching Node's own default behaviour.
      proc.exit(1);
    }
  });

  proc.on('unhandledRejection', (reason: unknown) => {
    try {
      logger.error(reason ?? 'Unhandled promise rejection', {
        source: 'unhandledRejection',
      });
    } catch {
      // nothing safe left to do
    }
  });
}

/** Exported for tests. */
export function _resetProcessErrorHandlers(): void {
  processHandlersRegistered = false;
}
