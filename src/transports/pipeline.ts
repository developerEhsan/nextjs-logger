/**
 * @file transports/pipeline.ts
 * Batching, retry and backpressure for `Transport` sinks.
 *
 * ── What this replaces ───────────────────────────────────────────────────
 * `writeToTerminal` used to call every configured transport synchronously,
 * once per entry, inside a `try/catch`. That is the correct amount of
 * machinery for a counter and nowhere near enough for a network sink: no
 * batching (one HTTP request per log line), no retry (a blip loses the
 * line), and any `await` inside the transport became a floating promise
 * nobody could wait on — so a serverless function could freeze with the
 * batch still in flight.
 *
 * ── Design rules ─────────────────────────────────────────────────────────
 * ① **Never on the caller's stack.** `push()` appends to a buffer and
 *    returns. Actual delivery happens on a timer or once a batch fills.
 *    This is the same rule the client queue follows, for the same reason:
 *    `log.info()` is documented as callable from a React render body, and
 *    on the server that includes a Server Component's render.
 * ② **One in-flight batch per transport.** A slow sink applies
 *    backpressure to itself only; a fast one is not held up behind it, and
 *    no transport ever sees two overlapping `write()` calls.
 * ③ **Bounded, with visible drops.** The buffer has a hard cap and evicts
 *    oldest-first. Drops are *counted per transport* and readable via
 *    `getTransportStats()`, because a logging pipeline that silently loses
 *    data is worse than one that loudly refuses it — this package has
 *    shipped enough silent-loss bugs already.
 * ④ **A throwing transport is contained.** It cannot break the terminal
 *    write, another transport, or the app.
 * ⑤ **Timers never hold the process open.** Every interval is `unref()`d
 *    where the runtime supports it, so a CLI or a test run still exits.
 *
 * ── On serverless, call `flushTransports()` ──────────────────────────────
 * Batching and a freeze-on-response execution model are in direct tension:
 * the platform can suspend the instance the moment the response is sent,
 * with a batch still buffered. There is no way for a library to paper over
 * that — the app has to say "I'm done" — so `flushTransports()` is exported
 * and the README says to `await` it before returning from a handler. The
 * default flush interval is deliberately short (2s) to bound the loss when
 * someone forgets.
 */

import type { LogEntry, LogLevel } from '../core/types';
import { LOG_LEVEL } from '../core/types';
import {
  isBatchedTransport,
  type FlushReason,
  type LogTransport,
  type Transport,
  type TransportStats,
} from './types';

export interface PipelineOptions {
  /** Flush as soon as a transport has this many entries buffered. */
  maxBatchSize?: number;
  /** Flush a partially-full buffer after this long. */
  flushIntervalMs?: number;
  /** Hard cap on buffered entries per transport before oldest are dropped. */
  maxBufferSize?: number;
  /** Attempts per batch after the first failure. */
  maxRetries?: number;
  /** First retry delay; doubles each attempt, with jitter. */
  baseRetryDelayMs?: number;
  /** Ceiling on the backoff delay. */
  maxRetryDelayMs?: number;
}

const DEFAULTS: Required<PipelineOptions> = {
  maxBatchSize: 100,
  flushIntervalMs: 2_000,
  maxBufferSize: 10_000,
  maxRetries: 3,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 10_000,
};

interface TransportState {
  transport: Transport;
  buffer: LogEntry[];
  inFlight: Promise<void> | null;
  stats: TransportStats;
}

