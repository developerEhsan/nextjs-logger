# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@developerehsan/nextjs-logger` — a `console.log`-shaped logging library for Next.js 16 that writes exclusively to the server terminal (never the browser console), with automatic server/client environment detection and a TanStack Pacer-backed client queue so browser-originated logs never flood the relay endpoint. This is a publishable npm package (built with tsup), not an application.

## Commands

- Build: `npm run build` (tsup via `tsup.config.ts`, multi-entry ESM + `.d.ts`, externalizes `next`/`react`/`react-dom`). `postbuild` runs two hard gates: `scripts/check-edge-safety.mjs` and `scripts/check-build-contract.mjs` — the latter fails the build if an RSC directive or the shared-module invariant breaks (see "RSC build contract" below)
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

1. `<LoggerProvider>` (`src/provider/LoggerProvider.tsx`) is an **async Server Component** mounted once near the root layout. It mints a short-lived signed session token server-side (HMAC over a timestamp, never the raw secret) and passes it as a prop to `LoggerBootstrapClient`. It imports that component through `src/provider/client.ts` — the library's single `'use client'` boundary — never directly; see "RSC build contract" below for why that indirection is load-bearing.
2. `LoggerBootstrapClient` (`src/provider/LoggerBootstrapClient.tsx`) calls `initClientLogger()` directly in the component body during render — not inside `useEffect` — because React guarantees a component body runs before its children mount.
3. Until `initClientLogger()` runs, any `log.*()` call on the client is buffered in a module-level `preInitBuffer` (cap 200) inside `src/core/logger.ts` and flushed automatically the instant bootstrap completes. This is what makes a log call racing ahead of bootstrap safe rather than lost.

Two transports are attempted, in order (see `src/transport/client.ts` and `src/relay/`): the **signed API route** (`src/relay/route-handler.ts`, a plain `fetch` to `/api/log-relay`) first, falling back to the **Server Action** (`relayLogEntries`) only if the route handler 404s or every fetch attempt fails. `navigator.sendBeacon` is used as a synchronous fallback on `visibilitychange`/`beforeunload` so queued logs survive tab close.

**The Server Action must never be promoted back to primary.** It reads like a plain async call, but importing a `'use server'` function into client code gives you a *reference*: calling it hands off to React's Flight client → Next's `callServer` → the App Router's action queue, which is a React state update on the Router, unconditionally, on every call. A logger fires at arbitrary moments, so there is no safe time to do that — from a render body it throws `Cannot update a component (Router) while rendering a different component (X)`, and from a timer before the router commits it throws `Can't perform a React state update on a component that hasn't mounted yet`. Both were observed in the example app. Beyond the errors, routing log traffic through the action queue serialises it against genuine user actions and keeps flipping router pending state. A plain `fetch` has none of this coupling. The fallback additionally awaits `markReactMounted()` (signalled by the one internal `useEffect` in `LoggerBootstrapClient`) so even it cannot produce the unmounted-update error. Guarded by `src/transport/__tests__/client.test.ts`.

