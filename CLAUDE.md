# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@developerehsan/nextjs-logger` — a `console.log`-shaped logging library for Next.js 16 that writes exclusively to the server terminal (never the browser console), with automatic server/client environment detection and a TanStack Pacer-backed client queue so browser-originated logs never flood the relay endpoint. This is a publishable npm package (built with tsup), not an application.

## Commands

- Build: `npm run build` (tsup, multi-entry ESM + `.d.ts`, externalizes `next`/`react`/`react-dom`)
- Typecheck: `npm run typecheck` (`tsc --noEmit`)
- Test: `npm run test` (vitest run). Single test file: `npx vitest run src/security/__tests__/security.test.ts`; single test name: `npx vitest run -t "test name"`
- Package manager: this repo uses `bun.lock` — prefer `bun install`/`bun run <script>` if bun is available, otherwise the npm scripts above work identically

## Architecture

### Environment dispatch (the core trick)

Every `log.*()` call goes through a single `dispatch()` in `src/core/logger.ts`. It checks `isServer()` (from `src/core/config.ts`) and branches:

- **Server** (Node.js or Edge Runtime): writes synchronously and directly via `writeToTerminal` (`src/transport/server.ts`) — no queue, no async.
- **Client** (browser): enqueues into a `ClientQueue` (`src/queue/client-queue.ts`), which is Pacer-throttled/debounced/rate-limited per log level, then relayed to the server and written through the exact same terminal writer. Both transport paths converge on one formatter so output is identical regardless of origin.

This dispatch is invisible to callers — `log.info(...)` is safe to call from Server Components, Client Components, Server Actions, and Route Handlers with zero hooks.

### Zero-hook client bootstrap

The hard requirement this library satisfies is "call `log.info()` anywhere, including at module scope, with no `useEffect` and no readiness check" in consuming apps. This works via:

1. `<LoggerProvider>` (`src/provider/LoggerProvider.tsx`) is an **async Server Component** mounted once near the root layout. It mints a short-lived signed session token server-side (HMAC over a timestamp, never the raw secret) and passes it as a prop to `LoggerBootstrapClient`.
2. `LoggerBootstrapClient` (`src/provider/LoggerBootstrapClient.tsx`) calls `initClientLogger()` directly in the component body during render — not inside `useEffect` — because React guarantees a component body runs before its children mount.
3. Until `initClientLogger()` runs, any `log.*()` call on the client is buffered in a module-level `preInitBuffer` (cap 200) inside `src/core/logger.ts` and flushed automatically the instant bootstrap completes. This is what makes a log call racing ahead of bootstrap safe rather than lost.

