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
}

/** A pluggable server-side sink; receives the same entry written to the terminal. */
export type LogTransport = (entry: LogEntry) => void;

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
  /** Force-flush the client queue immediately (useful before page unload). */
  flush: () => Promise<void>;
  /** Create a child logger with an additional namespace segment. */
  child: (namespace: string) => Logger;
}

export type LogMethod = (message: string, data?: unknown) => void;

// ─── Relay API ───────────────────────────────────────────────────────────────

/**
 * POST body sent from client → /api/__log relay endpoint.
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

/** Response from the relay endpoint (not exposed to callers). */
export interface RelayResponse {
  ok: boolean;
  dropped?: number;
}