**The relay URL must not contain an underscore-prefixed segment.** The default was `/api/log-relay` only after a long-lived bug: it used to be `/api/__log`, documented as `app/api/__log/route.ts`. In the App Router an `_`-prefixed folder is a [private folder](https://nextjs.org/docs/app/getting-started/project-structure#private-folders) — Next opts it and all subfolders out of routing. The route handler was therefore never mounted, `POST /api/__log` returned the 404 *page*, and the fetch transport silently never worked in any app that followed the README. That is *why* the Server Action ended up carrying all client logging and getting blamed for the React errors it caused. Nothing about the failure was loud — no build error, no warning. `warnIfUnroutableRelayUrl()` in `LoggerProvider` now warns in development if a custom `relayUrl` reintroduces it.

### Error serialisation (`src/core/errors.ts`)

`log.error(err)` used to print `{}`. Every interesting field on an `Error`
(`message`, `name`, `stack`) is non-enumerable or on the prototype, so
`JSON.stringify(err)` returns an empty object — and that was the single most
common call the library received. `serializeError()` now handles the cause
chain (depth-capped), `AggregateError.errors`, own enumerable extras (`code`,
`statusCode`, Next's `digest`), non-`Error` throws, throwing getters, and
cycles. `isErrorLike()` deliberately does not rely on `instanceof`: an error
that arrived over the relay is a plain object from another realm.

`dispatch()` normalises four call shapes into the entry's first-class `error`
field — `log.error(err)`, `log.error(msg, err)`, `log.error(msg, {error: err})`
(hoisted), and errors nested anywhere inside `data` (`normalizeErrorsDeep`,
which returns the *same reference* when there is nothing to rewrite, so the
error-free path allocates nothing). Both filter gates (`minLevel`, sampling)
run before normalisation, so a filtered level never pays for it.

`LogEntry.error.stack` is an **array of frames, not a string**, for two
reasons: the formatter prints one frame per line with a prefix *we* control
(a raw multi-line string would be newline-escaped by `sanitiseMessage`, which
is correct — a relayed stack is attacker-controlled text and a real newline in
it would forge a log line), and source-map resolution operates per frame. All
of `safeError()` in `transport/server.ts` is the same hardening applied to
`message`/`context`, extended over `name`/`message`/every frame/`properties`
— `properties` also goes through `redact`, on both the client (before it
leaves the browser, `transport/client.ts`) and the server, because error
subclasses routinely carry the request that produced them. Regression
coverage: `src/core/__tests__/errors.test.ts`, which asserts against captured
stdout and includes a forged-stack-frame injection case.

`LogMethod` takes `unknown`, not `string`, specifically because
`catch (err)` is typed `unknown` — requiring a cast there would be a tax on
the exact call this most needs to get right.

### Source maps (`src/utils/source-map.ts`)

Resolves a bundled `file:line:col` back to the original source, for two
surfaces: relayed browser stack frames (minified chunk offsets otherwise) and
the `caller` field (which the "Known limitation" in `utils/caller.ts`
documents degrading to a Turbopack chunk path). Gated by
`LoggerConfig.sourceMaps` (`'dev'` | `'always'` | `'off'`, default `'dev'`)
through the single `sourceMapsEnabled()` predicate in `core/config.ts`, so
the caller path and the formatting path cannot disagree.

Source Map v3 base64-VLQ decoding is implemented here rather than pulled in
as a dependency — this package ships one runtime dependency and a WASM-backed
trace-mapping library is a bad trade for a best-effort dev-time nicety. Maps
are cached per generated file, **including negative results**, so a file with
no map is not re-probed on every log line.

Two constraints worth not breaking:

- **The fs access is deliberately convoluted.** The write path is
  synchronous, so map reads must be. `require()` is banned (ESM, and
  `check-edge-safety.mjs` fails the build on the literal). So it uses
  `process.getBuiltinModule('node:fs')` (Node ≥ 22.3, sync, invisible to
  bundlers) and falls back to a background dynamic `import()` whose specifier
  is assembled with `['node','fs'].join(':')`. The join is load-bearing:
  esbuild constant-folds `'node:' + 'fs'` straight back into a literal, which
  makes the specifier resolvable and puts Next's Edge bundler right back to
  flagging a Node built-in in a shared chunk. `check-edge-safety.mjs` now
  gates on both `from "node:` and `import("node:` for this reason.
- **URL → filesystem path is an attack surface.** Frame text arriving over
  the relay is attacker-influenced, so `toDiskPath()` only resolves
  `/_next/`-prefixed paths from an `http(s)` URL, after `new URL()`
  normalisation, rejecting anything containing `..`. Do not widen this to
  "any URL path".

### Global error capture

Client: `src/provider/global-errors.ts`, installed from
`LoggerBootstrapClient`'s `useEffect` (not the render body, unlike
`initClientLogger` — `addEventListener` is a real side effect on a shared
object and a discarded concurrent render would leak the listener). It is
additive, never `preventDefault()`s, guards against recursion via a
reentrancy flag, is idempotent, and returns its own uninstaller.
It distinguishes a failed resource load (a 404'd `<img>` — a plain `Event`
with no `error`) from a thrown exception; conflating them produces a stream
of `"Error: undefined"` lines. The `error` listener is registered in the
**capture** phase because resource errors do not bubble.

Server: `src/instrumentation/index.ts` exports `onRequestError` (a plain
re-export shape, because `instrumentation.ts` is loaded early and in a
special context — it carries no `next/*` import at all, the hook's argument
types are declared structurally) plus `registerProcessErrorHandlers()`.
The latter defaults to **not** exiting on `uncaughtException`, which is a
real trade-off, not an oversight: registering the listener already suppresses
Node's default crash, but a logger that killed the dev server on a stray
async throw would be unusable. `exitOnUncaught: true` restores crash-only
semantics.

### Timing (`src/core/timing.ts`)

`log.time`/`timeEnd` key timers by label in module state, which is a race on
a server handling concurrent requests — two requests using one label corrupt
each other. They exist for console parity; `log.timer(label)` returns a
handle holding its own start time and is the correct server form. The label
map is bounded so a `time()` without a matching `timeEnd()` leaks boundedly.
Durations go into `data.durationMs` as well as the message, because a
duration that exists only inside a message string is not queryable.

`withLogging()` must stay transparent: it re-throws the original error
unwrapped, keeps a sync function sync (returning a promise would silently
break Route Handler signatures and every sync caller), forwards `this`, and
preserves `fn.name` (Next uses the exported binding for Server Action
registration). Arguments and results are opt-in because positional arguments
cannot be reached by `redactKeys`, which matches object keys. It resolves its
logger *per call*, not at wrap time, since `withLogging` is typically
evaluated at module scope — before `configureLogger()` has run. It cannot
import `core/logger` (that module imports this one); `_setDefaultLogger` is
injected at the bottom of `core/logger.ts` instead.

### Security model (`src/security/index.ts`)

All relay payload verification lives here and runs on the Web Crypto API (`crypto.subtle`) so the identical code path works on both Node.js and Edge Runtime.

**This is a bearer session-token scheme, not a per-payload HMAC.** The client never holds `relaySecret`, so it cannot sign `entries` itself. `mintSessionToken(secret, issuedAt)` produces `sign(secret, "session."+issuedAt)` once per page load; the client resends that same `token` + `issuedAt` on every relay call (fetch, retries, *and* the `sendBeacon` unload path all reuse it — nothing beacon-specific about the token). This authenticates "a session the server minted made this request," not "these exact bytes are untampered" — don't reintroduce a design that requires the client to sign `entries`, it's cryptographically impossible without shipping the secret to the browser (this was a real, previously-shipped bug: the old scheme required a client-computed HMAC over `ts+entries` that the client could never produce, so the API-route and beacon paths silently rejected every request).

**The session token is not a secret.** It is minted server-side and embedded in the page HTML, so anyone who can load the page can read it and reuse it for the whole 6h window. That is inherent — the browser must authenticate without holding the signing secret. It means the token bounds *who* can write (someone who reached your page) but not *how much*, which is why the rate limit below is load-bearing rather than a nicety.

Order of checks — cheapest/most-DoS-relevant first:

0. **Rate limit** (`src/security/rate-limit.ts`), in `route-handler.ts` before any parsing. Fixed window, default 120 req/10 s per `x-forwarded-for` key, configurable via `LoggerConfig.relayRateLimit`. Do not mistake the client-side Pacer for this control: Pacer throttles *our own queue*, i.e. the one caller guaranteed not to abuse the endpoint. Before this existed the cap was 100 entries per request and unlimited requests. In-memory, so per-instance on serverless — put an edge rate limit in front for a fleet-wide guarantee. The key table is bounded and cleared wholesale so `X-Forwarded-For` rotation can't turn the limiter itself into the memory-exhaustion vector.
1. Origin/Referer allowlist check (skipped if both headers are absent — a non-browser client can trivially omit them, so treat this as defense-in-depth, not the primary gate). Matching goes through `isOriginAllowed()`, which supports a `scheme://host:*` any-port form. Development uses it for loopback; the previous hardcoded `:3000`/`:3001` list meant a dev server on any other port got a silent 403 (Next moves to the next free port when 3000 is taken, and browsers *do* send `Origin` on same-origin POSTs). The wildcard is port-only on an explicitly named host, so it can never widen to `localhost.evil.com`.
2. Raw byte size cap (256 KB) — checked before JSON parsing
3. Structural field presence check (`entries`, `token`, `issuedAt`)
4. Entry count cap (100/request)
5. Session freshness (`SESSION_MAX_AGE_MS`, 6h, plus a small future-clock-skew tolerance)
6. Session token verification (constant-time comparison via `timingSafeEqual`)
7. Per-entry structural validation (level enum, message/context types)

**Sessions roll over; they do not expire out from under a tab.** A token was minted once at `LoggerProvider` render and never replaced, so a tab open past 6h started failing verification and silently dropped every browser log. Now `shouldRenewSession()` triggers past the halfway mark and the route handler returns a fresh `session` in its 200 body, which `ClientQueue` swaps in. This grants nothing new — you must present a valid token to be handed the next one, so it is safe without exposing a public mint endpoint. A tab that missed the window entirely gets a 401, which the transport treats as "try the Server Action": that path needs no token of ours and returns a freshly minted one, so the tab heals back onto the cheap fetch transport instead of paying router dispatch forever.

The relay endpoint deliberately returns generic 4xx codes on every rejection path (never revealing *which* check failed) so a probing attacker gets no signal to iterate toward a forged payload — preserve this behavior when touching `route-handler.ts` or `server-action.ts`. Set `LOGGER_DEBUG_RELAY=1` to log the real rejection reason server-side only (never in the response) when debugging a broken setup.

`route-handler.ts` and `server-action.ts` both read config via `getConfig()` from `src/core/logger.ts` (not their own `buildDefaultConfig()` call) — this is deliberate: `core/logger.ts` must resolve to a single shared instance at runtime so `configureLogger()` called from the app's main entry actually reaches the relay handlers too. Building an independent config in those files was a real bug (silent `prettyPrint`/`redactKeys` divergence between direct and relayed logs) — don't reintroduce it. How the single instance is guaranteed is a build concern; see "RSC build contract" below (the `server-action` island marks `../core/logger` external precisely for this reason).

**Log-injection sanitisation covers two surfaces, and both were once wrong.** `sanitiseMessage()` strips terminal escape sequences, strips remaining control bytes, and **escapes newlines to a literal `\n` rather than deleting them**. Three things here are deliberate and were previously broken:

- *Newlines.* The threat model always listed "newline injection" as blocked; the implementation only stripped `\r`. A relayed `log.info("ok\n01:02:03 [FATAL] …")` printed a second, fully attacker-controlled line indistinguishable from a real entry. Escaping rather than deleting keeps the content auditable while making a forged line prefix impossible. Genuinely multi-line content belongs in `data`, where JSON encoding escapes it anyway.
- *Escape sequences.* The old pattern matched only CSI (`ESC [ … letter`). OSC (`ESC ] 0 ; text BEL`, rewrites the terminal title), Fe (`ESC c`, full reset) and nF (charset switches) all went straight through. The regex now matches the families, and a control-character pass catches any lone `ESC`/NUL left over.
- *Context fields.* `verifyPayload` only checks that `context` is an *object*. The pretty formatter interpolated `namespace`/`caller`/`requestId`/`timestamp` verbatim, so `namespace` was a second injection point that bypassed every guard applied to `message`. `transport/server.ts` now routes all of them through `sanitiseField()` (via `safeField()`, which also coerces non-strings, since the wire type is only a claim about JSON that arrived over the network).

`sanitiseData()` JSON round-trips structured `data` **with a reviver that drops `__proto__`/`constructor`/`prototype`** — the plain round-trip its docblock used to rely on does not strip prototype pollution, since `JSON.parse` happily produces an own `__proto__` key. `redact()` then replaces any key matching `LoggerConfig.redactKeys` (case-insensitive strings or `RegExp`, defaults cover `password`/`token`/`secret`/etc.) with `'[REDACTED]'`, building output via `Object.defineProperty` so a `__proto__` key becomes an own data property instead of silently reparenting the accumulator. Redaction is applied both client-side before entries leave the browser and server-side at write time in `transport/server.ts`. All of this happens before anything reaches `process.stdout.write`; any change to what gets written to the terminal must go through both. Regression coverage: `src/security/__tests__/hardening.test.ts`, which asserts against real captured stdout, not just the sanitiser in isolation.

### Transport pipeline (`src/transports/`)

`LogTransport` used to be exactly `(entry) => void`, called synchronously per
entry inside a `try/catch`. That is right for a counter and useless for a
network sink: one HTTP request per log line, no retry, and any `await` inside
became a floating promise nobody could wait on — so a serverless function
could freeze mid-delivery. `LogTransport` is now a union of that function form
(unchanged semantics, still called inline — something is relying on it, and
it *is* the right shape for a cheap sink) and a `Transport` object
`{ name, write(entries, reason), flush?, close?, minLevel?, filter? }`.

`TransportPipeline` owns batching/retry/backpressure. Its rules, in the file
header, are load-bearing: nothing on the caller's stack (`log.info()` is
callable from a Server Component render body); one in-flight batch per
transport (a slow sink applies backpressure only to itself); bounded buffer
with **counted** drops via `getTransportStats()` (this package has shipped
enough silent-loss bugs); a throwing transport contained; timers `unref()`d.
Retry uses full jitter, and **skips the backoff sleep on `reason ===
'shutdown'`** because the platform may suspend the instance mid-wait.

