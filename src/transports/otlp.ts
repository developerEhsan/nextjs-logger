/**
 * @file transports/otlp.ts
 * OpenTelemetry Protocol (OTLP/HTTP+JSON) logs exporter.
 *
 * ── Why hand-rolled rather than `@opentelemetry/exporter-logs-otlp-http` ──
 * The official exporter is the right answer if you already run the OTel SDK
 * — and if you do, you should use it. This exists for the much more common
 * case: an app that has a collector endpoint (or a vendor that speaks OTLP)
 * and does not want to adopt the entire SDK, its four peer packages and its
 * initialisation order requirements just to ship log lines.
 *
 * OTLP/HTTP with a JSON payload is a documented, stable wire format. What
 * it needs from us is a `ResourceLogs` envelope, `AnyValue`-encoded
 * attributes, and nanosecond timestamps. That is what this file is.
 *
 * ── Severity mapping ─────────────────────────────────────────────────────
 * OTel severity numbers are a 1–24 scale with named bands. The mapping
 * below puts each of this library's levels at the *middle* of its band
 * (e.g. `error` → 17, the base of ERROR) which is what every OTLP consumer
 * expects, rather than at a band edge where filters behave surprisingly.
 *
 * ── Trace correlation is the whole point ─────────────────────────────────
 * `traceId`/`spanId` go into the LogRecord's dedicated fields, not into
 * attributes. That is what makes a backend show these log lines *inside*
 * the span's waterfall rather than as unrelated events that happen to
 * mention a trace ID.
 */

import type { LogEntry, LogLevel } from '../core/types';
import { httpTransport } from './http';
import type { Transport } from './types';

export interface OtlpTransportOptions {
  /**
   * Collector endpoint. If it does not already end in `/v1/logs`, that path
   * is appended — the OTLP spec defines it, and forgetting it produces a
   * 404 that reads like an outage.
   */
  url: string;
  /** Extra headers (`OTEL_EXPORTER_OTLP_HEADERS` equivalents). */
  headers?: Record<string, string>;
  /** `service.name` resource attribute. Required by most backends. */
  serviceName?: string;
  /** Additional resource attributes applied to every record. */
  resourceAttributes?: Record<string, string | number | boolean>;
  minLevel?: LogLevel;
  timeoutMs?: number;
}

/** OTel severity numbers — the base of each named band. */
const SEVERITY_NUMBER: Record<LogLevel, number> = {
  debug: 5,  // DEBUG
  info: 9,   // INFO
  warn: 13,  // WARN
  error: 17, // ERROR
  fatal: 21, // FATAL
};

const SEVERITY_TEXT: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

/**
 * Encode a JavaScript value as an OTLP `AnyValue`.
 *
 * The union is explicit in the protocol — you cannot just hand it a JSON
 * object. Note `intValue` is a **string**: OTLP JSON encodes 64-bit
 * integers as strings because JSON numbers cannot represent them
 * losslessly, and a collector will reject a bare number.
 */
function toAnyValue(value: unknown, depth = 0): Record<string, unknown> {
  if (value === null || value === undefined) return { stringValue: '' };

  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'number':
      return Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
    case 'bigint':
      return { intValue: String(value) };
    default:
      break;
  }

  // Depth-cap: `data` is caller-supplied and can be arbitrarily nested.
  if (depth >= 4) return { stringValue: safeJson(value) };

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => toAnyValue(item, depth + 1)) } };
  }

  if (typeof value === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
          key,
          value: toAnyValue(item, depth + 1),
        })),
      },
    };
  }

  return { stringValue: String(value) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

function attribute(key: string, value: unknown): { key: string; value: Record<string, unknown> } {
  return { key, value: toAnyValue(value) };
}

/**
 * Nanoseconds since the epoch, as a string.
 *
 * OTLP demands nanosecond precision; `Date` gives milliseconds. The
 * remaining six digits are zeros rather than fabricated precision, and the
 * value is built by string concatenation because `ms * 1e6` exceeds
 * `Number.MAX_SAFE_INTEGER` for any real timestamp and would silently lose
 * the low digits.
 */
function toUnixNano(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return `${safeMs}000000`;
}

function toLogRecord(entry: LogEntry): Record<string, unknown> {
  const attributes: { key: string; value: Record<string, unknown> }[] = [];

  if (entry.context.namespace) attributes.push(attribute('logger.name', entry.context.namespace));
  if (entry.context.requestId) attributes.push(attribute('request.id', entry.context.requestId));
  if (entry.context.caller) attributes.push(attribute('code.filepath', entry.context.caller));
  attributes.push(attribute('runtime', entry.context.runtime));

  if (entry.data !== undefined) attributes.push(attribute('data', entry.data));

  if (entry.error) {
    // The semantic-convention names, so a backend's error view finds them.
    attributes.push(attribute('exception.type', entry.error.name));
    attributes.push(attribute('exception.message', entry.error.message));
    if (entry.error.stack) {
      attributes.push(attribute('exception.stacktrace', entry.error.stack.join('\n')));
    }
  }

  const timeUnixNano = toUnixNano(entry.context.timestamp);

  return {
    timeUnixNano,
    // Distinct fields in the protocol: when the event happened vs when it
    // was collected. We only know the one, so both carry it.
    observedTimeUnixNano: timeUnixNano,
    severityNumber: SEVERITY_NUMBER[entry.level],
    severityText: SEVERITY_TEXT[entry.level],
    body: { stringValue: entry.message },
    attributes,
    // First-class fields, not attributes — this is what puts the log line
    // inside the span in a trace waterfall.
    ...(entry.context.traceId ? { traceId: entry.context.traceId } : {}),
    ...(entry.context.spanId ? { spanId: entry.context.spanId } : {}),
  };
}

export function otlpTransport(options: OtlpTransportOptions): Transport {
  const url = options.url.endsWith('/v1/logs')
    ? options.url
    : `${options.url.replace(/\/$/, '')}/v1/logs`;

  const resourceAttributes = [
    attribute('service.name', options.serviceName ?? 'nextjs'),
    ...Object.entries(options.resourceAttributes ?? {}).map(([key, value]) =>
      attribute(key, value),
    ),
  ];

  // Built on `httpTransport` so retry classification, timeouts and
  // permanent-failure reporting are shared rather than reimplemented. The
  // only OTLP-specific parts are the record encoding (`format`) and the
  // `ResourceLogs` wrapper (`envelope`) — the whole batch goes out as one
  // envelope, which is both the efficient encoding and the one collectors
  // expect.
  return httpTransport({
    name: 'otlp',
    url,
    headers: options.headers,
    minLevel: options.minLevel,
    timeoutMs: options.timeoutMs,
    format: toLogRecord,
    envelope: (logRecords) => ({
      resourceLogs: [
        {
          resource: { attributes: resourceAttributes },
          scopeLogs: [
            {
              scope: { name: '@developerehsan/nextjs-logger' },
              logRecords,
            },
          ],
        },
      ],
    }),
  });
}
