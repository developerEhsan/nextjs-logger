/**
 * @file transport/server.ts
 * Terminal transport — the ONLY place log entries are ever written to stdout.
 *
 * All output goes through this single chokepoint so:
 *  • Pretty-printing logic lives in one place.
 *  • Log injection sanitisation is enforced once, on every write.
 *  • Node.js stdout/stderr are used directly (no console wrapper) to avoid
 *    Next.js intercepting and re-formatting log lines.
 *
 * Format in development (pretty):
 *   10:23:45.123 [INFO ] [auth] User logged in  { userId: 'u_123' }
 *
 * Format in production (JSON — pipe-friendly for log aggregators):
 *   {"level":"info","message":"User logged in","data":{"userId":"u_123"},...}
 */

import type { LogEntry, LogLevel, LogTransport, SerializedError } from '../core/types';
import { sanitiseMessage, sanitiseField, sanitiseData, redact } from '../security/index';
import { getNodeStream } from '../utils/node-globals';
import { mapStackFrames } from '../utils/source-map';
import { getPipeline } from '../transports/pipeline';

// ─── ANSI colour palette ─────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const LEVEL_COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[36m',   // cyan
  info:  '\x1b[32m',   // green
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  fatal: '\x1b[35m',   // magenta
};

// ─── Formatters ──────────────────────────────────────────────────────────────

function padLevel(level: LogLevel): string {
  return level.toUpperCase().padEnd(5);
}

function formatTimestamp(iso: string): string {
  // Extract only the time part: HH:MM:SS.mmm
  return iso.split('T')[1]?.replace('Z', '') ?? iso;
}

/**
 * Read a `context` string safely.
 *
 * Every field here is attacker-influenceable on the relay path: `verifyPayload`
 * checks that `context` is an *object*, not the type or content of its fields.
 * They used to be interpolated into the line verbatim, which made `namespace`
 * (and `caller`, `requestId`, `timestamp`) a second log-injection vector that
 * completely bypassed the sanitisation applied to `message` — the one field
 * everybody remembers to guard.
 *
 * Non-strings are coerced rather than trusted, since the wire type is only a
 * TypeScript claim about JSON that arrived over the network.
 */
function safeField(value: unknown, maxLength?: number): string {
  return sanitiseField(typeof value === 'string' ? value : String(value), maxLength);
}

// ─── Error rendering ─────────────────────────────────────────────────────────

/**
 * Sanitise a serialised error for output.
 *
 * Every field here is attacker-influenceable on the relay path in exactly
 * the same way `context` is — `verifyPayload` checks that entries are
 * structurally sound, not that `error.stack[3]` is a real stack frame. A
 * stack is *printed as multiple lines*, which makes it the most attractive
 * log-forgery vector in the whole payload: an unsanitised frame containing
 * a newline would let a relayed error print an arbitrary extra line. So
 * each frame goes through `sanitiseField`, which escapes newlines rather
 * than deleting them, and the line prefix is always ours.
 *
 * `properties` goes through the same `sanitiseData` + `redact` pass as
 * `data`, because error subclasses routinely carry request context — and
 * therefore tokens.
 */
function safeError(
  error: SerializedError,
  redactKeys: (string | RegExp)[],
  resolveSourceMaps: boolean,
  depth = 0,
): SerializedError {
  const rawFrames = Array.isArray(error.stack) ? error.stack.slice(0, MAX_RENDERED_FRAMES) : [];
  // Map before sanitising: the mapper needs the real location text, and it
  // only ever returns file paths from a source map's `sources`, never
  // caller-supplied content.
  const frames = resolveSourceMaps ? mapStackFrames(rawFrames) : rawFrames;

  const out: SerializedError = {
    name: safeField(error.name, 128),
    message: sanitiseMessage(typeof error.message === 'string' ? error.message : String(error.message)),
  };

  if (frames.length > 0) out.stack = frames.map((frame) => safeField(frame, 512));

  // Depth is bounded again here, independently of `serializeError`'s own
  // cap: this function also runs on entries that arrived over the network,
  // where the cause chain's depth is whatever the sender claimed.
  if (error.cause && depth < MAX_RENDERED_CAUSE_DEPTH) {
    out.cause = safeError(error.cause, redactKeys, resolveSourceMaps, depth + 1);
  }

  if (Array.isArray(error.errors) && depth < MAX_RENDERED_CAUSE_DEPTH) {
    out.errors = error.errors
      .slice(0, MAX_RENDERED_AGGREGATE)
      .map((inner) => safeError(inner, redactKeys, resolveSourceMaps, depth + 1));
  }

  if (error.properties && typeof error.properties === 'object') {
    out.properties = redact(sanitiseData(error.properties), redactKeys) as Record<string, unknown>;
  }

  return out;
}