`getPipeline()` keys a `WeakMap` on the `transports` array identity so the
write path — which receives the array from config on every call — gets one
stable pipeline rather than rebuilding it (and discarding every buffer) per
entry. A `Set` of active pipelines holds strong references so a pipeline with
buffered entries is not collected before delivery, and so `flushTransports()`
can reach one whose config array was replaced.

**Throwing from `write()` means "retry me".** Adapters must throw for a
network blip/5xx/408/429 and *return* for any other 4xx — retrying a 401 from
a bad API key forever burns the buffer while the real problem stays invisible,
so `httpTransport` classifies status codes and calls `onPermanentFailure`
instead.

Adapters: `file.ts` (synchronous `appendFileSync` per batch, deliberately —
stream buffers are lost on `process.exit()`, a crash, and a serverless freeze,
i.e. exactly when the last lines matter; size-based rotation only, because
time-based needs a scheduler and a logger should not own a cron), `http.ts`
(+ Datadog/Axiom/Better Stack presets, which are configuration differences,
not architectural ones), `otlp.ts` (built on `httpTransport` via its
`envelope` hook; note `intValue` must be a *string* and timestamps are
nanoseconds built by string concatenation, since `ms * 1e6` exceeds
`MAX_SAFE_INTEGER`), and `bridge.ts` (Pino takes `(payload, message)`, Winston
takes `(message, meta)` — reversed, and getting it wrong does not throw, it
produces `[object Object]` messages forever, hence two explicit factories).

