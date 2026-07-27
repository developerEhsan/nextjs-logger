/**
 * @file transports/http.ts
 * Generic batching HTTP sink, plus presets for the log vendors people
 * actually use.
 *
 * ── One transport, several vendors ───────────────────────────────────────
 * Datadog, Axiom, Better Stack and most others accept the same thing: a
 * POST of a JSON array (or NDJSON) of objects, authenticated by a header.
 * They differ in the URL, the header name, and which field they expect the
 * timestamp and severity in. That is a *configuration* difference, not an
 * architectural one, so there is one implementation and thin presets over
 * it — a separate hand-written client per vendor would be four times the
 * code and four times the surface for a bug that only shows up in
 * production.
 *
 * ── Retry semantics are the pipeline's, not ours ─────────────────────────
 * `write()` throws on a *retryable* failure and returns on a permanent one,
 * which is the contract in `transports/types.ts`. Concretely:
 *   • network error, timeout, 408, 429, any 5xx  → throw (retry)
 *   • any other 4xx                              → return (drop)
 * A 401 from a bad API key or a 400 from a malformed payload will never
 * succeed on retry; retrying them just burns the buffer and hammers the
 * vendor while the real problem goes unnoticed. `onPermanentFailure` exists
 * so those are not *silently* dropped.
 */

import type { LogEntry, LogLevel } from '../core/types';
import type { Transport } from './types';

export interface HttpTransportOptions {
  /** Ingest endpoint. */
  url: string;
  /** Extra headers — typically the API key. */
  headers?: Record<string, string>;
  /** `json` posts an array; `ndjson` posts newline-delimited objects. */
  encoding?: 'json' | 'ndjson';
  /** Map an entry to the vendor's expected object shape. */
  format?: (entry: LogEntry) => unknown;
  /**
   * Wrap the formatted batch into the final request body.
   *
   * Defaults to sending the array itself, which is what every vendor
   * preset here wants. OTLP is the exception — it requires a
   * `{ resourceLogs: [...] }` envelope — and this hook is how it reuses
   * everything else in this file instead of reimplementing retry
   * classification, timeouts and failure reporting.
   *
   * Ignored when `encoding` is `'ndjson'`, which has no envelope by
   * definition.
   */
  envelope?: (formatted: unknown[]) => unknown;
  /** Abort a request after this long. Default 10s. */
  timeoutMs?: number;
  /** Only ship entries at this level or above. */
  minLevel?: LogLevel;
  /** Name shown in `getTransportStats()`. */
  name?: string;
  /**
   * Called when a batch is dropped for a permanent reason (a 4xx that is
   * not 408/429). Without this, a wrong API key looks exactly like
   * everything working — the request is made, nothing arrives, nobody is
   * told. Defaults to a single `console.warn`.
   */
  onPermanentFailure?: (status: number, body: string, entries: LogEntry[]) => void;
}

/**
 * The default wire shape: a flat object with the field names most vendors
 * and most log-query languages assume. Flattening `context` matters —
 * nesting `traceId` under `context` means every trace-correlation feature
 * in every vendor needs custom configuration to find it.
 */
export function defaultHttpFormat(entry: LogEntry): Record<string, unknown> {
  return {
    timestamp: entry.context.timestamp,
    level: entry.level,
    message: entry.message,
    ...(entry.context.namespace ? { namespace: entry.context.namespace } : {}),
    ...(entry.context.requestId ? { requestId: entry.context.requestId } : {}),
    ...(entry.context.traceId ? { trace_id: entry.context.traceId } : {}),
    ...(entry.context.spanId ? { span_id: entry.context.spanId } : {}),
    ...(entry.context.caller ? { caller: entry.context.caller } : {}),
    runtime: entry.context.runtime,
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    ...(entry.error
      ? {
          error: {
            kind: entry.error.name,
            message: entry.error.message,
            // Vendors expect a single stack string; the array form exists
            // for terminal rendering. Joining is safe here because this is
            // JSON, not a line-oriented terminal.
            stack: entry.error.stack?.join('\n'),
            ...(entry.error.properties ?? {}),
          },
        }
      : {}),
  };
}

