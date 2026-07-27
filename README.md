# @developerehsan/nextjs-logger

A `console.log`-shaped logging library for Next.js 16 that writes **exclusively
to your terminal** — never to the browser console, never readable by an end
user — with automatic server/client detection, zero required hooks, and a
TanStack Pacer-backed queue so client-originated logs never flood your relay
endpoint.

```ts
import { log } from '@developerehsan/nextjs-logger';

log.info('User signed in', { userId: 42 }); // works in Server Components,
                                              // Client Components, Server
                                              // Actions, Route Handlers —
                                              // anywhere, no hooks required.
```

Whether that call happens during SSR on the server or inside a click handler
in the browser, the output appears **only in your terminal**, formatted the
same way, correlated by request ID where available.

---

## 1. Why this exists

Building a "just let me console.log from the client into my terminal" tool
sounds trivial until you actually try to ship it safely. Three things make it
hard, and this library solves all three:

1. **Security** — if any unauthenticated party can reach an endpoint that
   writes into your terminal, you've built a log-injection / DoS vector into
   your own infrastructure. Every entry that reaches `process.stdout` passes
   through HMAC signature verification, origin allowlisting, replay-window
   enforcement, and structural validation first.
2. **Performance** — client components routinely re-render dozens of times
   per second during animations or rapid state changes. Naively POSTing on
   every log call would hammer your server. TanStack Pacer throttles,
   debounces, or rate-limits each log level independently before anything
   leaves the browser.
3. **DX** — the whole point of `console.log` is that you don't think about
   it. This library preserves that by buffering pre-initialisation calls and
   wiring up the bootstrap synchronously during render, so you never need a
   `useEffect`, a "logger ready" check, or a context hook in your own code.

---

## 2. Installation

```bash
npm install @developerehsan/nextjs-logger @tanstack/pacer
```

Set a strong relay secret (production only — development has an insecure
fallback with a loud warning):

```bash
# .env.production
LOGGER_RELAY_SECRET=$(openssl rand -base64 48)
NEXT_PUBLIC_APP_URL=https://your-app.com
```

---

## 3. Setup (one-time, ~3 lines)

### 3.1 Mount the provider once, near your root layout

```tsx
// app/layout.tsx
import { LoggerProvider } from '@developerehsan/nextjs-logger/provider';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <LoggerProvider>{children}</nextjs-loggerProvider>
      </body>
    </html>
  );
}
```

This is an **async Server Component**. It mints a short-lived signed session
token on the server and threads it down to a 1-line Client Component that
bootstraps the relay transport — synchronously, during render, before any
descendant component mounts. You never touch this again.

### 3.2 Create the relay API route (the default transport)

```ts
// app/api/log-relay/route.ts
export { POST } from '@developerehsan/nextjs-logger/relay/route-handler';
```

That's the entire file. All verification logic lives inside the package.