`src/utils/node-fs.ts` centralises bundler-invisible `node:fs` access for both
the file transport and source maps. Read its header before touching it; the
`['node','fs'].join(':')` is not stylistic.

### Trace correlation (`src/utils/trace-context.ts`)

`traceId`/`spanId` on every server entry, from an active OpenTelemetry span
(read off `globalThis[Symbol.for('opentelemetry.js.api.1')]` — the SDK
registers there precisely so instrumentation can find it without linking, so
this package takes no dependency, optional or otherwise) or, failing that, the
inbound `traceparent` stored in the request-context ALS alongside `requestId`.
The span wins because it reflects where execution *is*, not just what came in.
All-zero IDs are rejected: they are invalid per spec, they show up from
misconfigured propagators, and stamping them would correlate everything with
everything. JSON output uses `traceId`/`spanId` — the names Datadog, Grafana
and Honeycomb key their trace-correlation features on.

### Per-namespace levels (`src/core/level-filter.ts`)

`LOG_LEVEL=info:*,debug:checkout,-checkout:polling`, in the `debug` package's
syntax people already know. **Last matching rule wins** — deliberately not
"most specific wins", which has no total order (`a:*:c` vs `a:b:*`) and would
need tie-breaking nobody can predict from reading their own config. An exact
pattern matches its children, or a namespace hierarchy would be pointless.
Resolution is memoised per namespace in a `WeakMap` keyed on the rule array,
so swapping rules invalidates the cache with no explicit bookkeeping.

