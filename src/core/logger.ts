/**
 * @file core/nextjs-logger.ts
 * The heart of the library: createLogger() and the singleton `log` export.
 *
 * Environment dispatch:
 *
 *   log.info('hello')
 *        │
 *        ├── Server (Node.js / Edge)? ──► write directly to terminal,
 *        │                                synchronously, no queue needed.
 *        │
 *        └── Client (browser)?        ──► enqueue into ClientQueue,
 *                                          which Pacer-flushes to the relay,
 *                                          which writes to the SAME terminal.
 *
 * This dispatch happens transparently inside every log method — callers
 * never need to know or care which environment they're in. That's the
 * "use it anywhere, no useEffect" requirement: the function call itself
 * is synchronous and side-effect-free from the component's perspective;
 * all async work (queueing, network) happens internally.
 */

import {
  type Logger,
  type LogLevel,
  type LogEntry,
  type LoggerConfig,
  type LogMethod,
  type SerializedError,
  type TimerHandle,
  LOG_LEVEL,
} from './types';
import { buildDefaultConfig, isServer, isEdgeRuntime, sourceMapsEnabled, isDev } from './config';
import { isErrorLike, serializeError, errorSummary, normalizeErrorsDeep } from './errors';
import { isLevelEnabled } from './level-filter';
import { applySchemaValidation, hasSchemas } from './schema';
import {
  startTimer,
  endTimer,
  createTimerHandle,
  _setDefaultLogger,
} from './timing';
import { writeToTerminal } from '../transport/server';
import { getCallerLocation } from '../utils/caller';
import { getCurrentRequestId, getCurrentTraceIds } from '../utils/request-context';
import { getOrCreateClientQueue, type ClientQueueOptions } from '../queue/client-queue';
import type { ClientTransportOptions, ServerActionRelay } from '../transport/client';

// ─── Module-level sequence counter (server side) ─────────────────────────────

let serverSequence = 0;

// ─── Client bootstrap state ───────────────────────────────────────────────────

/**
 * The client needs a session token (+ the timestamp it was issued at) plus
 * a relay URL and optional Server Action. These are injected once via
 * `initClientLogger()`, typically called from a small client component
 * mounted near the root layout (see README).
 *
 * If the client logger is used before initialisation, entries are buffered
 * in a pre-init queue and flushed automatically once `initClientLogger`
 * is called — this avoids race conditions where a component logs before
 * the bootstrap script runs.
 */
interface ClientBootstrap {
  relayUrl: string;
  signedToken: string;
  issuedAt: string;
  serverAction?: ServerActionRelay;
  debug: boolean;
}

let clientBootstrap: ClientBootstrap | null = null;
let preInitBuffer: LogEntry[] = [];
const PRE_INIT_BUFFER_CAP = 200;

/**
 * Call once on the client (inside a small "use client" bootstrap component)
 * to wire up the relay transport. See `<LoggerProvider />` in index.tsx
 * for the recommended zero-config integration.
 */
export function initClientLogger(bootstrap: ClientBootstrap): void {
  clientBootstrap = bootstrap;

  // Flush anything that was queued before init
  if (preInitBuffer.length > 0) {
    const buffered = preInitBuffer;
    preInitBuffer = [];
    const queue = getOrCreateClientQueue(buildClientQueueOptions(globalConfig));
    for (const entry of buffered) queue.enqueue(entry);
  }
}

// ─── Configuration state ──────────────────────────────────────────────────────

/**
 * The config backing the default `log` singleton (and any logger created
 * without overrides). Mutated in place by `configureLogger()` so that
 * app-wide settings changes are visible to every method already captured
 * in a closure over `getGlobalConfig`.
 */
let globalConfig: LoggerConfig = buildDefaultConfig();

/** Override global config at runtime (called once at app startup, optional). */
export function configureLogger(overrides: Partial<LoggerConfig>): void {
  globalConfig = buildDefaultConfig(overrides);
}

/**
 * Read the currently active global config. Exposed so the relay handlers
 * (`relay/route-handler.ts`, `relay/server-action.ts`) can share the same
 * `configureLogger()`-mutated settings (secret, allowed origins, pretty
 * print) instead of independently deriving their own — see the module-load
 * note in those files for why that divergence used to be a real bug.
 */
