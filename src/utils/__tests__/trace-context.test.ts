/**
 * @file utils/__tests__/trace-context.test.ts
 *
 * Trace correlation is only useful if the IDs are right, so most of these
 * are about *rejecting* the wrong thing: an all-zero ID from a
 * misconfigured propagator would otherwise be stamped on every line and
 * quietly correlate everything with everything.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  traceContextFromHeaders,
  getActiveSpanContext,
} from '../trace-context';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('parses a valid sampled header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
  });

  it('reads the sampled flag from the low bit', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(false);
    // Other flag bits set, sampled bit clear.
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-02`)?.sampled).toBe(false);
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.sampled).toBe(true);
  });

  it('accepts a future version, as the spec requires', () => {
    // Forward compatibility is mandated: a parser must accept an unknown
    // version whose first four fields still match.
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)?.traceId).toBe(TRACE_ID);
  });

  it('rejects the reserved ff version', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects all-zero IDs', () => {
    // Explicitly invalid per spec, and produced in practice by a
    // misconfigured propagator — stamping them would correlate every
    // request in the system with every other one.
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-tooshort-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeNull();
    // Non-hex.
    expect(parseTraceparent(`00-${'z'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
  });

  it('normalises case and surrounding whitespace', () => {
    expect(parseTraceparent(`  00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01 `)?.traceId).toBe(
      TRACE_ID,
    );
  });
});

describe('formatTraceparent', () => {
  it('round-trips', () => {
    const header = `00-${TRACE_ID}-${SPAN_ID}-01`;
    expect(formatTraceparent(parseTraceparent(header)!)).toBe(header);
  });

  it('encodes an unsampled trace', () => {
    expect(
      formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false }),
    ).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });
});

describe('traceContextFromHeaders', () => {
  it('reads from a Headers instance', () => {
    const headers = new Headers({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` });
    expect(traceContextFromHeaders(headers)?.traceId).toBe(TRACE_ID);
  });

  it('reads from a plain record', () => {
    expect(
      traceContextFromHeaders({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })?.traceId,
    ).toBe(TRACE_ID);
  });

  it('takes the first value of a repeated header', () => {
    expect(
      traceContextFromHeaders({ traceparent: [`00-${TRACE_ID}-${SPAN_ID}-01`, 'junk'] })
        ?.traceId,
    ).toBe(TRACE_ID);
  });

  it('returns null when the header is absent', () => {
    expect(traceContextFromHeaders(new Headers())).toBeNull();
  });
});

describe('getActiveSpanContext', () => {
  const OTEL_KEY = Symbol.for('opentelemetry.js.api.1');

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[OTEL_KEY];
  });

  it('returns null with no SDK registered', () => {
    expect(getActiveSpanContext()).toBeNull();
  });

  it('reads the active span through the global API registry', () => {
    // Duck-typed against the shape the OTel JS SDK registers, so this
    // package needs no dependency on @opentelemetry/api at all.
    (globalThis as Record<symbol, unknown>)[OTEL_KEY] = {
      context: { active: () => ({}) },
      trace: {
        getSpan: () => ({ spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID }) }),
      },
    };

    expect(getActiveSpanContext()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('returns null when there is no active span', () => {
    (globalThis as Record<symbol, unknown>)[OTEL_KEY] = {
      context: { active: () => ({}) },
      trace: { getSpan: () => undefined },
    };
    expect(getActiveSpanContext()).toBeNull();
  });

  it('returns null for an invalid all-zero span context', () => {
    (globalThis as Record<symbol, unknown>)[OTEL_KEY] = {
      context: { active: () => ({}) },
      trace: {
        getSpan: () => ({ spanContext: () => ({ traceId: '0'.repeat(32), spanId: SPAN_ID }) }),
      },
    };
    expect(getActiveSpanContext()).toBeNull();
  });

  it('survives an SDK whose shape it does not recognise', () => {
    // The registry shape is stable across 1.x, but this must degrade rather
    // than throw on the log path if that ever changes.
    (globalThis as Record<symbol, unknown>)[OTEL_KEY] = {
      trace: {
        getSpan: () => {
          throw new Error('unexpected');
        },
      },
      context: { active: () => ({}) },
    };
    expect(getActiveSpanContext()).toBeNull();
  });
});