### Redis relay rate limit (`src/security/rate-limit-redis.ts`)

Closes the "in-memory means per-warm-instance" gap in `rate-limit.ts`. The
window is encoded in the key (`prefix:key:floor(now/windowMs)`), which is what
makes a plain `INCR` a correct fixed-window counter — each window is a
distinct key expiring on its own, with no reset step to race. **`PEXPIRE` must
only run when `INCR` returns 1**: setting it every call continuously extends
the window, so a steadily-loaded client never resets and is banned forever.
It **fails open** — a Redis outage must not silently delete every browser log;
this guards a logging endpoint, not a payment API. The in-memory limiter still
runs first, as a free floor that also absorbs obvious floods without a network
round trip.

### Log data schemas (`src/core/schema.ts`)

Optional per-namespace validation of `data` through the Standard Schema
interface (declared structurally, no dependency — Zod 3.24+/Valibot/ArkType
implement it natively) or a plain predicate. A violation **never suppresses
the entry** — the calls most likely to violate a schema are the ones written
in a hurry during an incident, and the one thing worse than an
inconsistently-shaped log is a missing one. Warnings go to the process console
rather than through `log`, which would re-enter `dispatch` and recurse for a
schema on the same namespace. Async validators are *skipped*: `dispatch` is
synchronous to the terminal write, so the alternatives are a floating promise
or making every log call async.

