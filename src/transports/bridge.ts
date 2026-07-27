/**
 * @file transports/bridge.ts
 * Forward entries into an existing Pino or Winston logger.
 *
 * ── Who this is for ──────────────────────────────────────────────────────
 * An app that already has a logging stack — Pino writing to a transport
 * pipeline, Winston with three configured sinks, an SIEM contract built on
 * one of them — and wants this package's *ergonomics* (call it anywhere,
 * browser logs in the terminal, source-mapped stacks) without moving its
 * delivery. Rip-and-replace is the wrong ask; being a good citizen inside
 * someone else's pipeline is a much easier sell.
 *
 * ── Structural typing, no dependency ─────────────────────────────────────
 * Neither library is imported, or declared as an optional peer. Both expose
 * the same de-facto interface — level methods taking `(object, message)`
 * for Pino and `(message, meta)` for Winston — so the bridge duck-types
 * against that. The consequence is that this also works with any logger
 * shaped like them, including a hand-rolled one, and that upgrading Pino or
 * Winston can never produce a version conflict here.
 *
 * ── Argument order is the whole trick ────────────────────────────────────
 * Pino: `logger.info(mergingObject, message)`.
 * Winston: `logger.info(message, meta)`.
 * They are exactly reversed, and getting it wrong does not throw — it
 * produces log lines whose message is `[object Object]`, forever, in
 * production. Hence two explicit factories rather than one guessing.
 */

import type { LogEntry } from '../core/types';
import type { Transport } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shape both libraries share: a method per level. */
interface LevelMethods {
  debug(...args: any[]): unknown;
  info(...args: any[]): unknown;
  warn(...args: any[]): unknown;
  error(...args: any[]): unknown;
  [key: string]: unknown;
}

/**
 * Neither Pino nor Winston has a `fatal` level by default (Pino does;
 * Winston's default `npm` levels stop at `error`), so `fatal` is mapped
 * to the target's `fatal` when it exists and `error` otherwise, with the
 * original level preserved in the payload so nothing is lost.
 */
function resolveMethod(target: LevelMethods, entry: LogEntry): (...args: any[]) => unknown {
  if (entry.level === 'fatal') {
    const fatal = target['fatal'];
    if (typeof fatal === 'function') return fatal.bind(target);
    return target.error.bind(target);
  }
  return target[entry.level].bind(target);
}

/** The structured payload handed to the target logger, in either order. */
function toPayload(entry: LogEntry): Record<string, unknown> {
  return {
    level: entry.level,
    ...(entry.context.namespace ? { namespace: entry.context.namespace } : {}),
    ...(entry.context.requestId ? { requestId: entry.context.requestId } : {}),
    ...(entry.context.traceId ? { traceId: entry.context.traceId } : {}),
    ...(entry.context.spanId ? { spanId: entry.context.spanId } : {}),
    ...(entry.context.caller ? { caller: entry.context.caller } : {}),
    runtime: entry.context.runtime,
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    ...(entry.error
      ? {
          // Pino's standard error serialiser keys off `err`; Winston
          // renders whatever it is given. `type`/`message`/`stack` is the
          // shape Pino's own serialiser produces, so downstream formatting
          // keeps working.
          err: {
            type: entry.error.name,
            message: entry.error.message,
            stack: entry.error.stack?.join('\n'),
            ...(entry.error.properties ?? {}),
          },
        }
      : {}),
  };
}

/**
 * Forward to a Pino logger — `logger.level(mergingObject, message)`.
 *
 * @example
 *   import pino from 'pino';
 *   configureLogger({ transports: [pinoTransport(pino())] });
 */
export function pinoTransport(target: LevelMethods, name = 'pino'): Transport {
  return {
    name,
    // Synchronous per batch. Pino does its own batching and its own
    // async delivery; adding ours on top would only add latency, and
    // Pino's `flush` is what actually guarantees delivery.
    write(entries: LogEntry[]): void {
      for (const entry of entries) {
        resolveMethod(target, entry)(toPayload(entry), entry.message);
      }
    },
    flush(): void {
      const flush = target['flush'];
      if (typeof flush === 'function') flush.call(target);
    },
  };
}

/**
 * Forward to a Winston logger — `logger.level(message, meta)`.
 *
 * @example
 *   configureLogger({ transports: [winstonTransport(myWinstonLogger)] });
 */
export function winstonTransport(target: LevelMethods, name = 'winston'): Transport {
  return {
    name,
    write(entries: LogEntry[]): void {
      for (const entry of entries) {
        // Reversed relative to Pino. See the header.
        resolveMethod(target, entry)(entry.message, toPayload(entry));
      }
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
