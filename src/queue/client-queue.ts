/**
 * @file queue/client-queue.ts
 * Client-side log queue backed by TanStack Pacer primitives.
 *
 * Architecture:
 *   LogEntry arrives
 *       │
 *       ▼
 *   [Memory Ring Buffer]  ← max `maxQueueSize` entries; LRU eviction
 *       │
 *       ▼
 *   Per-level Pacer  ─── throttle / debounce / rateLimit ──►  relayEntries()
 *
 * Each log level has its own Pacer instance so that:
 *   • debug/info (high volume) are throttled to avoid relay flooding.
 *   • warn is debounced so bursts consolidate into one relay call.
 *   • error/fatal are rate-limited with a hard cap but never debounced
 *     (you want errors relayed promptly, just not more than N per window).
 *
 * TanStack Pacer is a CLIENT-SIDE library. The queue is created lazily
 * and only ever instantiated in a browser environment.
 */

import {
  throttle,
  debounce,
  rateLimit,
} from '@tanstack/pacer';

import type {
  LogEntry,
  LogLevel,
  PacerPolicy,
  LevelPacerMap,
  QueuedEntry,
} from '../core/types';

import type { ClientTransportOptions } from '../transport/client';
import { relayEntries, relayEntriesBeacon } from '../transport/client';

// ─── Ring buffer ─────────────────────────────────────────────────────────────

class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this.size === this.capacity) {
      evicted = this.buf[this.head];
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.size++;
    }
    const tail = (this.head + this.size - 1) % this.capacity;
    this.buf[tail] = item;
    return evicted;
  }

  drain(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const item = this.buf[(this.head + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    this.head = 0;
    this.size = 0;
    this.buf = new Array(this.capacity);
    return out;
  }

  get length(): number {
    return this.size;
  }
}

// ─── Pacer factory ────────────────────────────────────────────────────────────

type FlushFn = () => void;

/**
 * Wrap `flushFn` with the appropriate TanStack Pacer strategy.
 * Returns a function with the same signature as `flushFn` but rate-controlled.
 */
function wrapWithPacer(flushFn: FlushFn, policy: PacerPolicy): FlushFn {
  switch (policy.strategy) {
    case 'throttle':
      return throttle(flushFn, {
        wait: policy.windowMs,
        leading: true,
        trailing: true,
      });

    case 'debounce':
      return debounce(flushFn, {
        wait: policy.waitMs,
        leading: false,
        trailing: true,
      });

    case 'rateLimit':
      // rateLimit returns a function that calls `flushFn` only if within limits.
      // Entries dropped by the rate limiter remain in the buffer — they will be
      // included in the next window's flush.
      return rateLimit(flushFn, {
        limit: policy.limit,
        window: policy.windowMs,
        windowType: policy.windowType ?? 'sliding',
        onReject: () => {
          // Rate limit hit — the buffer is still accumulating; next maybeFlush
          // will drain it once the window resets.
        },
      });
  }
}

// ─── ClientQueue ──────────────────────────────────────────────────────────────

export interface ClientQueueOptions {
  maxQueueSize: number;
  pacerPolicies: LevelPacerMap;
  transportOptions: ClientTransportOptions;
  debug?: boolean;
}

export class ClientQueue {
  private readonly buffer: RingBuffer<QueuedEntry>;
  private readonly pacers: Map<LogLevel, FlushFn> = new Map();
  private readonly transportOpts: ClientTransportOptions;
  private readonly debug: boolean;
  private isDestroyed = false;

  /** Monotonic sequence counter for this browser tab. */
  private sequence = 0;

  constructor(opts: ClientQueueOptions) {
    this.buffer = new RingBuffer(opts.maxQueueSize);
    this.transportOpts = opts.transportOptions;
    this.debug = opts.debug ?? false;

    // Build one Pacer per level
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      const policy = opts.pacerPolicies[level];
      if (!policy) continue;

      // The flush function drains the buffer and ships to the relay.
      // Closure over `this` is intentional.
      const flush: FlushFn = () => void this.flush();
      this.pacers.set(level, wrapWithPacer(flush, policy));
    }

    // Register unload handlers to drain the queue before tab closes
    this.registerUnloadHandlers();
  }

  /** Enqueue an entry and trigger its level-specific Pacer. */
  enqueue(entry: LogEntry): void {
    if (this.isDestroyed) return;

    const queued: QueuedEntry = {
      ...entry,
      context: {
        ...entry.context,
        sequence: this.sequence++,
      },
      enqueuedAt: performance.now(),
      retries: 0,
    };

    const evicted = this.buffer.push(queued);
    if (evicted && this.debug) {
      // A debug-only dev-tools note — never reaches the server terminal
      console.debug(
        '[logger] Queue full — oldest entry evicted:',
        evicted.message,
      );
    }

    // Trigger the appropriate Pacer for this level
    const pacer = this.pacers.get(entry.level);
    if (pacer) pacer();
  }

  /** Drain the buffer and ship all accumulated entries to the relay. */
  async flush(): Promise<void> {
    if (this.isDestroyed) return;

    const entries = this.buffer.drain();
    if (entries.length === 0) return;

    // Strip queue-internal fields before sending over the wire
    const wireEntries: LogEntry[] = entries.map(({ enqueuedAt: _e, retries: _r, ...rest }) => rest);

    try {
      await relayEntries(wireEntries, this.transportOpts);
    } catch {
      // On permanent failure: re-enqueue with incremented retry counter
      // (up to MAX_RETRIES, then drop permanently)
      for (const entry of entries) {
        if (entry.retries < 3) {
          this.buffer.push({ ...entry, retries: entry.retries + 1 });
        }
      }
    }
  }

  /** Synchronous beacon flush for page unload (no async available). */
  private beaconFlush(): void {
    const entries = this.buffer.drain();
    if (entries.length === 0) return;

    const wireEntries: LogEntry[] = entries.map(
      ({ enqueuedAt: _e, retries: _r, ...rest }) => rest,
    );
    relayEntriesBeacon(wireEntries, this.transportOpts);
  }

  private registerUnloadHandlers(): void {
    if (typeof window === 'undefined') return;

    // Preferred: fires reliably on tab switch and back-forward cache
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.beaconFlush();
      }
    });

    // Fallback for older browsers: fires on page close
    window.addEventListener('beforeunload', () => {
      this.beaconFlush();
    });

    // Page Show fires when BFCache restores — no action needed but good to know
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && this.debug) {
        console.debug('[logger] Page restored from BFCache.');
      }
    });
  }

  /** Tear down the queue (useful in tests). */
  destroy(): void {
    this.isDestroyed = true;
    this.buffer.drain(); // discard
  }
}

// ─── Singleton management ────────────────────────────────────────────────────

let _globalQueue: ClientQueue | null = null;

export function getOrCreateClientQueue(
  opts: ClientQueueOptions,
): ClientQueue {
  if (_globalQueue) return _globalQueue;
  _globalQueue = new ClientQueue(opts);
  return _globalQueue;
}

/** Replace the global queue (used in tests). */
export function _resetClientQueue(): void {
  _globalQueue?.destroy();
  _globalQueue = null;
}
