/**
 * @file transports/types.ts
 * The pluggable-sink contract.
 *
 * ── Two shapes, and why both exist ───────────────────────────────────────
 * `LogTransport` was originally just `(entry: LogEntry) => void`: called
 * synchronously, once per entry, fire-and-forget. That is fine for
 * "increment a counter" and useless for "ship to Datadog" — no batching, no
 * retry, and any `await` inside it is an unhandled floating promise the
 * pipeline cannot wait on at shutdown.
 *
 * So there is now a richer `Transport` object form, and the union keeps the
 * function form working exactly as before. That back-compatibility is not
 * politeness: the function form is genuinely the right shape for a cheap
 * synchronous sink, and forcing `{ name, write }` on someone incrementing a
 * Prometheus counter would be worse ergonomics for no gain.
 */

import type { LogEntry, LogLevel } from '../core/types';

/** Why a batch is being flushed — useful for a transport that behaves
 *  differently on shutdown (e.g. skipping compression to save time). */
export type FlushReason = 'batch' | 'interval' | 'manual' | 'shutdown';

export interface Transport {
  /** Identifies this transport in diagnostics and drop accounting. */
  name: string;

  /**
   * Ship a batch. May be async; the pipeline awaits it, retries it on
   * rejection, and will not start a second batch for this transport while
   * one is in flight.
   *
   * **Throwing (or rejecting) means "retry me"**, so throw for a network
   * blip or a 5xx and *don't* throw for a payload the remote will never
   * accept (a 400, a bad API key) — retrying those just burns the queue.
   */
  write(entries: LogEntry[], reason: FlushReason): void | Promise<void>;

  /** Flush anything held internally. Called by `flushTransports()`. */
  flush?(): void | Promise<void>;

  /** Release resources (file handles, sockets). Called by `closeTransports()`. */
  close?(): void | Promise<void>;

  /**
   * Only send entries at this level or above. Applied per transport, on top
   * of the logger's own `minLevel` — the common case being terminal output
   * at `debug` while the paid log vendor only gets `warn` and above.
   */
  minLevel?: LogLevel;

  /**
   * Arbitrary predicate, applied after `minLevel`. Return false to skip.
   * Runs on the log path, so keep it cheap.
   */
  filter?(entry: LogEntry): boolean;
}

/**
 * A sink. Either the simple synchronous function form or the batched
 * `Transport` object form.
 */
export type LogTransport = ((entry: LogEntry) => void) | Transport;

/** Narrow the union. */
export function isBatchedTransport(transport: LogTransport): transport is Transport {
  return typeof transport === 'object' && transport !== null && 'write' in transport;
}

/** Per-transport counters, readable via `getTransportStats()`. */
export interface TransportStats {
  name: string;
  /** Entries handed to `write()` and acknowledged. */
  written: number;
  /** Batches that failed and were retried (counts attempts, not batches). */
  retried: number;
  /** Entries discarded — retries exhausted, or the queue overflowed. */
  dropped: number;
  /** Entries currently buffered, waiting for the next flush. */
  pending: number;
}
