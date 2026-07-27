/**
 * @file types.ts
 * Core type definitions for @developerehsan/nextjs-logger
 *
 * Design philosophy:
 *  - Every public surface is fully typed — no `any` escapes.
 *  - Log levels mirror the console API exactly so muscle memory transfers.
 *  - PacerPolicy drives which TanStack Pacer strategy is used per level.
 *  - LogEntry is the canonical wire-format used by every transport.
 */

import type { SerializedError } from './errors';
import type { LevelRule } from './level-filter';
import type { LogTransport } from '../transports/types';

export type { SerializedError, LevelRule };

// ─── Log Levels ──────────────────────────────────────────────────────────────

/** Log level union, ordered by severity (lowest → highest). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Numeric severity so consumers can do comparisons like `level >= LOG_LEVEL.warn`. */
export const LOG_LEVEL: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
  fatal: 4,
} as const;

// ─── Pacer Strategies ────────────────────────────────────────────────────────

/**
 * Which TanStack Pacer strategy to apply when the client batches logs
 * before shipping them to the server.
 *
 * throttle  – at most one flush per `windowMs`, leading + trailing edge.
 *             Best for high-frequency, low-importance levels (debug/info).
 *
 * debounce  – flush only after `waitMs` of silence.
 *             Best for levels where you want one consolidated burst (warn).
 *
 * rateLimit – allow at most `limit` flushes per `windowMs`, then drop.
 *             Best for error/fatal where you never want to flood the relay.
 */
export type PacerStrategy = 'throttle' | 'debounce' | 'rateLimit';

export interface ThrottlePacerPolicy {
  strategy: 'throttle';
  /** Minimum ms between flushes (leading + trailing both fire). */
  windowMs: number;
}

export interface DebouncePacerPolicy {
  strategy: 'debounce';
  /** Wait for this many ms of silence before flushing. */
  waitMs: number;
}

export interface RateLimitPacerPolicy {
  strategy: 'rateLimit';
  /** Max number of flush operations per `windowMs`. */
  limit: number;
  windowMs: number;
  /** 'fixed' resets on the period boundary; 'sliding' rolls continuously. */
  windowType?: 'fixed' | 'sliding';
}

export type PacerPolicy =
  | ThrottlePacerPolicy
  | DebouncePacerPolicy
  | RateLimitPacerPolicy;

// ─── Canonical Log Entry ─────────────────────────────────────────────────────

/** Source context automatically injected by the logger. */
export interface LogContext {
  /** 'server' | 'client' — populated automatically via environment detection. */
  runtime: 'server' | 'client';
  /** ISO-8601 timestamp with millisecond precision. */
  timestamp: string;
  /** Sequential counter per process/tab so entries can be sorted exactly. */
  sequence: number;
  /** Caller file/line if available (server only — no stack-leak to clients). */
  caller?: string;
  /** Optional user-supplied namespace / tag. */
  namespace?: string;
  /** Request ID injected by middleware for cross-boundary correlation. */
  requestId?: string;
  /**
   * W3C trace ID (32 hex chars), from an active OpenTelemetry span or the
   * inbound `traceparent` header. Server-side only. Unlike `requestId`,
   * which is this library's own and stops at the process boundary, this is
   * the identifier every other tool in a distributed system already agrees
   * on — it is what makes these log lines joinable with traces.
   */
  traceId?: string;
  /** W3C span ID (16 hex chars) for the span that produced this entry. */
  spanId?: string;
}

/** The canonical log entry flowing through the entire pipeline. */
export interface LogEntry {
  level: LogLevel;
  /** The formatted message string. */
  message: string;
  /**
   * Additional structured data supplied by the caller.
   * Must be JSON-serialisable (validated before enqueueing).
   */
  data?: unknown;
  /**
   * A thrown value attached to this entry, already serialised.
   *
   * Populated when the caller passed an `Error` as the message, as the data
   * argument, or as `data.error` — see `dispatch()`. It is a first-class
   * field rather than just another key inside `data` because the terminal
   * formatter renders it specially (one frame per line, cause chain
   * indented), and because a stack has to survive the relay as structured
   * data rather than as a newline-bearing string.
   */
  error?: SerializedError;
  context: LogContext;
}

// ─── Logger Configuration ────────────────────────────────────────────────────

/**
 * Per-level pacer configuration.
 * If a level is omitted, its default policy is used (see DEFAULT_CONFIG).
 */
export type LevelPacerMap = Partial<Record<LogLevel, PacerPolicy>>;

export interface LoggerConfig {
  /**
   * Minimum level to process.
   * Entries below this level are dropped before entering the queue.
   * Defaults to 'debug' in development, 'info' in production.
   */
  minLevel: LogLevel;

  /**
   * Per-namespace level overrides, beating `minLevel` where they match.
   *
   * Populated automatically from the `LOG_LEVEL` environment variable
   * (`LOG_LEVEL=info:*,debug:checkout,-checkout:polling`), or set directly
   * with `parseLevelSpec()`. The last matching rule wins — see
   * `core/level-filter.ts` for why that beats "most specific wins".
   */
  levelRules?: LevelRule[];

