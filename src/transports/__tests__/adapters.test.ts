/**
 * @file transports/__tests__/adapters.test.ts
 *
 * The shipped sinks. The highest-value assertions here are the ones about
 * *retry classification* (a 401 must not be retried forever) and about the
 * two encodings that are easy to get subtly, silently wrong — OTLP's
 * `AnyValue`/nanosecond rules, and Pino vs Winston's reversed argument
 * order.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { httpTransport, datadogTransport, axiomTransport, betterStackTransport } from '../http';
import { otlpTransport } from '../otlp';
import { fileTransport } from '../file';
import { pinoTransport, winstonTransport } from '../bridge';
import type { LogEntry } from '../../core/types';

const workDir = mkdtempSync(join(tmpdir(), 'logger-transports-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    message: 'hello',
    context: {
      runtime: 'server',
      timestamp: '2026-01-01T10:00:00.000Z',
      sequence: 0,
      ...overrides.context,
    },
    ...overrides,
  } as LogEntry;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub `fetch`, capturing requests and replaying scripted responses. */
function stubFetch(responses: { status: number; body?: string }[] = [{ status: 202 }]) {
  const requests: CapturedRequest[] = [];
  let index = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      requests.push({
        url,
        headers: init.headers as Record<string, string>,
        body: tryParse(raw),
      });
      const response = responses[Math.min(index++, responses.length - 1)]!;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => response.body ?? '',
      } as Response;
    }),
  );

  return requests;
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ─── httpTransport ───────────────────────────────────────────────────────