/** A status the remote might succeed at if we ask again. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function httpTransport(options: HttpTransportOptions): Transport {
  const {
    url,
    headers = {},
    encoding = 'json',
    format = defaultHttpFormat,
    envelope,
    timeoutMs = 10_000,
    minLevel,
    name,
    onPermanentFailure = defaultPermanentFailureHandler,
  } = options;

  return {
    name: name ?? `http(${safeHost(url)})`,
    minLevel,

    async write(entries: LogEntry[]): Promise<void> {
      const payload = entries.map(format);
      const body =
        encoding === 'ndjson'
          ? payload.map((item) => JSON.stringify(item)).join('\n')
          : JSON.stringify(envelope ? envelope(payload) : payload);

      // `AbortSignal.timeout` is available on every runtime this package
      // targets and, unlike a manual `setTimeout` + `AbortController`,
      // leaves no timer behind when the request finishes first.
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': encoding === 'ndjson' ? 'application/x-ndjson' : 'application/json',
          ...headers,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        // Log delivery must never be served from, or written to, a cache.
        cache: 'no-store',
        // A rejected batch is retried by the pipeline; keeping the
        // connection alive across batches is what makes that cheap.
        keepalive: false,
      });

      if (response.ok) return;

      if (isRetryable(response.status)) {
        // Thrown → the pipeline retries with backoff.
        throw new Error(`[logger] ${url} responded ${response.status}`);
      }

      // Permanent. Read the body for the report, but never let a failure to
      // read it turn a permanent error into a retry loop.
      let responseBody = '';
      try {
        responseBody = (await response.text()).slice(0, 512);
      } catch {
        // ignore
      }
      onPermanentFailure(response.status, responseBody, entries);
    },
  };
}

/**
 * Report a permanently-dropped batch once, loudly, on the process's own
 * console — not through the logger, which would be a recursion hazard.
 */
let permanentFailureReported = false;

function defaultPermanentFailureHandler(status: number, body: string): void {
  if (permanentFailureReported) return;
  permanentFailureReported = true;
  console.warn(
    `[logger] Log transport rejected permanently (HTTP ${status}) — dropping ` +
      `these and future batches until the endpoint accepts them. This usually ` +
      `means a bad API key or an unexpected payload shape. Response: ${body}\n` +
      `(further occurrences of this warning are suppressed)`,
  );
}

/** Host only — an ingest URL routinely carries the API key in its path. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'remote';
  }
}

// ─── Vendor presets ──────────────────────────────────────────────────────

export interface VendorTransportOptions {
  apiKey: string;
  /** Attached to every entry as the service/source name. */
  service?: string;
  minLevel?: LogLevel;
}

/**
 * Datadog Logs intake.
 *
 * @param site Your Datadog site — `datadoghq.com` (US1, default),
 *             `datadoghq.eu`, `us3.datadoghq.com`, etc. Sending to the
 *             wrong site is a silent 403, so it is an explicit parameter
 *             rather than something guessed.
 */
export function datadogTransport(
  options: VendorTransportOptions & { site?: string; tags?: string },
): Transport {
  const site = options.site ?? 'datadoghq.com';
  return httpTransport({
    name: 'datadog',
    url: `https://http-intake.logs.${site}/api/v2/logs`,
    headers: { 'DD-API-KEY': options.apiKey },
    minLevel: options.minLevel,
    format: (entry) => ({
      ...defaultHttpFormat(entry),
      // Datadog keys severity off `status`, not `level`.
      status: entry.level === 'fatal' ? 'critical' : entry.level,
      ddsource: 'nextjs',
      service: options.service ?? 'nextjs',
      ...(options.tags ? { ddtags: options.tags } : {}),
    }),
  });
}

/** Axiom dataset ingest. */
export function axiomTransport(
  options: VendorTransportOptions & { dataset: string; domain?: string },
): Transport {
  const domain = options.domain ?? 'api.axiom.co';
  return httpTransport({
    name: 'axiom',
    url: `https://${domain}/v1/datasets/${encodeURIComponent(options.dataset)}/ingest`,
    headers: { authorization: `Bearer ${options.apiKey}` },
    minLevel: options.minLevel,
    format: (entry) => ({
      // Axiom takes the event time from `_time`.
      _time: entry.context.timestamp,
      ...defaultHttpFormat(entry),
      ...(options.service ? { service: options.service } : {}),
    }),
  });
}

/** Better Stack (Logtail) ingest. */
export function betterStackTransport(
  options: VendorTransportOptions & { endpoint?: string },
): Transport {
  return httpTransport({
    name: 'better-stack',
    url: options.endpoint ?? 'https://in.logs.betterstack.com',
    headers: { authorization: `Bearer ${options.apiKey}` },
    minLevel: options.minLevel,
    format: (entry) => ({
      ...defaultHttpFormat(entry),
      // Better Stack expects `dt` for the event time.
      dt: entry.context.timestamp,
      ...(options.service ? { service: options.service } : {}),
    }),
  });
}
