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

import type { LogEntry, LogLevel, LogTransport } from '../core/types';
import { sanitiseMessage, sanitiseData, redact } from '../security/index';

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

function formatPretty(entry: LogEntry, redactKeys: (string | RegExp)[]): string {
  const colour   = LEVEL_COLOURS[entry.level];
  const time     = DIM + formatTimestamp(entry.context.timestamp) + RESET;
  const level    = colour + BOLD + `[${padLevel(entry.level)}]` + RESET;
  const ns       = entry.context.namespace
    ? DIM + `[${entry.context.namespace}]` + RESET + ' '
    : '';
  const msg      = sanitiseMessage(entry.message);
  const caller   = entry.context.caller
    ? DIM + ` (${entry.context.caller})` + RESET
    : '';
  const reqId    = entry.context.requestId
    ? DIM + ` req:${entry.context.requestId}` + RESET
    : '';

  let line = `${time} ${level} ${ns}${msg}${caller}${reqId}`;

  if (entry.data !== undefined) {
    const safeData = redact(sanitiseData(entry.data), redactKeys);
    const pretty   = JSON.stringify(safeData, null, 2);
    line += `\n  ${DIM}↳${RESET} ` + pretty.replace(/\n/g, '\n    ');
  }

  return line;
}

function formatJson(entry: LogEntry, redactKeys: (string | RegExp)[]): string {
  const safeEntry: Record<string, unknown> = {
    level:     entry.level,
    message:   sanitiseMessage(entry.message),
    timestamp: entry.context.timestamp,
    runtime:   entry.context.runtime,
    sequence:  entry.context.sequence,
  };

  if (entry.context.namespace) safeEntry.namespace  = entry.context.namespace;
  if (entry.context.caller)    safeEntry.caller      = entry.context.caller;
  if (entry.context.requestId) safeEntry.requestId   = entry.context.requestId;
  if (entry.data !== undefined) safeEntry.data       = redact(sanitiseData(entry.data), redactKeys);

  return JSON.stringify(safeEntry);
}

// ─── Write primitives ────────────────────────────────────────────────────────

/**
 * Resolve which Node.js stream to write to.
 * warn/error/fatal → stderr so they appear even when stdout is piped.
 * debug/info → stdout.
 */
function getStream(level: LogLevel): NodeJS.WriteStream {
  if (level === 'warn' || level === 'error' || level === 'fatal') {
    return process.stderr;
  }
  return process.stdout;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ServerTransportOptions {
  prettyPrint: boolean;
  /** Object keys redacted from `data` before it's written. Defaults to none. */
  redactKeys?: (string | RegExp)[];
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

  try {
    const line = options.prettyPrint
      ? formatPretty(entry, redactKeys)
      : formatJson(entry, redactKeys);

    const stream = getStream(entry.level);
    stream.write(line + '\n');
  } catch {
    // Swallow all transport errors — logging must never crash the app.
    // If even stderr is broken there's nothing meaningful we can do.
  }

  // Extra sinks run independently of the terminal write and of each other —
  // one throwing/misbehaving transport must never suppress the terminal
  // output or take down another transport.
  if (options.transports?.length) {
    for (const transport of options.transports) {
      try {
        transport(entry);
      } catch {
        // Swallow — a broken external sink is not the app's problem.
      }
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