  /**
   * Per-level Pacer policies for the client-side relay queue.
   * Server-side logs are written synchronously (no queue needed).
   */
  pacerPolicies: LevelPacerMap;

  /**
   * Server-only HMAC secret used to mint and verify client session tokens.
   * Never sent to the client in raw form — only a signed, time-scoped
   * token derived from it is. On the client this is the placeholder
   * `'__client__'`, since the client must never hold it.
   */
  relaySecret: string;

  /**
   * Maximum number of entries allowed in the in-memory client queue
   * before oldest entries are evicted (backpressure / memory guard).
   */
  maxQueueSize: number;

  /**
   * Whether to pretty-print on the server terminal.
   * Defaults to true in development.
   */
  prettyPrint: boolean;

  /**
   * Optional namespace prefix applied to all entries produced by this
   * logger instance.
   */
  namespace?: string;

  /**
   * CORS-like allowlist of origins permitted to call the relay endpoint.
   * Populated automatically from NEXT_PUBLIC_APP_URL + custom domains.
   */
  allowedOrigins: string[];

  /**
   * Object keys (case-insensitive) whose values are replaced with
   * `'[REDACTED]'` before an entry's `data` is written or relayed.
   * Matches nested keys at any depth. Defaults cover the most common
   * secret-shaped field names; extend via `configureLogger`.
   */
  redactKeys: (string | RegExp)[];

  /**
   * Optional per-level sampling rate in `[0, 1]`. `0.1` keeps ~10% of
   * entries at that level (chosen independently per call, before the
   * entry is built). Omit a level (or the whole map) to log everything.
   * Applies on both server and client.
   */
  sampleRate?: Partial<Record<LogLevel, number>>;

  /**
   * Additional sinks invoked with every entry that is actually written
   * server-side (after sampling/level filtering, before terminal output
   * is discarded). Each transport is isolated in its own try/catch — a
   * throwing transport can never crash the app or block other transports.
   */
  transports?: LogTransport[];

  /**
   * Server-side cap on relay requests, per client key, per window. Set to
   * `false` to disable (not recommended outside tests).
   *
   * This is the only thing bounding how much a holder of a session token can
   * write to your terminal. The client-side Pacer does not help here — it
   * throttles our own queue, which an attacker does not use, and the token
   * itself is readable by anyone who can load the page. In-memory and
   * therefore per-instance: on serverless this limits each warm instance
   * rather than the fleet, so put an edge rate limit in front if you need a
   * global guarantee.
   */
  relayRateLimit: RateLimitPolicy | false;

  /**
   * An additional, shared rate-limit check run *after* the in-memory one —
   * typically Redis-backed, so the cap applies fleet-wide rather than per
   * warm instance. See `security/rate-limit-redis.ts`.
   *
   * Both limits apply; the in-memory one stays as a cheap, always-available
   * floor that also absorbs the load if the shared store is down. This one
   * is awaited, so it must be fast (the Upstash client defaults to a 1s
   * timeout) and must fail *open* — a Redis outage should not silently
   * delete every browser log.
   */
  relayRateLimitAsync?: (
    key: string,
    policy: RateLimitPolicy,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

  /**
   * Capture the calling file/line for server-side entries. Defaults to true
   * in development, false in production.
   *
   * This is not free: it allocates an `Error` and materialises its stack on
   * the synchronous path of every server log, which is among the more
   * expensive things V8 does. Worth it while developing; rarely worth it in
   * production once you have structured `data` and request IDs. It was
   * previously unconditional *and* broken — every line reported the logger's
   * own internals — so nobody was getting value for the cost.
   */
  captureCaller: boolean;

  /**
   * Resolve bundled `file:line` positions back to the original source files
   * through the build's source maps, so log output names files a human
   * actually wrote.
   *
   * Applies to two things: the `caller` field (which otherwise degrades to
   * a Turbopack chunk path — see `utils/caller.ts`), and every frame of a
   * relayed browser stack trace (which is otherwise minified).
   *
   *   'dev'    – resolve in development only. Default.
   *   'always' – resolve in production too. Requires that your build
   *              actually emits maps (`productionBrowserSourceMaps: true`
   *              in `next.config`, and/or `serverSourceMaps`), and costs a
   *              synchronous file read per newly-seen chunk plus the parsed
   *              map's memory. Maps are cached, so the cost is per chunk,
   *              not per log line.
   *   'off'    – never resolve.
   *
   * Resolution is always best-effort: a missing or unparseable map leaves
   * the generated location untouched rather than failing the log.
   */
  sourceMaps: 'dev' | 'always' | 'off';

  /**
   * Install `window.onerror` / `unhandledrejection` handlers on the client
   * so uncaught browser errors reach the terminal without any per-call-site
   * work. Defaults to true.
   *
   * Handlers are additive — the previous `window.onerror`, if any, is still
   * called, and nothing is ever `preventDefault()`ed, so the browser
   * console still shows the error and other error reporters still see it.
   */
  captureGlobalErrors: boolean;
}

/** Fixed-window rate limit policy for the relay endpoint. */
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

/**
 * A pluggable server-side sink; receives the same entries written to the
 * terminal. Either a plain `(entry) => void` function (synchronous,
 * fire-and-forget) or a batched `Transport` object with retry and flush
 * semantics — see `transports/types.ts`.
 */
export type { LogTransport, Transport, TransportStats, FlushReason } from '../transports/types';

// ─── Internal Queue Entry ────────────────────────────────────────────────────

/** Entry stored in the client-side queue, waiting to be relayed. */
export interface QueuedEntry extends LogEntry {
  /** Monotonic client timestamp for ordering across tab restarts. */
  enqueuedAt: number;
  /** Retry counter — incremented by the relay transport on transient failure. */
  retries: number;
}

// ─── Logger API surface ───────────────────────────────────────────────────────

/**
 * The object returned by `createLogger()` and also the global `log` export.
 * Mirrors the browser/Node `console` API for zero learning-curve adoption.
 */
export interface Logger {
  debug: LogMethod;
  info:  LogMethod;
  warn:  LogMethod;
  error: LogMethod;
  fatal: LogMethod;

