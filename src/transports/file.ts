/**
 * @file transports/file.ts
 * Append log entries to a file, with size-based rotation.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * This is a *local* file sink: a dev-machine audit trail, a long-running
 * self-hosted Node server, a container writing to a mounted volume. It is
 * explicitly not a substitute for a log shipper, and on serverless it is
 * close to useless (ephemeral disk, no way to read it back) — the HTTP and
 * OTLP transports exist for that.
 *
 * ── Why writes are synchronous ───────────────────────────────────────────
 * `appendFileSync` per batch, not a stream. A stream would be faster and is
 * the obvious choice, right up until the process exits: buffered stream
 * data is lost on `process.exit()`, on an unhandled crash, and on a
 * serverless freeze — which is to say, at exactly the moments the last few
 * log lines matter most. Since the pipeline already batches (default 100
 * entries / 2s), the syscall rate is low enough that the durability is
 * worth more than the throughput.
 *
 * ── Rotation ─────────────────────────────────────────────────────────────
 * Size-based, checked before each batch: `app.log` → `app.log.1` →
 * `app.log.2`, oldest deleted past `maxFiles`. Not time-based, because
 * time-based rotation needs a scheduler that fires whether or not anything
 * is being logged, and a logger should not own a cron. If you want daily
 * files, put the date in `path` and let `logrotate` or the platform handle
 * retention.
 */

import type { LogEntry } from '../core/types';
import { getFs, getFsSync, type MinimalFs } from '../utils/node-fs';
import type { Transport } from './types';

export interface FileTransportOptions {
  /** Path to write to. Parent directories are created if missing. */
  path: string;
  /**
   * Rotate once the file exceeds this many bytes. Default 10 MB.
   * Set to 0 to never rotate (you are then responsible for the file's size).
   */
  maxSizeBytes?: number;
  /** How many rotated files to keep. Default 5. */
  maxFiles?: number;
  /**
   * Serialise an entry to one line. Defaults to JSON — one object per line,
   * which is what every log tool on earth can read.
   */
  format?: (entry: LogEntry) => string;
  /** Only write entries at this level or above. */
  minLevel?: Transport['minLevel'];
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/**
 * Default line format: compact JSON, newline-terminated.
 *
 * `\n` inside a string value is escaped by `JSON.stringify`, so a message
 * containing a newline cannot break the one-object-per-line invariant that
 * makes the output readable by `jq`, Loki, or `grep`.
 */
function defaultFormat(entry: LogEntry): string {
  return JSON.stringify({
    level: entry.level,
    time: entry.context.timestamp,
    msg: entry.message,
    ...(entry.context.namespace ? { ns: entry.context.namespace } : {}),
    ...(entry.context.requestId ? { requestId: entry.context.requestId } : {}),
    ...(entry.context.traceId ? { traceId: entry.context.traceId } : {}),
    ...(entry.context.spanId ? { spanId: entry.context.spanId } : {}),
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  });
}

export function fileTransport(options: FileTransportOptions): Transport {
  const {
    path,
    maxSizeBytes = DEFAULT_MAX_SIZE,
    maxFiles = DEFAULT_MAX_FILES,
    format = defaultFormat,
    minLevel,
  } = options;

  let directoryEnsured = false;

  const ensureDirectory = (fs: MinimalFs): void => {
    if (directoryEnsured) return;
    const separator = path.lastIndexOf('/');
    if (separator > 0) {
      try {
        fs.mkdirSync(path.slice(0, separator), { recursive: true });
      } catch {
        // Already exists, or genuinely not creatable — the append below
        // will throw and the pipeline will retry/report.
      }
    }
    directoryEnsured = true;
  };

  const rotate = (fs: MinimalFs): void => {
    if (maxSizeBytes <= 0) return;

    let size: number;
    try {
      size = fs.statSync(path).size;
    } catch {
      return; // No file yet — nothing to rotate.
    }
    if (size < maxSizeBytes) return;

    // Shift downward from the oldest so nothing is overwritten before it is
    // moved: .4 → .5, .3 → .4, … , base → .1
    try {
      fs.unlinkSync(`${path}.${maxFiles}`);
    } catch {
      // Nothing to delete.
    }
    for (let index = maxFiles - 1; index >= 1; index--) {
      try {
        fs.renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        // That generation doesn't exist yet.
      }
    }
    try {
      fs.renameSync(path, `${path}.1`);
    } catch {
      // Lost a race with another process; the append below still works.
    }
  };

  return {
    name: `file(${path})`,
    minLevel,

    async write(entries: LogEntry[]): Promise<void> {
      // `getFsSync` on the hot path, falling back to the awaited form only
      // when the background import has not settled yet (older Node). After
      // the first batch this is always the synchronous path.
      const fs = getFsSync() ?? (await getFs());
      if (!fs) {
        // No filesystem: Edge Runtime, or a sandbox. Throwing would make
        // the pipeline retry forever against a condition that will never
        // change, so this is a permanent, silent no-op by design.
        return;
      }

      ensureDirectory(fs);
      rotate(fs);

      // One syscall per batch, not per entry.
      const payload = entries.map((entry) => format(entry)).join('\n') + '\n';

      // Not caught: a real write failure (disk full, permissions) must
      // reach the pipeline so it retries and, eventually, counts the drop.
      fs.appendFileSync(path, payload);
    },
  };
}