describe('httpTransport', () => {
  it('posts the batch as a JSON array', async () => {
    const requests = stubFetch();
    await httpTransport({ url: 'https://logs.test/ingest' }).write(
      [entry({ message: 'one' }), entry({ message: 'two' })],
      'batch',
    );

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body as { message: string }[];
    expect(body.map((item) => item.message)).toEqual(['one', 'two']);
  });

  it('supports NDJSON', async () => {
    const requests = stubFetch();
    await httpTransport({ url: 'https://logs.test/ingest', encoding: 'ndjson' }).write(
      [entry({ message: 'a' }), entry({ message: 'b' })],
      'batch',
    );

    const lines = String(requests[0]!.body).split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('a');
  });

  it('flattens trace IDs to the field names vendors look for', async () => {
    const requests = stubFetch();
    await httpTransport({ url: 'https://logs.test/ingest' }).write(
      [
        entry({
          context: {
            runtime: 'server',
            timestamp: '2026-01-01T10:00:00.000Z',
            sequence: 0,
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
          },
        }),
      ],
      'batch',
    );

    // Nested under `context` would mean every vendor needs custom config to
    // find them, which defeats the point of correlating at all.
    const body = (requests[0]!.body as Record<string, unknown>[])[0]!;
    expect(body.trace_id).toBe('a'.repeat(32));
    expect(body.span_id).toBe('b'.repeat(16));
  });

  /**
   * The classification that matters. The pipeline retries a throw, so a
   * throw for a permanent 4xx would mean hammering the vendor forever with
   * a payload it will never accept, while the real problem — usually a bad
   * API key — stays invisible.
   */
  it('throws on retryable statuses so the pipeline retries', async () => {
    for (const status of [408, 429, 500, 503]) {
      stubFetch([{ status }]);
      await expect(
        httpTransport({ url: 'https://logs.test/x' }).write([entry()], 'batch'),
      ).rejects.toThrow();
    }
  });

  it('does not throw on a permanent 4xx, and reports it instead', async () => {
    stubFetch([{ status: 401, body: 'bad key' }]);
    const onPermanentFailure = vi.fn();

    await expect(
      httpTransport({ url: 'https://logs.test/x', onPermanentFailure }).write(
        [entry()],
        'batch',
      ),
    ).resolves.toBeUndefined();

    expect(onPermanentFailure).toHaveBeenCalledWith(401, 'bad key', expect.any(Array));
  });

  it('propagates a network error as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    await expect(
      httpTransport({ url: 'https://logs.test/x' }).write([entry()], 'batch'),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('names itself by host, never by the full URL', async () => {
    // Ingest URLs routinely carry the API key in the path, and the name
    // shows up in `getTransportStats()`.
    const transport = httpTransport({ url: 'https://in.logs.test/secret-key-path' });
    expect(transport.name).toBe('http(in.logs.test)');
    expect(transport.name).not.toContain('secret-key-path');
  });
});

// ─── Vendor presets ──────────────────────────────────────────────────────

describe('vendor presets', () => {
  it('datadog sends status, ddsource and the API key header', async () => {
    const requests = stubFetch();
    await datadogTransport({ apiKey: 'dd-key', service: 'shop' }).write(
      [entry({ level: 'fatal' })],
      'batch',
    );

    expect(requests[0]!.url).toContain('http-intake.logs.datadoghq.com');
    expect(requests[0]!.headers['DD-API-KEY']).toBe('dd-key');
    const body = (requests[0]!.body as Record<string, unknown>[])[0]!;
    // Datadog has no `fatal`; `critical` is its equivalent.
    expect(body.status).toBe('critical');
    expect(body.ddsource).toBe('nextjs');
    expect(body.service).toBe('shop');
  });

  it('datadog honours a non-default site', async () => {
    const requests = stubFetch();
    await datadogTransport({ apiKey: 'k', site: 'datadoghq.eu' }).write([entry()], 'batch');
    expect(requests[0]!.url).toContain('datadoghq.eu');
  });

  it('axiom targets the dataset and sets _time', async () => {
    const requests = stubFetch();
    await axiomTransport({ apiKey: 'ax', dataset: 'my logs' }).write([entry()], 'batch');

    expect(requests[0]!.url).toBe('https://api.axiom.co/v1/datasets/my%20logs/ingest');
    expect(requests[0]!.headers.authorization).toBe('Bearer ax');
    expect((requests[0]!.body as Record<string, unknown>[])[0]!._time).toBe(
      '2026-01-01T10:00:00.000Z',
    );
  });

  it('better stack sets dt', async () => {
    const requests = stubFetch();
    await betterStackTransport({ apiKey: 'bs' }).write([entry()], 'batch');
    expect((requests[0]!.body as Record<string, unknown>[])[0]!.dt).toBe(
      '2026-01-01T10:00:00.000Z',
    );
  });
});

// ─── OTLP ────────────────────────────────────────────────────────────────

describe('otlpTransport', () => {
  it('wraps the batch in one ResourceLogs envelope, not an array', async () => {
    const requests = stubFetch();
    await otlpTransport({ url: 'https://collector.test', serviceName: 'shop' }).write(
      [entry({ message: 'one' }), entry({ message: 'two' })],
      'batch',
    );

    expect(requests[0]!.url).toBe('https://collector.test/v1/logs');
    const body = requests[0]!.body as {
      resourceLogs: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeLogs: { logRecords: Record<string, unknown>[] }[];
      }[];
    };

    expect(body.resourceLogs).toHaveLength(1);
    expect(body.resourceLogs[0]!.resource.attributes[0]).toEqual({
      key: 'service.name',
      value: { stringValue: 'shop' },
    });
    // Both records in the one envelope — that is the efficient encoding and
    // the one collectors expect.
    expect(body.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
  });

  it('does not double up the /v1/logs path', async () => {
    const requests = stubFetch();
    await otlpTransport({ url: 'https://collector.test/v1/logs' }).write([entry()], 'batch');
    expect(requests[0]!.url).toBe('https://collector.test/v1/logs');
  });

  it('encodes severity, nanosecond timestamps and AnyValue attributes', async () => {
    const requests = stubFetch();
    await otlpTransport({ url: 'https://collector.test' }).write(
      [entry({ level: 'error', data: { count: 3, ratio: 0.5, ok: true, name: 'x' } })],
      'batch',
    );

    const record = (requests[0]!.body as any).resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.severityNumber).toBe(17); // ERROR band base
    expect(record.severityText).toBe('ERROR');
    // Nanoseconds, as a string — a number would lose the low digits, and
    // the protocol requires the string form for 64-bit values.
    expect(record.timeUnixNano).toBe(`${Date.parse('2026-01-01T10:00:00.000Z')}000000`);
    expect(typeof record.timeUnixNano).toBe('string');
    expect(record.body).toEqual({ stringValue: 'hello' });

    const data = record.attributes.find((a: any) => a.key === 'data');
    const values = data.value.kvlistValue.values as { key: string; value: unknown }[];
    // Integers are strings, floats are doubles — the protocol's rule, and
    // a collector rejects a bare number for intValue.
    expect(values.find((v) => v.key === 'count')!.value).toEqual({ intValue: '3' });
    expect(values.find((v) => v.key === 'ratio')!.value).toEqual({ doubleValue: 0.5 });
    expect(values.find((v) => v.key === 'ok')!.value).toEqual({ boolValue: true });
    expect(values.find((v) => v.key === 'name')!.value).toEqual({ stringValue: 'x' });
  });

  it('puts trace IDs in the record fields, not in attributes', async () => {
    const requests = stubFetch();
    await otlpTransport({ url: 'https://collector.test' }).write(
      [
        entry({
          context: {
            runtime: 'server',
            timestamp: '2026-01-01T10:00:00.000Z',
            sequence: 0,
            traceId: 'c'.repeat(32),
            spanId: 'd'.repeat(16),
          },
        }),
      ],
      'batch',
    );

    const record = (requests[0]!.body as any).resourceLogs[0].scopeLogs[0].logRecords[0];
    // First-class fields are what make a backend show the log line inside
    // the span's waterfall.
    expect(record.traceId).toBe('c'.repeat(32));
    expect(record.spanId).toBe('d'.repeat(16));
  });

  it('uses the exception semantic conventions for errors', async () => {
    const requests = stubFetch();
    await otlpTransport({ url: 'https://collector.test' }).write(
      [entry({ error: { name: 'TypeError', message: 'boom', stack: ['at a', 'at b'] } })],
      'batch',
    );

    const record = (requests[0]!.body as any).resourceLogs[0].scopeLogs[0].logRecords[0];
    const byKey = (key: string) =>
      record.attributes.find((a: any) => a.key === key)?.value.stringValue;

    expect(byKey('exception.type')).toBe('TypeError');
    expect(byKey('exception.message')).toBe('boom');
    expect(byKey('exception.stacktrace')).toBe('at a\nat b');
  });
});