export function getConfig(): LoggerConfig {
  return globalConfig;
}

function buildClientQueueOptions(cfg: LoggerConfig): ClientQueueOptions {
  if (!clientBootstrap) {
    throw new Error(
      '[logger] Client logger used before initClientLogger() was called.',
    );
  }
  const transportOptions: ClientTransportOptions = {
    relayUrl: clientBootstrap.relayUrl,
    signedToken: clientBootstrap.signedToken,
    issuedAt: clientBootstrap.issuedAt,
    serverAction: clientBootstrap.serverAction,
    debug: clientBootstrap.debug,
    redactKeys: cfg.redactKeys,
  };
  return {
    maxQueueSize: cfg.maxQueueSize,
    pacerPolicies: cfg.pacerPolicies,
    transportOptions,
    debug: clientBootstrap.debug,
  };
}

// ─── Entry construction ────────────────────────────────────────────────────────

/**
 * Work out what the caller meant, given that both arguments are `unknown`.
 *
 * Four shapes are supported, and all four occur constantly in real code:
 *
 *   log.error(err)                          → error, message from the error
 *   log.error('checkout failed', err)       → error, caller's message
 *   log.error('checkout failed', { error: err, orderId })
 *                                           → error hoisted out of data
 *   log.info('hello', { userId })           → no error, unchanged behaviour
 *
 * The third form matters more than it looks: it is what `withLogging()`
 * emits, and it is the shape people write by hand when they want the error
 * alongside other context. Hoisting `data.error` means that call gets the
 * same first-class stack rendering as `log.error(err)` instead of a
 * serialised blob buried in the data object.
 *
 * Anything left in `data` still gets a deep pass so that errors nested
 * further down (`{ results: [{ err }] }`) serialise properly too — that
 * walk short-circuits and returns the original reference when there is
 * nothing to rewrite, so the common error-free path is free.
 */
function normalizeArgs(
  rawMessage: unknown,
  rawData: unknown,
): { message: string; data: unknown; error?: SerializedError } {
  // ① An error as the message.
  if (isErrorLike(rawMessage)) {
    const error = serializeError(rawMessage);
    return {
      message: errorSummary(error),
      data: rawData === undefined ? undefined : normalizeErrorsDeep(rawData),
      error,
    };
  }

  const message = typeof rawMessage === 'string' ? rawMessage : stringifyMessage(rawMessage);

  // ② An error as the data argument.
  if (isErrorLike(rawData)) {
    return { message, data: undefined, error: serializeError(rawData) };
  }

  // ③ An error under `data.error`.
  if (
    typeof rawData === 'object' &&
    rawData !== null &&
    !Array.isArray(rawData) &&
    isErrorLike((rawData as { error?: unknown }).error)
  ) {
    const { error, ...rest } = rawData as { error: unknown } & Record<string, unknown>;
    const remaining = Object.keys(rest).length > 0 ? normalizeErrorsDeep(rest) : undefined;
    return { message, data: remaining, error: serializeError(error) };
  }

  // ④ Ordinary data.
  return {
    message,
    data: rawData === undefined ? undefined : normalizeErrorsDeep(rawData),
  };
}

/**
 * Render a non-string, non-Error first argument. `console.log(obj)` prints
 * the object, so accepting one here and stringifying is the least
 * surprising behaviour; the alternative (`"[object Object]"`) is the
 * classic logging papercut.
 */
