/**
 * @file transports/__tests__/pipeline.test.ts
 *
 * The properties worth pinning are the ones a logging pipeline is judged
 * on when something goes wrong: nothing runs on the caller's stack, a slow
 * or broken sink cannot take anything else down, failures are retried and
 * then *counted* rather than silently swallowed, and `flush()` is a real
 * barrier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportPipeline, _resetPipelines } from '../pipeline';
import type { Transport } from '../types';
import type { LogEntry } from '../../core/types';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    message: 'msg',
    context: { runtime: 'server', timestamp: '2026-01-01T00:00:00.000Z', sequence: 0 },
    ...overrides,
  };
}

/** A transport that records batches and can be made to fail. */
function recorder(options: { failTimes?: number; name?: string } = {}) {
  let remainingFailures = options.failTimes ?? 0;
  const batches: LogEntry[][] = [];

  const transport: Transport = {
    name: options.name ?? 'recorder',
    write(entries) {
      if (remainingFailures > 0) {
        remainingFailures--;
        throw new Error('transient');
      }
      batches.push([...entries]);
    },
  };

  return { transport, batches };
}

beforeEach(() => {
  _resetPipelines();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push', () => {
  it('does not deliver on the caller stack', () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([transport], { flushIntervalMs: 10_000 });

    pipeline.push(entry());

    // `log.info()` can be called from a Server Component's render body, so
    // the enqueue path must return having done no I/O at all.
    expect(batches).toHaveLength(0);
  });

  it('still calls plain function transports inline, as they always were', () => {
    const seen: LogEntry[] = [];
    const pipeline = new TransportPipeline([(e) => seen.push(e)]);

    pipeline.push(entry({ message: 'sync' }));

    // Back-compat: the function form is documented as synchronous
    // fire-and-forget, and something is presumably relying on that.
    expect(seen.map((e) => e.message)).toEqual(['sync']);
  });

  it('delivers as one batch once maxBatchSize is reached', async () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([transport], {
      maxBatchSize: 3,
      flushIntervalMs: 10_000,
    });

    for (let i = 0; i < 3; i++) pipeline.push(entry({ message: `m${i}` }));
    await pipeline.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.message)).toEqual(['m0', 'm1', 'm2']);
  });

  it('isolates a throwing function transport from everything else', () => {
    const seen: LogEntry[] = [];
    const pipeline = new TransportPipeline([
      () => {
        throw new Error('broken sink');
      },
      (e) => seen.push(e),
    ]);

    expect(() => pipeline.push(entry())).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('filtering', () => {
  it('honours a per-transport minLevel', async () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([{ ...transport, minLevel: 'error' }]);

    pipeline.push(entry({ level: 'info' }));
    pipeline.push(entry({ level: 'error', message: 'kept' }));
    await pipeline.flush();

    expect(batches.flat().map((e) => e.message)).toEqual(['kept']);
  });

  it('honours a filter predicate', async () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([
      { ...transport, filter: (e) => e.context.namespace === 'keep' },
    ]);

    pipeline.push(entry({ context: { ...entry().context, namespace: 'keep' } }));
    pipeline.push(entry({ context: { ...entry().context, namespace: 'drop' } }));
    await pipeline.flush();

    expect(batches.flat()).toHaveLength(1);
  });

  it('keeps the entry when the filter itself throws', async () => {
    // Losing logs to a buggy predicate is the worse of the two failures.
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([
      {
        ...transport,
        filter: () => {
          throw new Error('bad predicate');
        },
      },
    ]);

    pipeline.push(entry());
    await pipeline.flush();
    expect(batches.flat()).toHaveLength(1);
  });
});