### Per-instance config isolation (`src/core/logger.ts`)

`createLogger(overrides)` builds a fully independent `LoggerConfig` (via `buildDefaultConfig`) and closes over it directly — it does NOT share the mutable `globalConfig` that `configureLogger()` updates. The default `log` singleton is the one exception: it closes over `() => globalConfig` (a getter, not a snapshot), so `configureLogger()` calls made anywhere, anytime, are visible to `log` immediately. Every `dispatch()`/`makeLogMethod()` call takes `cfg`/`getCfg` explicitly now — never reintroduce a shared module-level `config` variable that `dispatch()` reads implicitly, that was the root cause of a real bug where `createLogger()` overrides were silently discarded (the override was live only from inside `createLogger()`'s own synchronous call, and gone by the time the returned logger's methods were actually invoked).

Sampling (`cfg.sampleRate`) is checked in `dispatch()` before `buildEntry()` runs, independent of and prior to `minLevel` filtering being the *other* gate — a level can be filtered by either, and both apply per-instance.

### Pacer policies (`src/queue/client-queue.ts`)

Each log level gets an independent TanStack Pacer strategy (`throttle`/`debounce`/`rateLimit`) plus a fixed-capacity ring buffer with LRU eviction, so a component re-rendering rapidly can't flood the relay. Defaults live in `src/core/config.ts` (`buildDefaultConfig`) and are overridable per-app via `configureLogger({ pacerPolicies: {...} })`. When changing a policy's default, update both the config default and the README table (§7) describing rationale per level.