export class TransportPipeline {
  private readonly options: Required<PipelineOptions>;
  private readonly states: TransportState[] = [];
  /** Plain function sinks — called inline, exactly as they always were. */
  private readonly simple: ((entry: LogEntry) => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(transports: LogTransport[], options: PipelineOptions = {}) {
    this.options = { ...DEFAULTS, ...options };

    for (const transport of transports) {
      if (isBatchedTransport(transport)) {
        this.states.push({
          transport,
          buffer: [],
          inFlight: null,
          stats: {
            name: transport.name,
            written: 0,
            retried: 0,
            dropped: 0,
            pending: 0,
          },
        });
      } else {
        this.simple.push(transport);
      }
    }

    if (this.states.length > 0) this.startTimer();
  }

  /**
   * Offer an entry to every transport. Returns immediately — see rule ①.
   *
   * The entry is *not* copied. Transports receive the same object the
   * terminal formatter does, so a transport that mutates it corrupts what
   * every other transport sees. Copying per transport would allocate on
   * every log line for a hazard that is entirely in the transport author's
   * control, so it is documented rather than defended against.
   */
  push(entry: LogEntry): void {
    if (this.closed) return;

    for (const write of this.simple) {
      try {
        write(entry);
      } catch {
        // Rule ④ — a broken sink is not the app's problem.
      }
    }

    for (const state of this.states) {
      if (!this.accepts(state.transport, entry)) continue;

      state.buffer.push(entry);

      if (state.buffer.length > this.options.maxBufferSize) {
        // Drop oldest: the newest entries are the ones describing whatever
        // is going wrong right now.
        const overflow = state.buffer.length - this.options.maxBufferSize;
        state.buffer.splice(0, overflow);
        state.stats.dropped += overflow;
      }

      state.stats.pending = state.buffer.length;

      if (state.buffer.length >= this.options.maxBatchSize) {
        void this.drain(state, 'batch');
      }
    }
  }

  private accepts(transport: Transport, entry: LogEntry): boolean {
    if (transport.minLevel && LOG_LEVEL[entry.level] < LOG_LEVEL[transport.minLevel]) {
      return false;
    }
    if (transport.filter) {
      try {
        return transport.filter(entry);
      } catch {
        // A throwing filter is treated as "no opinion" rather than as a
        // reason to drop — losing logs to a buggy predicate is the worse
        // failure of the two.
        return true;
      }
    }
    return true;
  }

  /** Flush every transport and wait for delivery. */
  async flush(reason: FlushReason = 'manual'): Promise<void> {
    await Promise.all(this.states.map((state) => this.drain(state, reason)));
    // A transport may hold its own internal buffer (a file transport
    // batching writes, an SDK with its own queue).
    await Promise.all(
      this.states.map(async (state) => {
        try {
          await state.transport.flush?.();
        } catch {
          // Contained — see rule ④.
        }
      }),
    );
  }

  /** Flush, then release resources. The pipeline is unusable afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopTimer();
    await this.flush('shutdown');
    this.closed = true;

    await Promise.all(
      this.states.map(async (state) => {
        try {
          await state.transport.close?.();
        } catch {
          // Contained.
        }
      }),
    );
  }

  getStats(): TransportStats[] {
    return this.states.map((state) => ({ ...state.stats, pending: state.buffer.length }));
  }

  // ─── Delivery ──────────────────────────────────────────────────────────

  /**
   * Ship this transport's buffer.
   *
   * If a batch is already in flight, chain onto it rather than starting a
   * second one (rule ②). The returned promise resolves when *this* call's
   * work is done, which is what makes `flush()` a real barrier.
   */
  private drain(state: TransportState, reason: FlushReason): Promise<void> {
    if (state.inFlight) {
      return (state.inFlight = state.inFlight.then(() => this.drainNow(state, reason)));
    }
    state.inFlight = this.drainNow(state, reason).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  private async drainNow(state: TransportState, reason: FlushReason): Promise<void> {
    if (state.buffer.length === 0) return;

    const batch = state.buffer;
    state.buffer = [];
    state.stats.pending = 0;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        await state.transport.write(batch, reason);
        state.stats.written += batch.length;
        return;
      } catch {
        state.stats.retried++;

        if (attempt === this.options.maxRetries) {
          state.stats.dropped += batch.length;
          return;
        }

        // On shutdown there is no time to sit through a backoff — the
        // platform may suspend the instance mid-wait. Try the remaining
        // attempts back-to-back instead of sleeping through them.
        if (reason !== 'shutdown') {
          await sleep(this.backoffDelay(attempt));
        }
      }
    }
  }

  /** Exponential backoff with full jitter, capped. */
  private backoffDelay(attempt: number): number {
    const exponential = this.options.baseRetryDelayMs * 2 ** attempt;
    const capped = Math.min(exponential, this.options.maxRetryDelayMs);
    // Full jitter: without it, every instance that failed on the same
    // upstream blip retries in lockstep and re-creates the thundering herd
    // that caused the blip.
    return Math.random() * capped;
  }

  // ─── Timer ─────────────────────────────────────────────────────────────

  private startTimer(): void {
    if (this.timer !== null) return;

    this.timer = setInterval(() => {
      for (const state of this.states) {
        if (state.buffer.length > 0) void this.drain(state, 'interval');
      }
    }, this.options.flushIntervalMs);

    // Rule ⑤. `unref` exists on Node timers, not on the DOM ones or in
    // every runtime, hence the guard.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

// ─── Per-config pipeline registry ────────────────────────────────────────

/**
 * One pipeline per `transports` array.
 *
 * The write path receives the array from config on every call and must not
 * build a new pipeline each time (that would discard every buffer and every
 * timer). Keying a `WeakMap` on the array identity gives one stable
 * pipeline per configuration, created lazily, collected when the config
 * goes away. `configureLogger()` builds a fresh array, so it naturally
 * produces a fresh pipeline — the old one is still reachable through
 * `activePipelines` below until it is flushed.
 */
const pipelines = new WeakMap<LogTransport[], TransportPipeline>();

/**
 * Every pipeline ever created, so `flushTransports()` can reach one whose
 * config array has since been replaced. Holding strong references here is
 * deliberate: a pipeline with buffered entries must not be collected before
 * those entries are delivered. Entries are removed on `close()`.
 */
const activePipelines = new Set<TransportPipeline>();

export function getPipeline(
  transports: LogTransport[],
  options?: PipelineOptions,
): TransportPipeline {
  let pipeline = pipelines.get(transports);
  if (!pipeline) {
    pipeline = new TransportPipeline(transports, options);
    pipelines.set(transports, pipeline);
    activePipelines.add(pipeline);
  }
  return pipeline;
}

/**
 * Flush every transport in the process and wait for delivery.
 *
 * **Call this before returning from a serverless handler.** Batching and a
 * freeze-on-response execution model are fundamentally in tension: the
 * platform can suspend the instance the instant the response is sent, with
 * a batch still buffered. No library can fix that from the inside.
 *
 * @example
 *   export async function POST(req: Request) {
 *     const res = await handle(req);
 *     await flushTransports();
 *     return res;
 *   }
 */
export async function flushTransports(): Promise<void> {
  await Promise.all([...activePipelines].map((pipeline) => pipeline.flush('manual')));
}

/** Flush and shut down every transport. For process exit. */
export async function closeTransports(): Promise<void> {
  const all = [...activePipelines];
  activePipelines.clear();
  await Promise.all(all.map((pipeline) => pipeline.close()));
}

/** Delivery counters for every active transport, for diagnostics. */
export function getTransportStats(): TransportStats[] {
  return [...activePipelines].flatMap((pipeline) => pipeline.getStats());
}

/** Drop all registered pipelines without flushing. Tests only. */
export function _resetPipelines(): void {
  activePipelines.clear();
}