// ─── File ────────────────────────────────────────────────────────────────

describe('fileTransport', () => {
  it('appends one JSON object per line', async () => {
    const path = join(workDir, 'basic/app.log');
    await fileTransport({ path }).write(
      [entry({ message: 'first' }), entry({ message: 'second' })],
      'batch',
    );

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).msg).toBe('first');
  });

  it('keeps one-object-per-line even when the message contains newlines', async () => {
    const path = join(workDir, 'newlines/app.log');
    await fileTransport({ path }).write([entry({ message: 'a\nb\nc' })], 'batch');

    // JSON escaping is what preserves the invariant every log tool relies on.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('a\nb\nc');
  });

  it('creates missing parent directories', async () => {
    const path = join(workDir, 'deeply/nested/dir/app.log');
    await fileTransport({ path }).write([entry()], 'batch');
    expect(existsSync(path)).toBe(true);
  });

  it('rotates once the file exceeds maxSizeBytes', async () => {
    const path = join(workDir, 'rotate/app.log');
    const transport = fileTransport({ path, maxSizeBytes: 100, maxFiles: 2 });

    await transport.write([entry({ message: 'x'.repeat(200) })], 'batch');
    // Over the threshold now, so the next write rotates first.
    await transport.write([entry({ message: 'after-rotation' })], 'batch');

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('after-rotation');
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('x'.repeat(200));
  });

  it('discards generations past maxFiles', async () => {
    const path = join(workDir, 'prune/app.log');
    const transport = fileTransport({ path, maxSizeBytes: 10, maxFiles: 2 });

    for (let i = 0; i < 5; i++) {
      await transport.write([entry({ message: `gen-${i}` })], 'batch');
    }

    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it('never rotates when maxSizeBytes is 0', async () => {
    const path = join(workDir, 'norotate/app.log');
    const transport = fileTransport({ path, maxSizeBytes: 0 });
    await transport.write([entry({ message: 'y'.repeat(500) })], 'batch');
    await transport.write([entry({ message: 'still here' })], 'batch');

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('still here');
  });

  it('lets a real write failure reach the pipeline', async () => {
    // Retrying a full disk is right; swallowing it is not.
    const path = join(workDir, 'blocked');
    writeFileSync(path, 'i am a file, not a directory');

    await expect(
      fileTransport({ path: join(path, 'app.log') }).write([entry()], 'batch'),
    ).rejects.toThrow();
  });

  it('accepts a custom format', async () => {
    const path = join(workDir, 'custom/app.log');
    await fileTransport({ path, format: (e) => `${e.level.toUpperCase()} ${e.message}` }).write(
      [entry()],
      'batch',
    );
    expect(readFileSync(path, 'utf8').trim()).toBe('INFO hello');
  });
});

