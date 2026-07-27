/**
 * @file utils/trace-context.ts
 * W3C Trace Context correlation — stamping `traceId`/`spanId` on every
 * server-side entry so log lines join up with distributed traces.
 *
 * ── Why this is worth having ─────────────────────────────────────────────
 * `requestId` (see `utils/request-context.ts`) correlates log lines within
 * one process. It stops at the process boundary: the moment a request fans
 * out to another service, the correlation is gone. `traceparent` is the
 * standard that does not stop there, and it is already flowing through most
 * production Next.js deployments — Vercel, most gateways, and the OTel SDK
 * all propagate it. Reading it costs one header parse and makes this
 * library's output joinable with everyone else's.
 *
 * ── Two sources, in priority order ───────────────────────────────────────
 * ① **An active OpenTelemetry span**, if the OTel SDK is installed. This is
 *    the authoritative source when it exists: it reflects the *current*
 *    span, including ones the app created itself, not just the inbound
 *    request's. It is read through `globalThis` rather than by importing
 *    `@opentelemetry/api`, so this package gains no dependency, optional or
 *    otherwise — the SDK registers its API on a well-known global symbol
 *    precisely so that instrumentation can find it without linking against
 *    it, and that is exactly the situation here.
 * ② **The `traceparent` header**, parsed and stored in the request context.
 *    Works with no SDK at all, which is the common case for an app that
 *    just wants its logs correlated with a gateway's traces.
 *
 * Both are best-effort. No trace context means no `traceId` field, and
 * nothing else changes.
 */

/** A parsed W3C `traceparent`. */
export interface TraceContext {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters — the *parent* span, from the header. */
  spanId: string;
  /** Whether the upstream caller sampled this trace. */
  sampled: boolean;
}

/**
 * `version-traceId-spanId-flags`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
 *
 * The all-zero trace and span IDs are explicitly invalid per the spec, and
 * they show up in practice from misconfigured propagators — accepting them
 * would attach a meaningless `00000000…` to every line.
 */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/** Parse a `traceparent` header value. Returns `null` if it is not valid. */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;

  const match = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!match) return null;

  const [, version, traceId, spanId, flags] = match;

  // `ff` is reserved as invalid. Any other version is forward-compatible:
  // the spec requires parsers to accept unknown versions whose first four
  // fields match, so a future `01-…` still correlates correctly.
  if (version === 'ff') return null;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;

  return {
    traceId: traceId!,
    spanId: spanId!,
    sampled: (parseInt(flags!, 16) & 0x01) === 1,
  };
}

/**
 * Read the active OpenTelemetry span's context, if an SDK is registered.
 *
 * The OTel JS API stores its global registry at
 * `globalThis[Symbol.for('opentelemetry.js.api.1')]`. Everything below is
 * defensive duck-typing against that: the shape has been stable across the
 * 1.x line, but this must degrade to `null` rather than throw if it ever
 * changes, and it must not assume any part of the chain exists.
 */
export function getActiveSpanContext(): { traceId: string; spanId: string } | null {
  try {
    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for('opentelemetry.js.api.1')
    ] as
      | {
          trace?: {
            getSpan?: (context: unknown) => { spanContext?: () => unknown } | undefined;
          };
          context?: { active?: () => unknown };
        }
      | undefined;

    const active = registry?.context?.active?.();
    if (active === undefined) return null;

    const span = registry?.trace?.getSpan?.(active);
    const spanContext = span?.spanContext?.() as
      | { traceId?: unknown; spanId?: unknown }
      | undefined;

    const traceId = spanContext?.traceId;
    const spanId = spanContext?.spanId;

    if (
      typeof traceId !== 'string' ||
      typeof spanId !== 'string' ||
      traceId === INVALID_TRACE_ID ||
      !traceId
    ) {
      return null;
    }

    return { traceId, spanId };
  } catch {
    return null;
  }
}

/**
 * Build a `traceparent` header value for an outgoing request, so a service
 * this app calls joins the same trace.
 *
 * Provided because having parsed the header, not being able to forward it
 * is a strange half-feature — and hand-rolling the format is exactly the
 * kind of thing that produces the all-zeros IDs rejected above.
 */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/**
 * Extract trace context from an incoming request's headers.
 * Accepts a `Headers` instance or any plain header record.
 */
export function traceContextFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): TraceContext | null {
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('traceparent')
      : (headers as Record<string, string | string[] | undefined>)['traceparent'];

  return parseTraceparent(Array.isArray(raw) ? raw[0] : raw);
}
