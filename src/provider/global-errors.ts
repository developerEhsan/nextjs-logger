/**
 * @file provider/global-errors.ts
 * Capture uncaught browser errors and unhandled promise rejections so they
 * reach the terminal without a single call site having to do anything.
 *
 * ── Why this belongs in the library ──────────────────────────────────────
 * The errors you most need to see are the ones nobody wrote a `log.error`
 * for. A `TypeError` thrown in an event handler, a rejected `fetch` nobody
 * caught — those are exactly the failures that never make it into a
 * terminal-only logger, because the whole premise of the package is that
 * the browser console is not where you're looking.
 *
 * ── Rules this follows ───────────────────────────────────────────────────
 * ① **Additive, never exclusive.** A previously-installed `window.onerror`
 *    is chained, not replaced, and its return value is honoured. Nothing is
 *    `preventDefault()`ed, so the browser console still prints the error and
 *    Sentry (or whatever else is installed) still sees it. A logging library
 *    that swallows errors on the way past would be a catastrophe.
 * ② **Never recurse.** If relaying a captured error somehow throws, the
 *    resulting error would be captured again, relayed again, and so on. A
 *    reentrancy flag makes the second pass a no-op.
 * ③ **Idempotent.** Bootstrap runs during render and React may render it
 *    more than once (StrictMode, remounts); installing twice would double
 *    every error line.
 * ④ **Removable.** `install…` returns its own uninstaller, so a test or an
 *    HMR cycle can tear the listeners down instead of accumulating them.
 */

import type { Logger } from '../core/types';

/** Set while a captured error is being logged — see rule ② above. */
let capturing = false;

let uninstall: (() => void) | null = null;

export interface GlobalErrorHandlerOptions {
  /** Logger used to emit. A `child('window')` namespace is applied. */
  logger: Logger;
  /** Log verbose install diagnostics to the DevTools console. */
  debug?: boolean;
}

/**
 * Install `error` and `unhandledrejection` listeners on `window`.
 * Returns an uninstall function. Safe to call repeatedly — subsequent calls
 * return the existing uninstaller without installing again.
 */
export function installGlobalErrorHandlers(
  options: GlobalErrorHandlerOptions,
): () => void {
  if (typeof window === 'undefined') return () => {};
  if (uninstall) return uninstall;

  const log = options.logger.child('window');

  const guard = (fn: () => void): void => {
    if (capturing) return;
    capturing = true;
    try {
      fn();
    } catch {
      // A logger that throws while reporting an uncaught error would turn
      // one broken interaction into a broken page.
    } finally {
      capturing = false;
    }
  };

  /**
   * `window.addEventListener('error')` fires for two unrelated things: an
   * uncaught exception (an `ErrorEvent`, which carries `error`), and a
   * failed resource load — an `<img>`, `<script>` or stylesheet that 404'd
   * (a plain `Event` whose target is the element, with no `error` at all).
   * They need different treatment; conflating them produces a stream of
   * `"Error: undefined"` lines for every broken image on the page.
   */
  const onError = (event: Event): void => {
    guard(() => {
      const errorEvent = event as ErrorEvent;

      if (errorEvent.error !== undefined && errorEvent.error !== null) {
        log.error(errorEvent.error, {
          source: 'window.onerror',
          // The event's own coordinates are kept alongside the error's
          // stack: for a cross-origin script the browser censors the stack
          // to "Script error." and these are all that survive.
          location: formatLocation(errorEvent),
        });
        return;
      }

      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (target && target !== (window as unknown as EventTarget) && target.tagName) {
        log.warn('Resource failed to load', {
          source: 'window.onerror',
          tag: target.tagName.toLowerCase(),
          url: target.src ?? target.href,
        });
        return;
      }

      log.error(errorEvent.message || 'Uncaught error', {
        source: 'window.onerror',
        location: formatLocation(errorEvent),
      });
    });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    guard(() => {
      // `reason` is whatever was passed to `reject()` — very often not an
      // Error at all (`reject('nope')`, `reject(response)`). `log.error`
      // handles both: an Error gets full serialisation, anything else is
      // stringified. That polymorphism is exactly why the log methods take
      // `unknown`.
      log.error(event.reason ?? 'Unhandled promise rejection', {
        source: 'unhandledrejection',
      });
    });
  };

  // `true` (capture phase) is required for resource-load errors: those do
  // not bubble, so a listener on `window` in the bubble phase never sees
  // them.
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);

  if (options.debug && process.env.NODE_ENV === 'development') {
    console.debug('[logger] Global error handlers installed.');
  }

  uninstall = () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    uninstall = null;
  };

  return uninstall;
}

function formatLocation(event: ErrorEvent): string | undefined {
  if (!event.filename) return undefined;
  return `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`;
}

/** Tear down the listeners, if installed. Exported for tests and HMR. */
export function uninstallGlobalErrorHandlers(): void {
  uninstall?.();
}
