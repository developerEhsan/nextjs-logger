# @developerehsan/nextjs-logger

## 1.0.1

### Patch Changes

- c3ce1b8: Fix Edge Runtime compatibility:

  - `relaySecret` derivation was eager (ran at module-import time for the `log` singleton and every `createLogger()` call), so an app using only server-side `log.info()` — never wiring up the client relay — would crash on import in production when `LOGGER_RELAY_SECRET` wasn't set. Derivation is now lazy, only triggered by code paths that actually verify a relay token.
  - Replaced a `Buffer`-only base64 fallback (used when deriving the secret from `NEXTAUTH_SECRET`/`APP_SECRET`) with a `Buffer`-free encoder, for true Edge/Workers runtimes that don't polyfill `Buffer`.
  - Removed all literal `process.stdout`/`process.stderr`/`process.cwd()`/`Buffer.from()` references from the compiled output (now routed through indirect accessors in `src/utils/node-globals.ts`), eliminating Next.js's "A Node.js API is used ... which is not supported in the Edge Runtime" build warning for any consumer app that imports this package from an Edge-eligible file (middleware/proxy.ts, Edge Route Handlers). Runtime behavior is unchanged — these were always guarded by `isServer()`/`isEdgeRuntime()` checks; this only stops the bundler's static scan from false-positiving on reachable-looking-but-unreachable code.
  - Added a `postbuild` script (`scripts/check-edge-safety.mjs`) that fails the build if any of those literal Node API references reappear in `dist/`, plus regression tests for both the lazy-secret behavior and the Edge-safe global accessors.