> **Do not rename this folder to something starting with an underscore.**
> Next.js treats `_folder` as a [private folder](https://nextjs.org/docs/app/getting-started/project-structure#private-folders)
> and excludes it from routing entirely, so the handler would never be mounted
> and the relay would silently fall back to the slower Server Action transport.
> If you pass a custom `relayUrl`, the provider warns in development when it
> spots an underscore-prefixed segment.

### 3.3 (Optional but recommended) Request correlation via `proxy.ts`

Next.js 16 renamed `middleware.ts` → `proxy.ts`. Adding one gives every log
line produced while handling a request the same `requestId`, which makes
tracing a single request through a noisy terminal far easier.

```ts
// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateRequestId } from '@developerehsan/nextjs-logger';

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('x-request-id', generateRequestId());
  return response;
}

export const config = { matcher: '/:path*' };
```

A full copy-paste-ready version (plus an `instrumentation.ts` example that
auto-logs uncaught request errors) lives in `/examples` in this package.

That's the entire setup. Everything below is usage.

---

## 4. Usage

### Anywhere, with zero hooks

```tsx
'use client';
import { log } from '@developerehsan/nextjs-logger';

export function LikeButton() {
  // Safe to call directly in the render body.
  log.debug('LikeButton rendered');

  return (
    <button onClick={() => log.info('Like clicked')}>
      Like
    </button>
  );
}
```

```tsx
// Server Component — no 'use client', writes synchronously to terminal
import { log } from '@developerehsan/nextjs-logger';

export default async function Page() {
  log.info('Rendering /dashboard');
  const data = await getData();
  if (!data.length) log.warn('Dashboard returned empty data set');
  return <Dashboard data={data} />;
}
```

### Errors

Pass the error itself. `Error`'s fields are non-enumerable, so a logger that
just `JSON.stringify`s it prints `{}` — this one serialises `message`,
`name`, the stack, the `cause` chain, `AggregateError.errors`, and own
extras like `code`, `statusCode` and Next.js's `digest`.

```ts
try {
  await chargeCard(order);
} catch (err) {
  log.error(err);                                  // message + full stack
  log.error('checkout failed', err);               // your message, full stack
  log.error('checkout failed', { orderId, error: err }); // hoisted, same result
}
```

```
10:23:45.123 [ERROR] StripeCardError: Your card was declined
  StripeCardError: Your card was declined
    at chargeCard (app/lib/payments.ts:42:11)
    at Checkout (app/checkout/page.tsx:18:5)
    props: {"code":"card_declined","statusCode":402}
  caused by:
    Error: connect ECONNREFUSED 10.0.0.4:443
      at TCPConnectWrap.afterConnect (node:net:1607:16)
```

Errors nested inside `data` are serialised too, at any depth. A thrown
non-`Error` (`throw 'boom'`, a rejected promise with a string reason) is
handled rather than dropped.

Every log method accepts `unknown` as its first argument specifically so
`catch (err)` — which TypeScript types as `unknown` — needs no cast.

### Uncaught errors, automatically

Uncaught browser errors and unhandled rejections reach the terminal with no
call site at all — `<LoggerProvider>` installs `window.onerror` and
`unhandledrejection` handlers (additively; your other error reporters and
the browser console still see everything). Disable with
`captureGlobalErrors={false}`.

For the server side, wire up `instrumentation.ts`:

```ts
// instrumentation.ts (project root)
export { onRequestError } from '@developerehsan/nextjs-logger/instrumentation';

export async function register() {
  const { registerProcessErrorHandlers } = await import(
    '@developerehsan/nextjs-logger/instrumentation'
  );
  registerProcessErrorHandlers();
}
```

`onRequestError` is the Next.js hook that fires for every server-side error
the framework catches — thrown Server Components, failed Server Actions,
rejected Route Handlers, and errors surfaced mid-stream, which are otherwise
the hardest class to see because the response has already started.

### Timings

```ts
const t = log.timer('db.query');
const rows = await db.select();
t.end({ rows: rows.length });     // → "db.query: 42.1ms"  + data.durationMs
```

`log.time(label)` / `log.timeEnd(label)` exist for `console` parity, but
they key timers by label in module state — **use `log.timer()` on the
server**, where two concurrent requests sharing a label would corrupt each
other's measurement.

To time a whole function, including its failures:

```ts
import { withLogging } from '@developerehsan/nextjs-logger';

export const createOrder = withLogging(
  async (formData: FormData) => { /* … */ },
  { name: 'createOrder' },
);
```

```
→ createOrder
✓ createOrder                       { "durationMs": 128.4 }
✗ createOrder                       { "durationMs": 91.2 }  + full error/stack
```

The wrapper is transparent: the original error is re-thrown unwrapped, a
sync function stays sync, and `this` is forwarded. Arguments and return
values are **not** logged unless you pass `logArgs`/`logResult` — positional
arguments can't be reached by `redactKeys`, which matches object keys.

### Assertions

```ts
log.assert(cart.total >= 0, 'cart total went negative', { cartId });
```

Logs at `error` level only when the condition is falsy.

### Real filenames instead of chunk paths

Stack frames and the `caller` field are resolved through your build's source
maps, so you get `app/checkout/form.tsx:42:9` rather than
`/_next/static/chunks/page.js:2:48219`. This applies to relayed browser
stacks (where it matters most — those frames are minified) and to the
`caller` field, which otherwise degrades to a Turbopack chunk path.

On in development by default. For production, emit maps and opt in:

```ts
// next.config.ts
export default { productionBrowserSourceMaps: true };
```
```ts
configureLogger({ sourceMaps: 'always' });   // 'dev' | 'always' | 'off'
```

Resolution is best-effort and cached per chunk: a missing or unparseable map
leaves the generated location untouched rather than failing the log.

### Namespacing

```ts
import { createLogger } from '@developerehsan/nextjs-logger';

const authLog = createLogger({ namespace: 'auth' });
authLog.info('Login attempt'); // prints "[auth] Login attempt" in the terminal
```

Or chain off the default logger:

```ts
import { log } from '@developerehsan/nextjs-logger';
const dbLog = log.child('db');
```

### Manual flush (rarely needed)

The queue auto-flushes on a Pacer schedule and on tab close via
`sendBeacon`. If you need to guarantee delivery before, e.g., a programmatic
`router.push()` navigates away:

```ts
await log.flush();
```

---

## 5. How client logs get to your terminal

```
Browser                                  Server (your terminal)
────────                                 ───────────────────────
log.info(...)
   │
   ▼
ClientQueue.enqueue()
   │  (per-level TanStack Pacer:
   │   throttle / debounce / rateLimit)
   ▼
flush() ──── API route (default) ────────────► POST /api/log-relay
       └──── Server Action (fallback, only ──► relayLogEntries()
             if the route handler is absent)
                                                     │
                                          HMAC verify, origin check,
                                          replay-window check,
                                          structural validation
                                                     │
                                                     ▼
                                          process.stdout / stderr
```

Two transports are attempted in order:

1. **Server Action** — zero extra HTTP round-trip; rides on Next.js's own
   RSC Flight protocol, which has its own built-in CSRF protection.
2. **Signed API route** — used automatically if the Server Action isn't
   wired up, or as a retry fallback if the Server Action call fails 3 times.

Both paths converge on the exact same terminal writer
(`writeBatchToTerminal`), so output formatting is identical regardless of
transport.

---

## 6. Security model

The client never holds the relay secret, so it cannot compute a real HMAC
over each payload — instead it carries a **bearer session token**, minted
once server-side per page load (`sign(secret, "session."+issuedAt)`), on
every relay call (fetch, retries, *and* the `sendBeacon` unload path all
reuse the same token). The server re-derives and compares it in constant
time. This authenticates "this request came from a session the server
minted," not "these exact bytes are untampered" — that stronger guarantee
isn't achievable without shipping the secret to the browser. Entry content
safety instead comes from structural validation + sanitisation below.

| Threat | Mitigation |
|---|---|
| Unauthenticated party POSTs fake logs | Session-token HMAC, verified server-side with a secret that **never** ships to the client |
| A leaked/captured token used indefinitely | 6-hour session max-age window (`SESSION_MAX_AGE_MS`), independent of any single request |
| Cross-origin abuse from another site (browser-driven) | Origin/Referer header checked against an explicit allowlist |
| Oversized payload DoS | 256 KB body cap, checked via `Content-Length` *before* the body is even read |
| Log flooding via many small entries | Max 100 entries per request, enforced independently of size cap |
| ANSI / control-character terminal injection | All messages sanitised (`\x1b[...]`, `\r`, `\0` stripped) before any `stdout.write` |
| Non-serialisable / prototype-polluting `data` payloads | JSON round-trip sanitisation before formatting |
| Secret-shaped fields (`password`, `token`, `secret`, ...) leaking into logs | Redacted to `[REDACTED]` by default (`redactKeys`), both client- and server-side, before anything is written or relayed |
| Client holding the signing secret | The client **never** receives the raw secret — only a server-minted, time-scoped session token |

The relay endpoint returns generic 4xx codes on every rejection path and
never echoes back *why* a request failed, so an attacker probing the
endpoint gets no signal to iterate toward a forged payload. Set
`LOGGER_DEBUG_RELAY=1` to have rejections logged (with the real reason) to
your own terminal only — the response sent to the client is unaffected.

A scripted (non-browser) client can trivially omit the `Origin`/`Referer`
headers and skip that check entirely — treat origin allowlisting as
defense-in-depth against browser-driven abuse, not the primary control;
the session token is.

---

## 7. Performance model — TanStack Pacer

Each log level gets its own independent Pacer strategy so that, e.g., a
component re-rendering 60 times a second and calling `log.debug()` each time
doesn't generate 60 relay calls per second.

| Level | Default strategy | Rationale |
|---|---|---|
| `debug` | `throttle`, 500ms | High volume, low urgency — smooth the firehose |
| `info` | `throttle`, 300ms | Frequent but more actionable than debug |
| `warn` | `debounce`, 200ms | Consolidate bursts into one meaningful flush |
| `error` | `rateLimit`, 10 / 5s sliding | Must never flood the relay, but must arrive promptly |
| `fatal` | `rateLimit`, 3 / 10s sliding | Rare by definition — hard cap regardless |

Override any of these globally:

```ts
import { configureLogger } from '@developerehsan/nextjs-logger';

configureLogger({
  pacerPolicies: {
    debug: { strategy: 'throttle', windowMs: 1000 },
    error: { strategy: 'rateLimit', limit: 20, windowMs: 5000, windowType: 'sliding' },
  },
});
```

Additional performance guarantees:

- A **ring buffer** caps in-memory queued entries (`maxQueueSize`, default
  500) — under extreme load, oldest entries are evicted rather than growing
  memory unbounded.
- **`navigator.sendBeacon`** is used on `visibilitychange`/`beforeunload` so
  queued logs aren't silently dropped when a tab closes mid-burst.
- Server-side logging is fully **synchronous** (direct `stdout.write`) — no
  queue, no async overhead, since there's no network hop to smooth out.
- Every log call is wrapped in a `try/catch` internally — a logging failure
  can **never** crash or throw inside your application code.

---

## 8. Configuration reference

```ts
interface LoggerConfig {
  minLevel: LogLevel;            // default: 'debug' in dev, 'info' in prod
  pacerPolicies: LevelPacerMap;  // per-level Pacer strategy, see above
  maxQueueSize: number;          // default: 500
  prettyPrint: boolean;          // default: true in dev, JSON in prod
  namespace?: string;
  allowedOrigins: string[];      // auto-populated from NEXT_PUBLIC_APP_URL
  redactKeys: (string | RegExp)[]; // default: password/token/secret/... — see below
  sampleRate?: Partial<Record<LogLevel, number>>; // e.g. { debug: 0.1 } keeps ~10%
  transports?: LogTransport[];   // extra sinks, e.g. Sentry/Datadog — see below
  captureCaller: boolean;        // default: true in dev — file:line per entry
  sourceMaps: 'dev'|'always'|'off'; // default: 'dev' — real filenames, see above
  captureGlobalErrors: boolean;  // default: true — window.onerror capture
  relayRateLimit: RateLimitPolicy | false; // default: 120 req / 10 s per client
}
```

**`createLogger(overrides)` builds a fully isolated instance** — its own
`minLevel`, `sampleRate`, `redactKeys`, etc. — unaffected by any later
`configureLogger()` call, and vice versa. The default `log` singleton is
the one instance that *does* pick up `configureLogger()` changes live,
even ones made after `log` was first imported.

### Redaction

```ts
import { configureLogger } from '@developerehsan/nextjs-logger';

// Extends the built-in defaults (password, token, secret, apiKey,
// authorization, cookie, creditCard, ssn, and anything matching /token$/i
// or /secret$/i) — it does not replace them.
configureLogger({ redactKeys: ['ssnNumber', /^internal/i] });

log.info('User updated', { email: 'a@b.com', password: 'hunter2' });
// → { email: 'a@b.com', password: '[REDACTED]' }
```

Redaction runs both before a client-side entry ever leaves the browser and
again server-side at write time, so it applies uniformly regardless of
which transport (Server Action, API route, direct server-side call)
produced the entry.

### Sampling

```ts
configureLogger({ sampleRate: { debug: 0.1 } }); // keep ~10% of debug calls
```

Omit a level (or the whole map) to log everything at that level — this is
independent of, and evaluated before, `minLevel`/Pacer filtering.

### Runtime level control per namespace

```bash
LOG_LEVEL='info:*,debug:checkout,-checkout:polling'
```

Info everywhere, debug under `checkout`, and nothing at all from
`checkout:polling`. The `debug`-package syntax you already know: `*`
wildcards, comma separation, `-` to silence. **The last matching rule
wins**, so read it left-to-right as "general default, then exceptions".
Exact patterns match their children (`checkout` covers `checkout:payment`).

Build the same rules in code with `parseLevelSpec()` and
`configureLogger({ levelRules })`.

### Trace correlation (OpenTelemetry / W3C)

Every server-side entry carries `traceId`/`spanId` when a trace context is
available, from either an active OpenTelemetry span or the inbound
`traceparent` header. This is what makes these log lines joinable with the
traces your gateway or vendor already produces — `requestId` stops at the
process boundary; a trace ID does not.

With an OTel SDK installed there is nothing to do. Without one, pick the
header up in your proxy:

```ts
// proxy.ts
import { runWithRequestContext, generateRequestId, traceContextFromHeaders }
  from '@developerehsan/nextjs-logger';

export default function proxy(request: Request) {
  return runWithRequestContext(
    generateRequestId(),
    () => handle(request),
    traceContextFromHeaders(request.headers),
  );
}
```

The pretty terminal format prints the first 8 characters (`trace:4bf92f35`);
JSON output and every transport carry the full IDs.

### Pluggable transports (server-side)

```ts
import type { LogTransport } from '@developerehsan/nextjs-logger';

const toSentry: LogTransport = (entry) => {
  if (entry.level === 'error' || entry.level === 'fatal') {
    // Sentry.captureMessage(entry.message, { extra: entry.data });
  }
};

configureLogger({ transports: [toSentry] });
```

Transports receive every entry that's actually written (after
sampling/level filtering) and run alongside the terminal write, each
isolated in its own `try/catch` — a throwing transport can never suppress
terminal output or crash another transport.

