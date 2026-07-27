/**
 * @file tsup.config.ts
 *
 * This build is NOT arbitrary. Two React Server Component directives
 * (`'use client'`, `'use server'`) have to survive into specific emitted
 * files, and one module's state (`core/logger.ts`) has to stay a single
 * shared instance across every entry point. Those three constraints pull
 * against each other, and getting any of them wrong has already shipped a
 * silent, hard-to-diagnose bug. Read this before changing anything here;
 * `src/__tests__/build-contract.test.ts` enforces all of it.
 *
 * ── Constraint 1: directives only survive as an emitted file's prologue ───
 * esbuild keeps a `'use client'` / `'use server'` directive only when it is
 * the prologue of the *output* file. When several source modules are merged
 * into one output, inner directives are silently dropped. So any module that
 * needs a directive must be its own entry, and must not be merged with a
 * module that needs a *different* (or no) directive.
 *
 * ── Constraint 2: `'use server'` needs the function BODY in the file ─────
 * Next's Server Actions compiler instruments the action function in the
 * module where the directive applies, and registers it in
 * `server-reference-manifest.json`. A directive on a file that merely
 * re-exports the action does NOT work — the real function stays
 * uninstrumented and calling it from the browser silently no-ops. Hence
 * `relay/server-action` is built with `splitting: false`, so
 * `relayLogEntries`'s body is physically in the directive-bearing file.
 *
 * ── Constraint 3: `'use client'` only needs a BOUNDARY, not the body ─────
 * `'use client'` marks a module boundary: whatever the directive-bearing
 * file re-exports is pulled into the client graph with it. So the client
 * island can be a thin barrel, which means it can stay in the main
 * code-split build and keep sharing chunks. That matters — see below.
 *
 * ── Constraint 4: `core/logger.ts` MUST be one instance ──────────────────
 * `core/logger.ts` holds module-level mutable state: `clientBootstrap`,
 * `preInitBuffer`, and `globalConfig`. Everything depends on there being
 * exactly one copy of it at runtime:
 *   • `initClientLogger()` (called from the client island) writes
 *     `clientBootstrap`; `dispatch()` (called via `log` from the main entry)
 *     reads it. Two copies ⇒ the browser buffers every log forever.
 *   • `configureLogger()` (main entry) writes `globalConfig`; `getConfig()`
 *     in both relay handlers reads it. Two copies ⇒ silent prettyPrint /
 *     redactKeys divergence between direct and relayed logs.
 * Code splitting is what normally guarantees this: the shared chunk is
 * imported by every entry. But an island built with `splitting: false`
 * inlines its own private copy instead. That's why `core/logger` is emitted
 * as its own stable entry below, and why the no-splitting island marks it
 * `external` — so it imports the one real instance rather than duplicating
 * it.
 */

/**
 * ── A note on `clean` ────────────────────────────────────────────────────
 * Neither config below sets `clean: true`, deliberately: tsup runs the two
 * configs concurrently, so whichever cleaned would race the other's output.
 * `dist/` is wiped by the `prebuild` script instead.
 *
 * This is not cosmetic. Splitting emits content-hashed chunk filenames, so
 * without a wipe every build leaves the previous build's chunk behind. Two
 * chunks then each contain a copy of `core/logger.ts`, which is precisely
 * the duplicate-module condition Constraint 4 forbids — the build-contract
 * checker correctly fails on it, and a published package would ship the
 * stale chunk as dead weight.
 */

import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'es2022',
  external: ['next', 'react', 'react-dom'],
};

export default defineConfig([
  /**
   * ① Main build — code splitting ON.
   *
   * Emits the shared chunk that carries `core/logger.ts` (and therefore the
   * single copy of `clientBootstrap` / `preInitBuffer` / `globalConfig`).
   *
   * `core/logger` is listed as an entry purely so that a *stable, importable*
   * `dist/core/logger.js` exists for build ② to point at. It comes out as a
   * thin re-export of the shared chunk, so it is the same instance — not a
   * duplicate.
   *
   * `provider/client` is an entry here (rather than in its own build) so it
   * shares that chunk. It carries `'use client'` as its own source prologue,
   * and because it is a barrel that is enough (Constraint 3).
   *
   * `./client` is external for a subtle but critical reason. Without it,
   * esbuild sees that both `provider/index` and `provider/client` need
   * `LoggerBootstrapClient`, hoists it into a shared chunk, and rewrites
   * `provider/index.js` to import it *straight from that chunk* — bypassing
   * the directive-bearing `dist/provider/client.js` entirely, leaving the
   * barrel as dead code nobody imports. The `'use client'` boundary is then
   * never crossed and browser logging silently dies exactly as it did
   * before. Marking it external forces a real `from './client'` import, so
   * the boundary is actually in the graph.
   *
   * `../relay/server-action` is external for the analogous reason on the
   * server side: `LoggerProvider`'s import of `relayLogEntries` must compile
   * to a real cross-file import of build ②'s output, rather than inlining an
   * uninstrumented copy of the action.
   */
  {
    ...shared,
    entry: {
      'index': 'src/index.ts',
      'provider/index': 'src/provider/index.ts',
      'provider/client': 'src/provider/client.ts',
      'instrumentation/index': 'src/instrumentation/index.ts',
      'transports/index': 'src/transports/index.ts',
      'security/rate-limit-redis': 'src/security/rate-limit-redis.ts',
      'relay/route-handler': 'src/relay/route-handler.ts',
      'core/logger': 'src/core/logger.ts',
    },
    splitting: true,
    dts: true,
    external: [
      ...(shared.external as string[]),
      './client',
      '../relay/server-action',
    ],
  },

  /**
   * ② The `'use server'` island — code splitting OFF.
   *
   * `splitting: false` puts `relayLogEntries`'s body in this file so Next can
   * instrument and register it (Constraint 2).
   *
   * `../core/logger` is external so this island imports the ONE shared
   * `globalConfig` from build ①'s `dist/core/logger.js` instead of inlining a
   * second copy (Constraint 4).
   *
   * Note on how the directive gets here: it is carried through from the source
   * prologue of `src/relay/server-action.ts` by esbuild, which preserves an
   * entry point's own leading directive. We deliberately do NOT inject it via
   * `banner` — the client island in build ① cannot use a banner (it shares a
   * config with `provider/index`, which must NOT get a directive), and having
   * one directive banner-injected and the other source-preserved is a
   * confusing split. Instead both rely on the same mechanism and both are
   * hard-gated by `scripts/check-build-contract.mjs`, which runs in
   * `postbuild` and fails the build if either directive goes missing.
   */
  {
    ...shared,
    entry: { 'relay/server-action': 'src/relay/server-action.ts' },
    splitting: false,
    dts: true,
    external: [...(shared.external as string[]), '../core/logger'],
  },
]);