// ─── Bridges ─────────────────────────────────────────────────────────────

describe('pino / winston bridges', () => {
  function fakeLogger() {
    const calls: { level: string; args: unknown[] }[] = [];
    const make = (level: string) => (...args: unknown[]) => void calls.push({ level, args });
    return {
      calls,
      logger: {
        debug: make('debug'),
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
      } as never,
    };
  }

  it('pino gets (payload, message) — object first', async () => {
    const { logger, calls } = fakeLogger();
    await pinoTransport(logger).write([entry({ message: 'hi', data: { a: 1 } })], 'batch');

    expect(calls[0]!.level).toBe('info');
    expect(calls[0]!.args[0]).toMatchObject({ data: { a: 1 } });
    expect(calls[0]!.args[1]).toBe('hi');
  });

  it('winston gets (message, meta) — the reverse', async () => {
    // Getting this backwards does not throw; it produces `[object Object]`
    // as the message, forever, in production. Hence two explicit factories.
    const { logger, calls } = fakeLogger();
    await winstonTransport(logger).write([entry({ message: 'hi', data: { a: 1 } })], 'batch');

    expect(calls[0]!.args[0]).toBe('hi');
    expect(calls[0]!.args[1]).toMatchObject({ data: { a: 1 } });
  });

  it('maps fatal onto error when the target has no fatal level', async () => {
    const { logger, calls } = fakeLogger();
    await pinoTransport(logger).write([entry({ level: 'fatal' })], 'batch');

    expect(calls[0]!.level).toBe('error');
    // The original level survives in the payload, so nothing is lost.
    expect(calls[0]!.args[0]).toMatchObject({ level: 'fatal' });
  });

  it('uses fatal when the target has it', async () => {
    const calls: string[] = [];
    const target = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => void calls.push('error'),
      fatal: () => void calls.push('fatal'),
    } as never;

    await pinoTransport(target).write([entry({ level: 'fatal' })], 'batch');
    expect(calls).toEqual(['fatal']);
  });

  it('shapes the error as pino serialisers expect', async () => {
    const { logger, calls } = fakeLogger();
    await pinoTransport(logger).write(
      [entry({ level: 'error', error: { name: 'TypeError', message: 'boom', stack: ['at a'] } })],
      'batch',
    );

    expect(calls[0]!.args[0]).toMatchObject({
      err: { type: 'TypeError', message: 'boom', stack: 'at a' },
    });
  });
});