  /**
   * Log only when `condition` is falsy, mirroring `console.assert`.
   * Emits at `error` level. The condition itself is never logged — only
   * the message and data, so this is a guard, not a boolean printer.
   */
  assert: (condition: unknown, message?: unknown, data?: unknown) => void;

  /**
   * Start a labelled timer, `console.time`-style.
   *
   * Timers are keyed by label in module state, which makes this **unsafe
   * for concurrent server work**: two in-flight requests using the same
   * label share one entry. Use `timer()` on the server; this exists for
   * console parity and for the browser, where there is one of everything.
   */
  time: (label: string) => void;

  /**
   * Stop a timer started with `time()` and log the elapsed duration at
   * `debug` level. Returns the elapsed ms, or `undefined` if the label was
   * never started (in which case a warning is logged instead).
   */
  timeEnd: (label: string, data?: unknown) => number | undefined;

  /**
   * Start a timer that holds its own start time instead of a shared map
   * entry. The concurrency-safe form — prefer it on the server.
   *
   * @example
   *   const t = log.timer('db.query');
   *   const rows = await db.select();
   *   t.end({ rows: rows.length });   // → "db.query: 42.1ms"
   */
  timer: (label: string, level?: LogLevel) => TimerHandle;

  /** Force-flush the client queue immediately (useful before page unload). */
  flush: () => Promise<void>;
  /** Create a child logger with an additional namespace segment. */
  child: (namespace: string) => Logger;
}

/**
 * A log call.
 *
 * `message` is typed `unknown` rather than `string` for one specific
 * reason: `catch (err)` gives you `unknown` under TypeScript's
 * `useUnknownInCatchVariables` (on by default since 4.4), and
 * `log.error(err)` is the single most common logging call there is.
 * Requiring a cast there would be a tax on the exact call this library
 * most needs to get right. An `Error` passed here becomes the entry's
 * `error` field with full stack/cause serialisation; any other non-string
 * is stringified.
 */
export type LogMethod = (message: unknown, data?: unknown) => void;

/** Handle returned by `Logger.timer()`. */
export interface TimerHandle {
  /** Stop, log, and return the elapsed milliseconds. */
  end(data?: unknown): number;
  /** Elapsed ms so far, without stopping or logging. */
  elapsed(): number;
}

// ─── Relay API ───────────────────────────────────────────────────────────────

/**
 * POST body sent from client → /api/log-relay relay endpoint.
 *
 * Note this is a *bearer session token* scheme, not a per-payload HMAC:
 * the client never holds `relaySecret`, so it cannot sign `entries` itself.
 * `token` instead proves the request came from a session the server minted
 * (see `mintSessionToken`); it authenticates the caller, not the exact
 * byte-for-byte content of `entries`. Structural validation + sanitisation
 * (see `security/index.ts`) is what guards against malformed/malicious
 * entry content.
 */
export interface RelayPayload {
  entries: LogEntry[];
  /** HMAC-SHA256 of `session.${issuedAt}`, signed with relaySecret. */
  token: string;
  /** ISO timestamp the token was issued at; bounds the session's validity window. */
  issuedAt: string;
}

/** A minted session credential: the token and the time it was issued. */
export interface RelaySession {
  token: string;
  issuedAt: string;
}

/** Response from the relay endpoint (not exposed to callers). */
export interface RelayResponse {
  ok: boolean;
  dropped?: number;
  /**
   * A freshly minted session, returned once the presented token passes the
   * halfway mark of its validity window. The client swaps it in and keeps
   * going; without this a tab open longer than `SESSION_MAX_AGE_MS` would
   * start failing verification and silently drop every browser log.
   */
  session?: RelaySession;
}