describe('retry', () => {
  it('retries a failing batch and eventually delivers it', async () => {
    const { transport, batches } = recorder({ failTimes: 2 });
    const pipeline = new TransportPipeline([transport], { baseRetryDelayMs: 1 });

    pipeline.push(entry({ message: 'eventually' }));
    await pipeline.flush();

    expect(batches.flat().map((e) => e.message)).toEqual(['eventually']);
    expect(pipeline.getStats()[0]).toMatchObject({ retried: 2, dropped: 0, written: 1 });
  });

  it('gives up after maxRetries and counts the drop', async () => {
    const { transport } = recorder({ failTimes: Number.MAX_SAFE_INTEGER });
    const pipeline = new TransportPipeline([transport], {
      maxRetries: 2,
      baseRetryDelayMs: 1,
    });

    pipeline.push(entry());
    pipeline.push(entry());
    await pipeline.flush();

    // Counted, not silent — a pipeline that loses data without saying so is
    // worse than one that refuses it loudly.
    expect(pipeline.getStats()[0]).toMatchObject({ dropped: 2, written: 0 });
  });

  it('does not sleep through backoff on shutdown', async () => {
    const { transport } = recorder({ failTimes: Number.MAX_SAFE_INTEGER });
    const pipeline = new TransportPipeline([transport], {
      maxRetries: 3,
      // A delay long enough that sleeping through it would blow the test
      // timeout — the platform may suspend the instance mid-wait, so
      // shutdown retries must be back-to-back.
      baseRetryDelayMs: 60_000,
    });

    pipeline.push(entry());
    const started = Date.now();
    await pipeline.close();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never runs two overlapping writes for one transport', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const transport: Transport = {
      name: 'slow',
      async write() {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
      },
    };

    const pipeline = new TransportPipeline([transport], { maxBatchSize: 1 });
    for (let i = 0; i < 5; i++) pipeline.push(entry());
    await pipeline.flush();

    expect(maxConcurrent).toBe(1);
  });

  it('lets a fast transport proceed while a slow one is stuck', async () => {
    const fast = recorder({ name: 'fast' });
    let releaseSlow: (() => void) | undefined;
    const slow: Transport = {
      name: 'slow',
      write: () => new Promise<void>((resolve) => { releaseSlow = resolve; }),
    };

    const pipeline = new TransportPipeline([slow, fast.transport], { maxBatchSize: 1 });
    pipeline.push(entry({ message: 'a' }));

    // Let the fast transport's write settle without touching the slow one.
    await Promise.resolve();
    await Promise.resolve();

    expect(fast.batches.flat().map((e) => e.message)).toEqual(['a']);
    releaseSlow?.();
  });
});

describe('backpressure', () => {
  it('drops oldest entries past maxBufferSize and counts them', async () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([transport], {
      maxBufferSize: 3,
      maxBatchSize: 1_000,
      flushIntervalMs: 10_000,
    });

    for (let i = 0; i < 6; i++) pipeline.push(entry({ message: `m${i}` }));
    await pipeline.flush();

    // Newest kept: they describe whatever is going wrong right now.
    expect(batches.flat().map((e) => e.message)).toEqual(['m3', 'm4', 'm5']);
    expect(pipeline.getStats()[0]!.dropped).toBe(3);
  });
});

describe('flush and close', () => {
  it('flush waits for delivery', async () => {
    let delivered = false;
    const pipeline = new TransportPipeline([
      {
        name: 'async',
        async write() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          delivered = true;
        },
      },
    ]);

    pipeline.push(entry());
    await pipeline.flush();

    // The property that makes `await flushTransports()` meaningful before
    // a serverless handler returns.
    expect(delivered).toBe(true);
  });

  it('calls the transport flush and close hooks', async () => {
    const calls: string[] = [];
    const pipeline = new TransportPipeline([
      {
        name: 'lifecycle',
        write: () => void calls.push('write'),
        flush: () => void calls.push('flush'),
        close: () => void calls.push('close'),
      },
    ]);

    pipeline.push(entry());
    await pipeline.close();

    expect(calls).toEqual(['write', 'flush', 'close']);
  });

  it('contains a throwing close hook', async () => {
    const pipeline = new TransportPipeline([
      {
        name: 'hostile',
        write: () => {},
        close: () => {
          throw new Error('close failed');
        },
      },
    ]);

    await expect(pipeline.close()).resolves.toBeUndefined();
  });

  it('ignores pushes after close', async () => {
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([transport]);
    await pipeline.close();

    pipeline.push(entry());
    await pipeline.flush();

    expect(batches).toHaveLength(0);
  });
});

describe('interval flush', () => {
  it('ships a partial batch on the timer', async () => {
    vi.useFakeTimers();
    const { transport, batches } = recorder();
    const pipeline = new TransportPipeline([transport], {
      maxBatchSize: 100,
      flushIntervalMs: 50,
    });

    pipeline.push(entry({ message: 'lonely' }));
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60);

    expect(batches.flat().map((e) => e.message)).toEqual(['lonely']);
  });
});