function stringifyMessage(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function buildEntry(
  level: LogLevel,
  message: string,
  data: unknown,
  error: SerializedError | undefined,
  namespace: string | undefined,
  cfg: LoggerConfig,
): LogEntry {
  const onServer = isServer();
  const runtime: 'server' | 'client' = onServer ? 'server' : 'client';
  // Server-side only: the browser has no trace context to read, and the
  // relayed entry inherits correlation from the relay request itself.
  const trace = onServer ? getCurrentTraceIds() : undefined;

  return {
    level,
    message,
    data,
    error,
    context: {
      runtime,
      timestamp: new Date().toISOString(),
      sequence: onServer ? serverSequence++ : 0, // client assigns its own sequence in the queue
      // Gated on config: the stack capture behind this is expensive enough
      // that it should not run on every production log line.
      caller:
        onServer && cfg.captureCaller
          ? getCallerLocation({ sourceMaps: sourceMapsEnabled(cfg) })
          : undefined,
      namespace,
      requestId: onServer ? getCurrentRequestId() : undefined,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    },
  };
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * The level gate.
 *
 * `cfg.minLevel` is the floor; `cfg.levelRules` (from `LOG_LEVEL`, or set
 * directly) can raise or lower it for a matching namespace, or silence the
 * namespace entirely. Resolution is memoised per namespace inside
 * `level-filter.ts`, so the common no-rules case costs one property read.
 */
function shouldLog(level: LogLevel, namespace: string | undefined, cfg: LoggerConfig): boolean {
  if (cfg.levelRules?.length) {
    return isLevelEnabled(level, namespace, cfg.levelRules, cfg.minLevel);
  }
  return LOG_LEVEL[level] >= LOG_LEVEL[cfg.minLevel];
}

/** Returns true if this call should be dropped by its level's sample rate. */
function isSampledOut(level: LogLevel, cfg: LoggerConfig): boolean {
  const rate = cfg.sampleRate?.[level];
  if (rate === undefined) return false;
  return Math.random() >= rate;
}

function dispatch(
  level: LogLevel,
  rawMessage: unknown,
  rawData: unknown,
  namespace: string | undefined,
  cfg: LoggerConfig,
): void {
  // Fast exits for filtered/sampled-out levels — avoid all downstream work.
  // Both gates run before `normalizeArgs`, so a filtered-out level never
  // pays for error serialisation or the deep data walk.
  if (!shouldLog(level, namespace, cfg)) return;
  if (isSampledOut(level, cfg)) return;

  // Defensive: never let a logging call throw and break the caller's code.
  try {
    const { message, data, error } = normalizeArgs(rawMessage, rawData);
    let entry = buildEntry(level, message, data, error, namespace, cfg);

    // Optional per-namespace `data` validation. Gated on there being any
    // schema registered at all, so an app that never calls
    // `registerSchema()` pays one boolean check. A violation annotates the
    // entry; it never suppresses it — see `core/schema.ts`.
    if (hasSchemas()) entry = applySchemaValidation(entry, isDev());

    if (isServer()) {
      // Server (Node.js or Edge): write straight to the terminal.
      // Edge Runtime has its own stdout-equivalent via console, but since
      // Next.js pipes Edge console output to the same terminal, we can
      // reuse the same transport. isEdgeRuntime() is exposed for callers
      // who need to special-case behavior, but no special handling is
      // required here — process.stdout.write works in both runtimes
      // under Next.js's Node.js compatibility layer for Route Handlers.
      writeToTerminal(entry, {
        prettyPrint: cfg.prettyPrint,
        redactKeys: cfg.redactKeys,
        transports: cfg.transports,
        resolveSourceMaps: sourceMapsEnabled(cfg),
      });
    } else {
      // Client (browser): enqueue. If not yet initialised, buffer briefly.
      if (!clientBootstrap) {
        if (preInitBuffer.length < PRE_INIT_BUFFER_CAP) {
          preInitBuffer.push(entry);
        }
        return;
      }
      const queue = getOrCreateClientQueue(buildClientQueueOptions(cfg));
      queue.enqueue(entry);
    }
  } catch {
    // Logging must never crash the host application. We intentionally
    // swallow errors here — there is no safe place to report a logging
    // failure without risking infinite recursion or a worse crash.
  }
}

// ─── Public factory ────────────────────────────────────────────────────────────

function makeLogMethod(level: LogLevel, namespace: string | undefined, getCfg: () => LoggerConfig): LogMethod {
  return (message: unknown, data?: unknown) => {
    dispatch(level, message, data, namespace, getCfg());
  };
}

/**
 * Attach the measured duration to the entry's structured data as well as
 * its message.
 *
 * The message (`"db.query: 42.1ms"`) is for the human reading the terminal;
 * `data.durationMs` is for everything else — a transport shipping to a log
 * aggregator, a `jq` pipeline, an alert on p99. Putting it only in the
 * message would make timings unqueryable, which defeats most of the reason
 * to log them.
 */
function withDuration(data: unknown, durationMs: number): unknown {
  if (data === undefined) return { durationMs };
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), durationMs };
  }
  return { durationMs, data };
}