/** Frames printed per error. Beyond this the tail is framework internals. */
const MAX_RENDERED_FRAMES = 20;
const MAX_RENDERED_CAUSE_DEPTH = 5;
const MAX_RENDERED_AGGREGATE = 10;

/**
 * Render an already-sanitised error as an indented block.
 *
 * Frames get one line each — the whole reason `SerializedError.stack` is an
 * array rather than a string. `caused by:` chains are indented one further
 * level per link so a deep chain stays readable.
 */
function renderErrorBlock(error: SerializedError, indent: string): string {
  const lines: string[] = [];
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  lines.push(`${indent}${LEVEL_COLOURS.error}${header}${RESET}`);

  for (const frame of error.stack ?? []) {
    lines.push(`${indent}  ${DIM}${frame}${RESET}`);
  }

  if (error.properties && Object.keys(error.properties).length > 0) {
    const json = JSON.stringify(error.properties);
    lines.push(`${indent}  ${DIM}props:${RESET} ${json}`);
  }

  if (error.cause) {
    lines.push(`${indent}${DIM}caused by:${RESET}`);
    lines.push(renderErrorBlock(error.cause, `${indent}  `));
  }

  for (const inner of error.errors ?? []) {
    lines.push(`${indent}${DIM}aggregated:${RESET}`);
    lines.push(renderErrorBlock(inner, `${indent}  `));
  }

  return lines.join('\n');
}

function formatPretty(
  entry: LogEntry,
  redactKeys: (string | RegExp)[],
  resolveSourceMaps: boolean,
): string {
  const colour   = LEVEL_COLOURS[entry.level];
  const time     = DIM + safeField(formatTimestamp(safeField(entry.context.timestamp, 64)), 64) + RESET;
  const level    = colour + BOLD + `[${padLevel(entry.level)}]` + RESET;
  const ns       = entry.context.namespace
    ? DIM + `[${safeField(entry.context.namespace, 128)}]` + RESET + ' '
    : '';
  const msg      = sanitiseMessage(entry.message);
  const caller   = entry.context.caller
    ? DIM + ` (${safeField(entry.context.caller, 256)})` + RESET
    : '';
  const reqId    = entry.context.requestId
    ? DIM + ` req:${safeField(entry.context.requestId, 128)}` + RESET
    : '';

  // Only the first 8 characters of the trace ID are printed. A full 32-hex
  // ID on every line is unreadable, and 8 hex chars is plenty to eyeball
  // "these lines are the same trace" — the full value is in JSON output and
  // in whatever transport ships to your trace backend.
  const traceId  = entry.context.traceId
    ? DIM + ` trace:${safeField(entry.context.traceId, 32).slice(0, 8)}` + RESET
    : '';

  let line = `${time} ${level} ${ns}${msg}${caller}${reqId}${traceId}`;

  if (entry.error) {
    line += '\n' + renderErrorBlock(
      safeError(entry.error, redactKeys, resolveSourceMaps),
      '  ',
    );
  }

  if (entry.data !== undefined) {
    const safeData = redact(sanitiseData(entry.data), redactKeys);
    const pretty   = JSON.stringify(safeData, null, 2);
    line += `\n  ${DIM}↳${RESET} ` + pretty.replace(/\n/g, '\n    ');
  }

  return line;
}

