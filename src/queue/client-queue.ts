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

// ─── Render-safe scheduling ──────────────────────────────────────────────────

/**
 * Hop off the caller's synchronous stack before doing any I/O.
 *
 * `log.*()` is documented as callable from anywhere — including directly in a
 * React component's render body, which is the headline ergonomic of this
 * package. That means the caller's stack is frequently a *render* stack, and
 * anything the enqueue path does synchronously happens while React is
 * rendering.
 *
 * Relaying is exactly the thing you must not do there. Invoking the relay
 * Server Action dispatches through Next's router (it enqueues an action and
 * flips router state), so calling it from a render body produces:
 *
 *   Cannot update a component (`Router`) while rendering a different
 *   component (`LoggerPlayground`).
 *
 * This was reachable through two separate paths, both of which run during
 * render: a `log.*()` call in a component body (Pacer's leading edge fires
 * the flush synchronously), and `initClientLogger()`'s pre-init buffer drain
 * inside `LoggerBootstrapClient`'s body. Deferring here closes both at once,
 * and keeps the promise the core module's header already makes — that a log
 * call is "synchronous and side-effect-free from the component's
 * perspective".
 *
 * A macrotask, not a microtask: microtasks queued during a concurrent render
 * are flushed when React yields between time slices, so a microtask can still
 * land mid-render on a large tree. `setTimeout(…, 0)` lands after React has
 * rendered *and* committed. The `Promise` branch is only a fallback for
 * exotic runtimes with no timer at all.
 */
const scheduleOffRenderStack: (fn: () => void) => void =
  typeof setTimeout === 'function'
    ? (fn) => void setTimeout(fn, 0)
    : (fn) => void Promise.resolve().then(fn);

/** Queue-level retry attempts after `relayEntries` exhausts its own retries. */
const MAX_QUEUE_RETRIES = 3;

/** Delay before re-attempting a batch that failed every transport. */
const RETRY_DELAY_MS = 2_000;

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

  /**
   * Pending deferred Pacer triggers, one slot per level. Present means "a
   * trigger for this level is already scheduled for the next tick", which
   * collapses a synchronous burst (a loop firing 20 logs, a component
   * re-rendering hard) into a single Pacer call instead of 20 — the Pacer
   * would coalesce the *flushes* anyway, but a `rateLimit` policy counts
   * calls, so 20 triggers would burn the whole error budget in one tick.
   */
  private readonly pendingTriggers = new Map<LogLevel, ReturnType<typeof setTimeout>>();

  /** The in-flight flush, if any — used to serialise overlapping flushes. */
  private inFlight: Promise<void> | null = null;

  /** Set when a flush is requested while one is already running. */
  private flushAgain = false;

  /** Pending retry timer for a batch that failed every transport. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Kept so `destroy()` can actually unregister them (HMR / tests). */
  private readonly unloadListeners: (() => void)[] = [];

  constructor(opts: ClientQueueOptions) {
    this.buffer = new RingBuffer(opts.maxQueueSize);
    this.debug = opts.debug ?? false;

    // Own a copy so the renewed token can be swapped in without mutating an
    // object the caller still holds. The relay rotates the session before it
    // expires; whatever we send next must use the newest one.
    this.transportOpts = {
      ...opts.transportOptions,
      onSessionRenewed: (session) => {
        this.transportOpts.signedToken = session.token;
        this.transportOpts.issuedAt = session.issuedAt;
        if (this.debug) {
          console.debug('[logger] Relay session renewed.');
        }
      },
    };

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

    // Trigger the appropriate Pacer for this level — but never on this stack.
    // See `scheduleOffRenderStack` for why synchronous relaying here breaks
    // React. The entry is already safely in the buffer, so the only thing
    // being delayed is the network hop, by one macrotask.
    const level = entry.level;
    if (!this.pacers.has(level) || this.pendingTriggers.has(level)) return;

    const timer = setTimeout(() => {
      this.pendingTriggers.delete(level);
      if (this.isDestroyed) return;
      this.pacers.get(level)?.();
    }, 0);
    this.pendingTriggers.set(level, timer);
  }

  /**
   * Drain the buffer and ship all accumulated entries to the relay.
   *
   * Overlapping calls are serialised rather than run concurrently: several
   * levels' Pacers can fire in the same tick, and each would otherwise drain
   * a slice of the buffer into its own relay round-trip. Coalescing turns
   * that into one request with one batch.
   */
  flush(): Promise<void> {
    if (this.isDestroyed) return Promise.resolve();

    if (this.inFlight) {
      // A flush is already running; make sure it does another pass afterwards
      // so entries added since it drained aren't stranded until the next log.
      this.flushAgain = true;
      return this.inFlight;
    }

    this.inFlight = this.runFlush().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runFlush(): Promise<void> {
    do {
      this.flushAgain = false;
      await this.flushOnce();
    } while (this.flushAgain && !this.isDestroyed);
  }

  private async flushOnce(): Promise<void> {
    const entries = this.buffer.drain();
    if (entries.length === 0) return;

    // Strip queue-internal fields before sending over the wire
    const wireEntries: LogEntry[] = entries.map(({ enqueuedAt: _e, retries: _r, ...rest }) => rest);

    try {
      await relayEntries(wireEntries, this.transportOpts);
    } catch {
      // Every transport failed. Re-enqueue with an incremented retry counter
      // (up to MAX_QUEUE_RETRIES, then drop permanently) and schedule the
      // retry ourselves — waiting for the next `log.*()` call to happen to
      // come along would strand the batch on an idle page.
      let requeued = 0;
      for (const entry of entries) {
        if (entry.retries < MAX_QUEUE_RETRIES) {
          this.buffer.push({ ...entry, retries: entry.retries + 1 });
          requeued++;
        }
      }
      if (requeued > 0) this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.isDestroyed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, RETRY_DELAY_MS);
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
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const on = <T extends EventTarget>(
      target: T,
      type: string,
      handler: EventListener,
    ): void => {
      target.addEventListener(type, handler);
      // Remembered so `destroy()` can undo it — a queue torn down by HMR or a
      // test previously left its listeners attached to the live document,
      // where they kept beacon-flushing a dead queue on every tab switch.
      this.unloadListeners.push(() => {
        // Test doubles and minimal environments may expose only the adder.
        target.removeEventListener?.(type, handler);
      });
    };

    // Preferred: fires reliably on tab switch and back-forward cache
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.beaconFlush();
      }
    });

    // Fallback for older browsers: fires on page close
    on(window, 'beforeunload', () => {
      this.beaconFlush();
    });

    // Page Show fires when BFCache restores — no action needed but good to know
    on(window, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted && this.debug) {
        console.debug('[logger] Page restored from BFCache.');
      }
    });
  }

  /** Tear down the queue (useful in tests, and on HMR disposal). */
  destroy(): void {
    this.isDestroyed = true;

    for (const timer of this.pendingTriggers.values()) clearTimeout(timer);
    this.pendingTriggers.clear();

    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    for (const off of this.unloadListeners) off();
    this.unloadListeners.length = 0;

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
