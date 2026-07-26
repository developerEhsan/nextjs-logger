/**
 * @file transport/client.ts
 * Client → server relay transport.
 *
 * Strategy (in priority order):
 *  1. Server Action  – preferred; zero extra HTTP round-trip, no CORS dance.
 *     Detected by checking if `relayViaServerAction` was bound at init time.
 *  2. API route      – POST /api/__log, signed with HMAC, origin-gated.
 *     Fallback when Server Actions are not available (Pages Router, edge cases).
 *
 * Key design choices:
 *  • `navigator.sendBeacon` is used for final flush on `visibilitychange` +
 *    `beforeunload` so logs are delivered even after the page starts closing.
 *  • Exponential back-off with jitter on transient failures.
 *  • Errors are swallowed (logged to the DevTools console only in dev).
 *  • The relay secret is NEVER stored on the client — the client receives a
 *    signed token from the server at init time and sends it back; the server
 *    re-derives and verifies the HMAC.
 */

import type { LogEntry, RelayPayload } from '../core/types';
import { sanitiseData, redact } from '../security/index';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A bound Server Action that accepts an array of LogEntry objects.
 * Next.js 16 serialises the arguments automatically (React Flight protocol).
 */
export type ServerActionRelay = (entries: LogEntry[]) => Promise<void>;

export interface ClientTransportOptions {
  /** Absolute URL of the fallback API relay, e.g. '/api/__log'. */
  relayUrl: string;
  /** Session token minted by the server at startup (see security/index.ts). */
  signedToken: string;
  /** ISO timestamp the session token was issued at. */
  issuedAt: string;
  /** Optional bound Server Action (preferred transport). */
  serverAction?: ServerActionRelay;
  /** Whether to emit debug messages to the DevTools console in development. */
  debug?: boolean;
  /** Object keys redacted from `data` before it ever leaves the browser. */
  redactKeys?: (string | RegExp)[];
}

// ─── Back-off ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

function withJitter(ms: number): number {
  return ms + Math.random() * ms * 0.3;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Beacon fallback ─────────────────────────────────────────────────────────

/**
 * Build a RelayPayload for the beacon path. Uses the same session
 * token + issuedAt as every other relay call — there's nothing beacon-
 * specific about the token itself, sendBeacon just can't await an async
 * fetch/Server Action, so it posts synchronously instead.
 */
function buildBeaconPayload(
  entries: LogEntry[],
  signedToken: string,
  issuedAt: string,
  redactKeys: (string | RegExp)[],
): string {
  const payload: RelayPayload = {
    entries: entries.map((e) => sanitiseEntry(e, redactKeys)),
    token: signedToken,
    issuedAt,
  };
  return JSON.stringify(payload);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip non-serialisable fields and redact sensitive keys before sending over the wire. */
function sanitiseEntry(entry: LogEntry, redactKeys: (string | RegExp)[]): LogEntry {
  return {
    ...entry,
    message: entry.message.slice(0, 4096),
    data: entry.data !== undefined ? redact(sanitiseData(entry.data), redactKeys) : undefined,
  };
}

function devWarn(debug: boolean | undefined, ...args: unknown[]): void {
  if (debug && process.env.NODE_ENV === 'development') {
    // Only reaches DevTools — never reaches the server terminal
    console.warn('[logger client]', ...args);
  }
}

// ─── Core relay function ──────────────────────────────────────────────────────

/**
 * Relay a batch of entries to the server terminal.
 *
 * Returns a promise that resolves when the relay succeeds.
 * Rejects only after MAX_RETRIES exhausted (caller may re-queue or drop).
 */
export async function relayEntries(
  entries: LogEntry[],
  opts: ClientTransportOptions,
): Promise<void> {
  if (entries.length === 0) return;

  const redactKeys = opts.redactKeys ?? [];
  const sanitised = entries.map((e) => sanitiseEntry(e, redactKeys));

  // ── Path 1: Server Action ─────────────────────────────────────────────────
  if (opts.serverAction) {
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
      try {
        await opts.serverAction(sanitised);
        return;
      } catch (err) {
        attempt++;
        devWarn(
          opts.debug,
          `Server Action relay failed (attempt ${attempt}/${MAX_RETRIES}):`,
          err,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(withJitter(BASE_DELAY_MS * 2 ** (attempt - 1)));
        }
      }
    }
    // Fall through to API route on final SA failure
    devWarn(opts.debug, 'Server Action exhausted — falling back to API route.');
  }

  // ── Path 2: Signed API Route ──────────────────────────────────────────────
  const body: RelayPayload = {
    entries: sanitised,
    token: opts.signedToken,
    issuedAt: opts.issuedAt,
  };
  const bodyStr = JSON.stringify(body);

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(opts.relayUrl, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          // Custom header so the server can quickly reject non-logger traffic
          'X-Logger-Version': '1',
        },
        body: bodyStr,
        // Next.js 16 fetch: opt out of caching completely
        cache: 'no-store',
        // Keep-alive so the browser reuses the connection for batched calls
        keepalive: true,
      });

      if (res.ok) return;

      // Non-retriable HTTP errors (auth failure, bad request, etc.)
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        devWarn(
          opts.debug,
          `Relay rejected with ${res.status} — dropping batch.`,
        );
        return; // do not retry — these are permanent failures
      }

      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      attempt++;
      devWarn(
        opts.debug,
        `API route relay failed (attempt ${attempt}/${MAX_RETRIES}):`,
        err,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(withJitter(BASE_DELAY_MS * 2 ** (attempt - 1)));
      }
    }
  }

  devWarn(opts.debug, 'All relay attempts exhausted. Batch dropped.');
}

// ─── Beacon relay (page unload) ───────────────────────────────────────────────

/**
 * Fire-and-forget relay using sendBeacon.
 * Used for the unload flush; no retry possible.
 */
export function relayEntriesBeacon(
  entries: LogEntry[],
  opts: Pick<ClientTransportOptions, 'relayUrl' | 'signedToken' | 'issuedAt' | 'redactKeys'>,
): void {
  if (entries.length === 0) return;
  if (!navigator.sendBeacon) return;

  const payload = buildBeaconPayload(entries, opts.signedToken, opts.issuedAt, opts.redactKeys ?? []);
  navigator.sendBeacon(
    opts.relayUrl,
    new Blob([payload], { type: 'application/json' }),
  );
}