**The enqueue path must never do I/O on the caller's stack.** `ClientQueue.enqueue()` appends to the ring buffer and schedules the level's Pacer via `setTimeout(…, 0)` — it must not call the Pacer inline. `throttle`/`rateLimit` fire their leading edge *synchronously*, so an inline call meant `log.info()` reached `relayEntries()` → the relay Server Action before returning. Because `log.*()` is documented as callable from a React render body (the package's headline ergonomic), that put a Next router dispatch inside React's render phase, and every page load threw:

> Cannot update a component (`Router`) while rendering a different component (`LoggerPlayground`).

Two distinct render-phase paths hit this — a `log.*()` call in a component body, and `initClientLogger()` draining `preInitBuffer` from inside `LoggerBootstrapClient`'s body — and deferring inside `enqueue()` closes both at the one shared choke point. It must be a **macrotask, not a microtask**: microtasks queued during a concurrent render flush when React yields between time slices, so they can still land mid-render on a large tree. The deferral is also coalesced per level per tick, which matters for `rateLimit` — it counts *calls*, so a 20-iteration logging loop would otherwise consume the whole error budget in one tick. Guarded by `src/queue/__tests__/client-queue.test.ts` ("never relays on the caller's stack") and `src/core/__tests__/client-dispatch.test.ts` ("nothing happens on the caller stack").

Relatedly, `relayEntries()` **rejects** when every transport fails transiently — that rejection is the signal `ClientQueue.flushOnce()` uses to re-enqueue the batch and schedule a retry. It used to swallow that case and resolve, making the queue's re-enqueue branch unreachable dead code (a batch lost to an offline window or a restarting dev server was dropped despite the retry machinery sitting right there). A permanent 4xx still *resolves* — retrying an expired token or an over-size body never starts working, so that batch is deliberately dropped.

Note: the client-side `ClientQueue` is a single per-page singleton (`getOrCreateClientQueue`) regardless of how many logger instances exist — TanStack Pacer needs one coordinated queue. Only the first client-side dispatch (from `log` or any `createLogger()` instance) determines the queue's `pacerPolicies`/`maxQueueSize`; `minLevel`/`sampleRate`/`redactKeys`/`namespace` always apply per-instance since they're evaluated in `dispatch()` before anything reaches the queue.

### Module layout

- `src/core/` — logger dispatch, config defaults, shared types (`Logger`, `LogEntry`, `LoggerConfig`, `PacerPolicy`, etc. — the canonical type source), plus `errors.ts` (thrown-value serialisation) and `timing.ts` (`time`/`timer`/`withLogging`)
- `src/instrumentation/` — `onRequestError` and process-level error handlers for the app's `instrumentation.ts`
- `src/transport/` — `server.ts` (direct stdout writer) and `client.ts` (fetch/Server Action/beacon senders)
- `src/relay/` — the two server-side entry points apps re-export directly (`route-handler.ts` for `app/api/log-relay/route.ts`, `server-action.ts` for the fallback transport)
- `src/provider/` — the async Server Component, its client bootstrap component, and the optional `useLogger()` hook (memoized `log.child(namespace)`; purely ergonomic, not required)
- `src/queue/` — client-side ring buffer + Pacer wiring
- `src/security/` — all HMAC/origin/sanitisation logic plus `rate-limit.ts` (relay flood cap) and `rate-limit-redis.ts` (the fleet-wide version), framework-agnostic
- `src/transports/` — the pluggable sink system: pipeline plus the shipped file/HTTP/OTLP/Pino/Winston adapters
- `src/utils/` — caller-location introspection, `AsyncLocalStorage`-based request ID correlation (skipped gracefully on Edge, which has no `async_hooks`), W3C trace context, source-map resolution, and the bundler-invisible `node:fs`/global accessors

**`getCallerLocation()` derives its frame filter from `import.meta.url`; never hardcode path fragments again.** The old fixed list (`/logger/`, `/core/logger`, …) never matched `utils/caller.ts` itself, so the first frame examined — its own `new Error()` — always won and *every* server log reported the constant `src/utils/caller.ts:37`. Inert, while still paying a stack capture per call. The fragments were also wrong for installed consumers, whose library code sits in a bundled `dist/chunk-*.js`. Deriving from `import.meta.url` is correct in all three layouts (this repo's `src/`, unbundled `dist/`, single bundled chunk). Frames arrive as `file://` URLs under any ESM loader, so the scheme is stripped before the cwd-relative shortening — otherwise every path printed absolute. Guarded by `src/__tests__/caller-location.test.ts`, which lives *outside* `src/utils/` deliberately: the filter correctly classifies anything under a library subdirectory as library code, so a test placed there gets skipped and can never observe the real behaviour.

Capture is now gated behind `LoggerConfig.captureCaller` (default: dev only) because materialising a stack is among the more expensive things V8 does and this sits on the synchronous path of every server log. The former known limitation — a bundler inlining the library into the application's chunk (Turbopack does) leaves caller and app frames sharing one file, degrading the location to `.next/dev/server/chunks/ssr/…js:563` — is now resolved by source maps when `LoggerConfig.sourceMaps` is enabled (see above); `getCallerLocation({ sourceMaps: true })` maps the frame *before* the `file://` strip and cwd-shortening, since the mapper needs the location exactly as the frame reported it. Without a map (production with `sourceMaps: 'dev'`, or a build that emits none) the chunk path is still what you get. Treat `caller` as best-effort context, never as something to depend on programmatically.

### RSC build contract (read before touching `tsup.config.ts`)

Two separate bugs shipped because the **build output** lost a React Server Component directive, even though the source was correct the whole time. Both were silent — no error, nothing in the terminal — so neither source review nor any test against `src/` could have caught them. `tsup.config.ts` has a long header explaining the four constraints in full; the short version:

1. **A directive survives only as the emitted file's prologue.** esbuild drops `'use client'`/`'use server'` from any module merged into an output file that has a different (or no) prologue. So each directive-bearing module must be its own entry.
2. **`'use server'` needs the function *body* in the directive file.** Next instruments the action where the directive applies and registers it in `server-reference-manifest.json`; a directive on a re-export barrel leaves the real function uninstrumented and browser→server relay silently no-ops. Hence `relay/server-action` builds with `splitting: false`.
3. **`'use client'` only needs a *boundary*.** A directive-bearing barrel is enough — whatever it re-exports joins the client graph. That's why `src/provider/client.ts` can stay in the main code-split build.
4. **`core/logger.ts` must be exactly one runtime instance.** It owns `clientBootstrap`, `preInitBuffer`, and `globalConfig`. Two copies ⇒ `initClientLogger()` writes one while `dispatch()` reads the other (browser buffers every log forever), and `configureLogger()` stops reaching the relay handlers. A `splitting: false` island would inline its own copy, so `core/logger` is emitted as a stable entry and the island marks `../core/logger` external.

Two non-obvious traps, both of which were actually hit:

- `provider/index.ts` must import `LoggerBootstrapClient` from `./client`, **and `'./client'` must be in build ①'s `external` list.** Otherwise esbuild hoists the component into a shared chunk, rewrites `provider/index.js` to import it from there, and `dist/provider/client.js` becomes dead code nobody imports — the directive is still present but the boundary is never crossed, so browser logging dies exactly as before.
- `provider/index.js` must have **no** directive of its own; it holds the async Server Component. A `'use client'` there is what forces the two components into one file in the first place.

All of this is enforced by `scripts/check-build-contract.mjs` (run in `postbuild`, so a broken artifact can't be published) and `src/__tests__/build-contract.test.ts`, which additionally mutates a copy of `dist/` to re-introduce each historical bug and asserts the checker rejects it — so the guard can't silently rot into something that always passes.

### Known build-log noise (non-fatal)

Consuming apps that import anything from the main entry inside an Edge-eligible file (e.g. `proxy.ts` importing `generateRequestId`) will see Turbopack/webpack warn about `process.stdout`/`process.cwd` "not supported in the Edge Runtime" — because tsup's single shared chunk bundles `transport/server.ts`/`utils/caller.ts` alongside everything else, and the bundler's static analysis flags the mere presence of those calls even though `isServer()`/runtime guards mean they never execute on Edge. This is cosmetic (build still succeeds, exit 0) — Proxy defaults to the Node.js runtime in Next.js 16 anyway. Don't try to "fix" it by adding runtime guards around `process.stdout` references; the guards already exist at the call-site level, this is a bundler false positive on unreachable code.

### Package export surface

Seven **public** entry points (see `exports` in `package.json`): the core logger (`.`), the provider (`./provider`, kept separate so non-React/server-only consumers don't pull in JSX), the instrumentation kit (`./instrumentation`, separate because `instrumentation.ts` is loaded in a special early context and should pull in as little as possible), the transport adapters (`./transports`, separate so the main entry stays free of `node:fs` and vendor payload shapes — it is imported by Edge-eligible consumer files where a filesystem dependency would be actively wrong), the Redis relay limiter (`./security/rate-limit-redis`), and the two relay handlers (`./relay/route-handler`, `./relay/server-action`). When adding a new public export, wire it through `src/index.ts` (or the relevant subpath entry file) *and* the `entry` map in `tsup.config.ts` *and* the `exports` map — all three must stay in sync or consumers will get a resolution error post-build.

Two further entries are emitted but deliberately **not** in `exports`, because they exist to satisfy the build contract rather than to be imported by consumers: `dist/provider/client.js` (the `'use client'` boundary, imported relatively by `dist/provider/index.js`) and `dist/core/logger.js` (a stable re-export of the shared chunk, imported relatively by `dist/relay/server-action.js` so it gets the one true `globalConfig`). Relative intra-package imports don't need `exports` entries — but don't "tidy up" by deleting either entry, or the corresponding relative import breaks.