function formatJson(
  entry: LogEntry,
  redactKeys: (string | RegExp)[],
  resolveSourceMaps: boolean,
): string {
  // JSON encoding already escapes control characters, so this format cannot be
  // used to forge a line. The fields are still sanitised so that a downstream
  // aggregator which unescapes and renders them (a log viewer, a terminal
  // `jq` pipeline) doesn't reintroduce the injection the terminal format
  // guards against.
  const safeEntry: Record<string, unknown> = {
    level:     entry.level,
    message:   sanitiseMessage(entry.message),
    timestamp: safeField(entry.context.timestamp, 64),
    runtime:   entry.context.runtime === 'client' ? 'client' : 'server',
    sequence:  Number.isFinite(entry.context.sequence) ? entry.context.sequence : 0,
  };

  if (entry.context.namespace) safeEntry.namespace  = safeField(entry.context.namespace, 128);
  if (entry.context.caller)    safeEntry.caller      = safeField(entry.context.caller, 256);
  if (entry.context.requestId) safeEntry.requestId   = safeField(entry.context.requestId, 128);
  // Emitted under the names every log aggregator's trace-correlation
  // feature looks for (Datadog, Grafana, Honeycomb all key on these).
  if (entry.context.traceId)   safeEntry.traceId     = safeField(entry.context.traceId, 32);
  if (entry.context.spanId)    safeEntry.spanId      = safeField(entry.context.spanId, 16);
  if (entry.data !== undefined) safeEntry.data       = redact(sanitiseData(entry.data), redactKeys);
  if (entry.error)              safeEntry.error      = safeError(entry.error, redactKeys, resolveSourceMaps);

  return JSON.stringify(safeEntry);
}

// ─── Write primitives ────────────────────────────────────────────────────────

/**
 * Resolve which Node.js stream to write to.
 * warn/error/fatal → stderr so they appear even when stdout is piped.
 * debug/info → stdout.
 */
function getStream(level: LogLevel): NodeJS.WriteStream | undefined {
  if (level === 'warn' || level === 'error' || level === 'fatal') {
    return getNodeStream('stderr');
  }
  return getNodeStream('stdout');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ServerTransportOptions {
  prettyPrint: boolean;
  /** Object keys redacted from `data` before it's written. Defaults to none. */
  redactKeys?: (string | RegExp)[];
  /**
   * Resolve stack frames through the build's source maps before printing,
   * turning `/_next/static/chunks/page.js:2:48219` into
   * `app/checkout/form.tsx:42:9`. Comes from `LoggerConfig.sourceMaps` via
   * `sourceMapsEnabled()`; defaults to off here so a caller that constructs
   * options by hand never pays for it unintentionally.
   */
  resolveSourceMaps?: boolean;
  /** Additional sinks invoked with the raw entry, isolated from stdout/stderr and each other. */
  transports?: LogTransport[];
}

/**
 * Write a log entry to the terminal (and any configured extra transports).
 * This is a synchronous, non-blocking write; Node.js buffers the I/O.
 *
 * Errors thrown by the write (e.g. broken pipe) are swallowed intentionally:
 * the logger must never crash the application.
 */
export function writeToTerminal(
  entry: LogEntry,
  options: ServerTransportOptions,
): void {
  const redactKeys = options.redactKeys ?? [];
  const resolveSourceMaps = options.resolveSourceMaps ?? false;

  try {
    const line = options.prettyPrint
      ? formatPretty(entry, redactKeys, resolveSourceMaps)
      : formatJson(entry, redactKeys, resolveSourceMaps);

    const stream = getStream(entry.level);
    stream?.write(line + '\n');
  } catch {
    // Swallow all transport errors — logging must never crash the app.
    // If even stderr is broken there's nothing meaningful we can do.
  }

  // Extra sinks run independently of the terminal write and of each other —
  // one throwing/misbehaving transport must never suppress the terminal
  // output or take down another transport.
  //
  // Everything about batching, retry, backpressure and isolation lives in
  // the pipeline; this call only hands the entry over and returns. Plain
  // function transports are still invoked inline by the pipeline, so their
  // original synchronous semantics are unchanged.
  if (options.transports?.length) {
    try {
      getPipeline(options.transports).push(entry);
    } catch {
      // Constructing or feeding the pipeline must never break the app.
    }
  }
}

/**
 * Write a batch of entries, preserving their original sequence order.
 * Used by the relay endpoint after verifying client-submitted entries.
 */
export function writeBatchToTerminal(
  entries: LogEntry[],
  options: ServerTransportOptions,
): void {
  // Sort by original sequence number so relay-batched entries print in order
  const sorted = [...entries].sort(
    (a, b) => a.context.sequence - b.context.sequence,
  );
  for (const entry of sorted) {
    writeToTerminal(entry, options);
  }
}
