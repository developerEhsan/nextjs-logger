/**
 * @file index.ts
 * Public entry point for `@developerehsan/nextjs-logger`.
 *
 * Import surface kept intentionally small:
 *
 *   import { log } from '@developerehsan/nextjs-logger';
 *   log.info('Hello', { userId: 42 });
 *
 * Advanced consumers can additionally import:
 *   - `createLogger` to build a namespaced/standalone instance
 *   - `configureLogger` to override global Pacer policies, min level, etc.
 *   - Provider components from the `/provider` subpath (separate entry
 *     to keep React/JSX out of consumers who only need server logging,
 *     e.g. inside scripts or non-React backend code).
 */

export { log, createLogger, configureLogger, isServer, isEdgeRuntime } from './core/logger';
export type {
  Logger,
  LogLevel,
  LogMethod,
  LoggerConfig,
  LogEntry,
  LogContext,
  PacerPolicy,
  PacerStrategy,
  LogTransport,
  SerializedError,
  TimerHandle,
} from './core/types';

/**
 * Error serialisation, exposed because it is useful outside a log call —
 * attaching a serialised error to an API response, or normalising one
 * before handing it to another reporter.
 */
export { serializeError, isErrorLike } from './core/errors';

/**
 * Optional per-namespace validation of a log entry's `data`, via any
 * Standard Schema validator (Zod 3.24+, Valibot, ArkType) or a plain
 * predicate — so structured logs stay queryable instead of drifting.
 */
export { registerSchema, clearSchemas } from './core/schema';
export type { DataSchema, SchemaViolationMode, StandardSchemaV1 } from './core/schema';

/** Duration logging for whole functions — Server Actions, Route Handlers. */
export { withLogging } from './core/timing';
export type { WithLoggingOptions } from './core/timing';

export {
  runWithRequestContext,
  getCurrentRequestId,
  getCurrentTraceIds,
  generateRequestId,
} from './utils/request-context';

/**
 * W3C Trace Context. `traceContextFromHeaders` in a proxy/middleware, then
 * pass the result to `runWithRequestContext`, and every server log line
 * carries `traceId`/`spanId` — joinable with whatever traces your gateway,
 * OTel SDK or vendor already produces.
 */
export {
  parseTraceparent,
  traceContextFromHeaders,
  formatTraceparent,
  getActiveSpanContext,
} from './utils/trace-context';
export type { TraceContext } from './utils/trace-context';

/**
 * Per-namespace level control. Populated automatically from `LOG_LEVEL`;
 * `parseLevelSpec` is for building the same rules in code.
 */
export { parseLevelSpec, isLevelEnabled } from './core/level-filter';
export type { LevelRule } from './core/level-filter';

/**
 * Transport delivery control. The adapters themselves live in the
 * `/transports` subpath so this entry stays free of `node:fs` and vendor
 * payload shapes — but `flushTransports()` belongs here, because it is
 * what a serverless handler must await before returning.
 */
export {
  flushTransports,
  closeTransports,
  getTransportStats,
} from './transports/pipeline';
export type { Transport, TransportStats, FlushReason } from './transports/types';