**For network sinks, use the batched form** and the shipped adapters, which
add batching, retry with jittered backoff, bounded buffers and drop
accounting:

```ts
import { configureLogger } from '@developerehsan/nextjs-logger';
import {
  fileTransport, datadogTransport, axiomTransport,
  betterStackTransport, otlpTransport, pinoTransport,
} from '@developerehsan/nextjs-logger/transports';

configureLogger({
  transports: [
    fileTransport({ path: './logs/app.log', maxSizeBytes: 10_000_000, maxFiles: 5 }),
    datadogTransport({ apiKey: process.env.DD_API_KEY!, minLevel: 'warn' }),
    otlpTransport({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT! }),
  ],
});
```

| Adapter | Notes |
|---|---|
| `fileTransport` | Size-based rotation. Synchronous appends, so the last lines survive a crash |
| `httpTransport` | Generic batching POST — build your own vendor on it |
| `datadogTransport` / `axiomTransport` / `betterStackTransport` | Presets over `httpTransport` |
| `otlpTransport` | OTLP/HTTP+JSON logs, with trace IDs in the LogRecord's own fields |
| `pinoTransport` / `winstonTransport` | Forward into an existing Pino/Winston pipeline |

Write your own with `{ name, write(entries) }`. **Throwing means "retry
me"** — throw for a network blip or a 5xx, return for a payload the remote
will never accept.

