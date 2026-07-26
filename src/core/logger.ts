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
  LOG_LEVEL,
} from './types';
import { buildDefaultConfig, isServer, isEdgeRuntime } from './config';
import { writeToTerminal } from '../transport/server';
import { getCallerLocation } from '../utils/caller';
import { getCurrentRequestId } from '../utils/request-context';
import { getOrCreateClientQueue, type ClientQueueOptions } from '../queue/client-queue';
import type { ClientTransportOptions } from '../transport/client';

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
  serverAction?: (entries: LogEntry[]) => Promise<void>;
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

function buildEntry(
  level: LogLevel,
  message: string,
  data: unknown,
  namespace: string | undefined,
): LogEntry {
  const runtime: 'server' | 'client' = isServer() ? 'server' : 'client';

  return {
    level,
    message,
    data,
    context: {
      runtime,
      timestamp: new Date().toISOString(),
      sequence: isServer() ? serverSequence++ : 0, // client assigns its own sequence in the queue
      caller: isServer() ? getCallerLocation() : undefined,
      namespace,
      requestId: isServer() ? getCurrentRequestId() : undefined,
    },
  };
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

function shouldLog(level: LogLevel, cfg: LoggerConfig): boolean {
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
  message: string,
  data: unknown,
  namespace: string | undefined,
  cfg: LoggerConfig,
): void {
  // Fast exits for filtered/sampled-out levels — avoid all downstream work.
  if (!shouldLog(level, cfg)) return;
  if (isSampledOut(level, cfg)) return;

  // Defensive: never let a logging call throw and break the caller's code.
  try {
    const entry = buildEntry(level, message, data, namespace);

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
  return (message: string, data?: unknown) => {
    dispatch(level, message, data, namespace, getCfg());
  };
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

/** Exposed for advanced consumers who need raw environment checks. */
export { isServer, isEdgeRuntime };
