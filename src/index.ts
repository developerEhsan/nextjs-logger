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
} from './core/types';

export {
  runWithRequestContext,
  getCurrentRequestId,
  generateRequestId,
} from './utils/request-context';