> **On serverless, `await flushTransports()` before returning.** Batching
> and freeze-on-response are fundamentally in tension: the platform can
> suspend the instance the moment the response is sent, with a batch still
> buffered. The default flush interval is 2s to bound the loss if you
> forget, but only you know when a request is done.

`getTransportStats()` reports `written` / `retried` / `dropped` / `pending`
per transport — drops are counted, never silent.

### Fleet-wide relay rate limiting

The built-in relay cap is in-memory, so on serverless it limits each warm
instance rather than the deployment. For a shared counter:

```ts
import { createRedisRateLimiter, upstashRedisClient }
  from '@developerehsan/nextjs-logger/security/rate-limit-redis';

const client = upstashRedisClient(); // reads UPSTASH_REDIS_REST_* ; null if unset
if (client) configureLogger({ relayRateLimitAsync: createRedisRateLimiter(client) });
```

Any Redis works — `ioredis`, `node-redis` and `@upstash/redis` all satisfy
the `RedisClient` interface. Both limits apply, and the shared one **fails
open**: a Redis outage must not silently delete every browser log.

### Log data schemas

Keep structured logs queryable by validating `data` per namespace, with any
[Standard Schema](https://standardschema.dev) validator (Zod 3.24+, Valibot,
ArkType) or a plain predicate:

