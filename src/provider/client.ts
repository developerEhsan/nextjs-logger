/**
 * @file provider/client.ts
 * The library's ONE `'use client'` boundary.
 *
 * Why this file exists (this was a real, shipped bug — read before touching):
 *
 * `LoggerProvider` is an async Server Component and `LoggerBootstrapClient`
 * is a Client Component. When tsup bundled both into a single
 * `dist/provider/index.js`, esbuild dropped the `'use client'` directive
 * that `LoggerBootstrapClient.tsx` carries in source (a directive is only
 * preserved when it's the prologue of the *emitted* file, and a merged
 * bundle has exactly one prologue — which can't be `'use client'` here
 * because the same file also holds an async Server Component).
 *
 * The consequence was total, silent failure of ALL browser-side logging:
 * without the directive Next.js never registered the bootstrap component as
 * a client module, so it rendered server-side only, `initClientLogger()`
 * never ran in the browser, `clientBootstrap` stayed null forever, and
 * every client `log.*()` call was buffered into `preInitBuffer` and never
 * flushed — no queue, no relay, no error, nothing in the terminal. Server
 * and Server Action logging kept working, which is what made it so
 * confusing to diagnose.
 *
 * So: this module is a deliberate, separate emitted entry point whose only
 * job is to own the `'use client'` prologue. Everything the browser needs
 * is re-exported through here.
 *
 * A barrel is sufficient for `'use client'` (unlike `'use server'`, where
 * the action's function body must live in the directive-bearing file):
 * `'use client'` declares a module *boundary*, so whatever this file
 * re-exports is pulled into the client graph along with it. That's why this
 * entry can stay in the main code-split build and keep sharing the
 * `core/logger` chunk — which is essential, because `initClientLogger()`
 * and `dispatch()` MUST mutate and read the same module-level
 * `clientBootstrap`/`preInitBuffer`. If this island were ever built
 * standalone (`--no-splitting`) it would inline its own private copy of
 * `core/logger.ts`, and client logging would break again in a way that
 * looks identical from the outside. See `tsup.config.ts` and
 * `src/__tests__/build-contract.test.ts`.
 */

'use client';

export { LoggerBootstrapClient } from './LoggerBootstrapClient';
export type { LoggerBootstrapClientProps } from './LoggerBootstrapClient';
export { useLogger } from './useLogger';