Two transports are attempted, in order (see `src/transport/client.ts` and `src/relay/`): a **Server Action** (`relayLogEntries`, rides Next's RSC Flight protocol, no extra HTTP round trip) preferred, falling back to the **signed API route** (`src/relay/route-handler.ts`) if the Server Action isn't wired or fails 3 times. `navigator.sendBeacon` is used as a synchronous fallback on `visibilitychange`/`beforeunload` so queued logs survive tab close.

### Security model (`src/security/index.ts`)

All relay payload verification lives here and runs on the Web Crypto API (`crypto.subtle`) so the identical code path works on both Node.js and Edge Runtime.

**This is a bearer session-token scheme, not a per-payload HMAC.** The client never holds `relaySecret`, so it cannot sign `entries` itself. `mintSessionToken(secret, issuedAt)` produces `sign(secret, "session."+issuedAt)` once per page load; the client resends that same `token` + `issuedAt` on every relay call (fetch, retries, *and* the `sendBeacon` unload path all reuse it — nothing beacon-specific about the token). This authenticates "a session the server minted made this request," not "these exact bytes are untampered" — don't reintroduce a design that requires the client to sign `entries`, it's cryptographically impossible without shipping the secret to the browser (this was a real, previously-shipped bug: the old scheme required a client-computed HMAC over `ts+entries` that the client could never produce, so the API-route and beacon paths silently rejected every request).

Verification order in `verifyPayload()` matters — cheapest/most-DoS-relevant checks run first:

1. Origin/Referer allowlist check (skipped if both headers are absent — a non-browser client can trivially omit them, so treat this as defense-in-depth, not the primary gate)
2. Raw byte size cap (256 KB) — checked before JSON parsing
3. Structural field presence check (`entries`, `token`, `issuedAt`)
4. Entry count cap (100/request)
5. Session freshness (`SESSION_MAX_AGE_MS`, 6h, plus a small future-clock-skew tolerance)
6. Session token verification (constant-time comparison via `timingSafeEqual`)
7. Per-entry structural validation (level enum, message/context types)

The relay endpoint deliberately returns generic 4xx codes on every rejection path (never revealing *which* check failed) so a probing attacker gets no signal to iterate toward a forged payload — preserve this behavior when touching `route-handler.ts` or `server-action.ts`. Set `LOGGER_DEBUG_RELAY=1` to log the real rejection reason server-side only (never in the response) when debugging a broken setup.

`route-handler.ts` and `server-action.ts` both read config via `getConfig()` from `src/core/logger.ts` (not their own `buildDefaultConfig()` call) — this is deliberate: tsup's code-splitting puts `core/logger.ts` in a chunk shared across all four entry points, so `configureLogger()` called from the app's main entry actually reaches the relay handlers too. Building an independent config in those files was a real bug (silent `prettyPrint`/`redactKeys` divergence between direct and relayed logs) — don't reintroduce it.

Message sanitisation (`sanitiseMessage`/`sanitiseData`) strips ANSI escapes, `\r`, and null bytes, and JSON round-trips structured `data` to reject non-serialisable/prototype-polluting payloads. `redact()` (also in `security/index.ts`) then replaces any key matching `LoggerConfig.redactKeys` (case-insensitive strings or `RegExp`, defaults cover `password`/`token`/`secret`/etc.) with `'[REDACTED]'` — applied both client-side before entries leave the browser and server-side at write time in `transport/server.ts`. All of this happens before anything reaches `process.stdout.write`; any change to what gets written to the terminal must go through both.

### Per-instance config isolation (`src/core/logger.ts`)

`createLogger(overrides)` builds a fully independent `LoggerConfig` (via `buildDefaultConfig`) and closes over it directly — it does NOT share the mutable `globalConfig` that `configureLogger()` updates. The default `log` singleton is the one exception: it closes over `() => globalConfig` (a getter, not a snapshot), so `configureLogger()` calls made anywhere, anytime, are visible to `log` immediately. Every `dispatch()`/`makeLogMethod()` call takes `cfg`/`getCfg` explicitly now — never reintroduce a shared module-level `config` variable that `dispatch()` reads implicitly, that was the root cause of a real bug where `createLogger()` overrides were silently discarded (the override was live only from inside `createLogger()`'s own synchronous call, and gone by the time the returned logger's methods were actually invoked).

Sampling (`cfg.sampleRate`) is checked in `dispatch()` before `buildEntry()` runs, independent of and prior to `minLevel` filtering being the *other* gate — a level can be filtered by either, and both apply per-instance.

### Pacer policies (`src/queue/client-queue.ts`)

Each log level gets an independent TanStack Pacer strategy (`throttle`/`debounce`/`rateLimit`) plus a fixed-capacity ring buffer with LRU eviction, so a component re-rendering rapidly can't flood the relay. Defaults live in `src/core/config.ts` (`buildDefaultConfig`) and are overridable per-app via `configureLogger({ pacerPolicies: {...} })`. When changing a policy's default, update both the config default and the README table (§7) describing rationale per level.

Note: the client-side `ClientQueue` is a single per-page singleton (`getOrCreateClientQueue`) regardless of how many logger instances exist — TanStack Pacer needs one coordinated queue. Only the first client-side dispatch (from `log` or any `createLogger()` instance) determines the queue's `pacerPolicies`/`maxQueueSize`; `minLevel`/`sampleRate`/`redactKeys`/`namespace` always apply per-instance since they're evaluated in `dispatch()` before anything reaches the queue.

### Module layout

- `src/core/` — logger dispatch, config defaults, shared types (`Logger`, `LogEntry`, `LoggerConfig`, `PacerPolicy`, etc. — the canonical type source)
- `src/transport/` — `server.ts` (direct stdout writer) and `client.ts` (fetch/Server Action/beacon senders)
- `src/relay/` — the two server-side entry points apps re-export directly (`route-handler.ts` for `app/api/__log/route.ts`, `server-action.ts` for the preferred transport)
- `src/provider/` — the async Server Component, its client bootstrap component, and the optional `useLogger()` hook (memoized `log.child(namespace)`; purely ergonomic, not required)
- `src/queue/` — client-side ring buffer + Pacer wiring
- `src/security/` — all HMAC/origin/sanitisation logic, framework-agnostic
- `src/utils/` — caller-location introspection and `AsyncLocalStorage`-based request ID correlation (skipped gracefully on Edge, which has no `async_hooks`)

### Known build-log noise (non-fatal)

Consuming apps that import anything from the main entry inside an Edge-eligible file (e.g. `proxy.ts` importing `generateRequestId`) will see Turbopack/webpack warn about `process.stdout`/`process.cwd` "not supported in the Edge Runtime" — because tsup's single shared chunk bundles `transport/server.ts`/`utils/caller.ts` alongside everything else, and the bundler's static analysis flags the mere presence of those calls even though `isServer()`/runtime guards mean they never execute on Edge. This is cosmetic (build still succeeds, exit 0) — Proxy defaults to the Node.js runtime in Next.js 16 anyway. Don't try to "fix" it by adding runtime guards around `process.stdout` references; the guards already exist at the call-site level, this is a bundler false positive on unreachable code.

### Package export surface

Four public entry points built independently by tsup (see `exports` in `package.json`): the core logger (`.`), the provider (`./provider`, kept separate so non-React/server-only consumers don't pull in JSX), and the two relay handlers (`./relay/route-handler`, `./relay/server-action`). When adding a new public export, wire it through both `src/index.ts` (or the relevant subpath entry file) *and* the `tsup` command in `package.json`'s `build` script *and* the `exports` map — all three must stay in sync or consumers will get a resolution error post-build.