```ts
import { registerSchema } from '@developerehsan/nextjs-logger';
import { z } from 'zod';

registerSchema('checkout', z.object({
  orderId: z.string(),
  amountCents: z.number().int(),
}));

log.child('checkout').info('order placed', { order_id: 'o_1' });
// ⚠ warns in dev: orderId: expected string — and logs the entry anyway
```

A violation **never suppresses the log line**; it warns in development and
annotates the entry with `data.__schemaError` in production. The one thing
worse than an inconsistently-shaped log is a missing one.

### `useLogger()` (optional React hook)

```tsx
'use client';
import { useLogger } from '@developerehsan/nextjs-logger/provider';

export function LikeButton() {
  const log = useLogger('like-button'); // memoized log.child('like-button')
  return <button onClick={() => log.info('clicked')}>Like</button>;
}
```

Purely a convenience for components that already sit in hook-heavy code —
`log.child('like-button')` works identically with no hook at all.

Environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `LOGGER_RELAY_SECRET` | Production: yes | Session-token signing secret, 32+ chars |
| `NEXT_PUBLIC_APP_URL` | Recommended | Seeds the origin allowlist (never used as a secret fallback — it's public) |
| `LOGGER_ALLOWED_ORIGINS` | Optional | Comma-separated extra allowed origins |
| `LOGGER_DEBUG_RELAY` | Optional | Set to `1` to log *why* the relay endpoint rejected a request, server-side only |
| `LOG_LEVEL` | Optional | Per-namespace levels, e.g. `info:*,debug:checkout,-checkout:polling` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional | Read by `upstashRedisClient()` for the fleet-wide relay cap |

---

## 9. FAQ

**Q: Will `log.info()` ever appear in the browser DevTools console?**
No. The client-side path never calls `console.*`. Internal failures of the
relay transport itself are only surfaced via `console.warn` when you pass
`debug: true` to `<LoggerProvider>`, and even then it's a generic transport
diagnostic, not your actual log content being duplicated.

**Q: What if I call `log.info()` before `<LoggerProvider>` has mounted?**
It's buffered (up to 200 entries) and flushed automatically the instant the
provider's bootstrap runs. You don't need to guard against ordering.

**Q: Does this work in the Edge Runtime?**
Yes for server-side writes. `AsyncLocalStorage`-based request ID correlation
is skipped automatically on Edge (it has no `async_hooks`), degrading
gracefully — you simply won't see a `requestId` field on those lines.

**Q: Can I use this outside Next.js?**
The core logger (`createLogger`, `log`) has no Next.js-specific imports and
works in any Node.js environment. The relay transports and `LoggerProvider`
are Next.js-specific.