/**
 * Create a fully independent logger instance with its own frozen config
 * (minLevel, pacerPolicies, sampleRate, redactKeys, etc.) — changes made
 * later via `configureLogger()` do NOT affect instances already created by
 * `createLogger()`, and vice versa. Most apps should just use the default
 * `log` singleton export instead; `createLogger` exists for
 * libraries/modules that want an isolated namespace with its own settings.
 *
 * Note: the client-side relay queue (`ClientQueue`) is a single per-page
 * singleton regardless of how many logger instances exist — TanStack Pacer
 * needs one coordinated queue, so only the FIRST client-side instance to
 * actually dispatch a log (default `log` or any `createLogger` instance)
 * determines the queue's `pacerPolicies`/`maxQueueSize`. `minLevel`,
 * `sampleRate`, `redactKeys` and `namespace` always apply per-instance
 * regardless of queue ordering, since those are evaluated in `dispatch()`
 * before anything reaches the queue.
 */
export function createLogger(overrides: Partial<LoggerConfig> = {}): Logger {
  const instanceConfig = buildDefaultConfig(overrides);
  return buildLoggerObject(overrides.namespace, () => instanceConfig);
}

function buildLoggerObject(namespace: string | undefined, getCfg: () => LoggerConfig): Logger {
  return {
    debug: makeLogMethod('debug', namespace, getCfg),
    info: makeLogMethod('info', namespace, getCfg),
    warn: makeLogMethod('warn', namespace, getCfg),
    error: makeLogMethod('error', namespace, getCfg),
    fatal: makeLogMethod('fatal', namespace, getCfg),

    assert: (condition: unknown, message?: unknown, data?: unknown) => {
      if (condition) return;
      dispatch(
        'error',
        message === undefined ? 'Assertion failed' : message,
        data,
        namespace,
        getCfg(),
      );
    },

    time: (label: string) => {
      startTimer(namespace, label, (warning) =>
        dispatch('warn', warning, undefined, namespace, getCfg()),
      );
    },

    timeEnd: (label: string, data?: unknown): number | undefined => {
      const durationMs = endTimer(namespace, label);
      if (durationMs === undefined) {
        // Matches `console.timeEnd`'s behaviour of warning rather than
        // silently doing nothing — a mistyped label is otherwise invisible.
        dispatch(
          'warn',
          `Timer "${label}" does not exist.`,
          undefined,
          namespace,
          getCfg(),
        );
        return undefined;
      }
      dispatch(
        'debug',
        `${label}: ${durationMs}ms`,
        withDuration(data, durationMs),
        namespace,
        getCfg(),
      );
      return durationMs;
    },

    timer: (label: string, level: LogLevel = 'debug'): TimerHandle =>
      createTimerHandle(label, (message, data, durationMs) => {
        dispatch(level, message, withDuration(data, durationMs), namespace, getCfg());
      }),

    flush: async () => {
      if (!isServer() && clientBootstrap) {
        const queue = getOrCreateClientQueue(buildClientQueueOptions(getCfg()));
        await queue.flush();
      }
      // Server-side writes are synchronous already — nothing to flush.
    },
    child: (childNamespace: string) => {
      const combined = namespace ? `${namespace}:${childNamespace}` : childNamespace;
      return buildLoggerObject(combined, getCfg);
    },
  };
}

/**
 * The default, ready-to-use logger singleton. Backed by `globalConfig`, so
 * `configureLogger()` calls made anywhere in the app — even after this
 * singleton was created at module load — take effect immediately.
 * `import { log } from '@developerehsan/nextjs-logger'` then `log.info(...)`.
 */
export const log: Logger = buildLoggerObject(undefined, () => globalConfig);

// `withLogging()` needs a default logger but cannot import one: `timing.ts`
// is imported *by* this module, so a back-import would be a cycle and would
// leave `log` undefined at the moment a consumer evaluates `withLogging()`
// at their own module scope. Inject it instead, now that `log` exists.
_setDefaultLogger(log);

/** Exposed for advanced consumers who need raw environment checks. */
export { isServer, isEdgeRuntime };
