/**
 * @file transport/client.ts
 * Client → server relay transport.
 *
 * Strategy (in priority order):
 *  1. API route      – POST /api/log-relay, session-token authed, origin-gated.
 *     The default, because it is the only transport that does not touch React.
 *  2. Server Action  – fallback for apps that never mounted the route handler.
 *     Gated on React having mounted; see the warning below.
 *
 * ── Why the Server Action is NOT the primary transport ───────────────────
 * It reads like a plain async function call, but it isn't one. Importing a
 * `'use server'` function into client code gives you a *reference*; calling
 * it hands off to React's Flight client, which calls Next's `callServer`,
 * which dispatches into the App Router's action queue. That is a React state
 * update on the Router component, unconditionally, on every single call.
 *
 * For a logger — which fires at arbitrary moments, including from a render
 * body and before hydration finishes — there is no safe time to do that:
 *
 *   • during render        → "Cannot update a component (`Router`) while
 *                             rendering a different component (`X`)"
 *   • after render, before the router commits
 *                          → "Can't perform a React state update on a
 *                             component that hasn't mounted yet"
 *
 * Deferring off the render stack fixes only the first; the second is still
 * reachable on the very first paint. Both were observed in a real app. On top
 * of the errors, routing log traffic through the action queue serialises it
 * against genuine user actions (form submits) and keeps flipping router
 * pending state — bad behaviour for something that is supposed to be
 * invisible.
 *
 * A plain `fetch` to a Route Handler has none of this coupling: it is ordinary
 * network I/O that React never observes. So that is the default, and the
 * Server Action survives only as a fallback for apps that skipped the route
 * handler — where it is additionally gated on `markReactMounted()` so it
 * cannot produce the unmounted-update error either.
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

import type {
  LogEntry,
  RelayPayload,
  RelayResponse,
  RelaySession,
  SerializedError,
} from '../core/types';
import { sanitiseData, redact } from '../security/index';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A bound Server Action that accepts an array of LogEntry objects.
 * Next.js 16 serialises the arguments automatically (React Flight protocol).
 */
export type ServerActionRelay = (
  entries: LogEntry[],
) => Promise<RelayResponse | void>;

export interface ClientTransportOptions {
  /** Absolute URL of the fallback API relay, e.g. '/api/log-relay'. */
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
  /**
   * Invoked when the server hands back a renewed session token, so the caller
   * can swap it in for subsequent batches. Without this a tab open past
   * `SESSION_MAX_AGE_MS` ages out and every browser log is silently dropped.
   */
  onSessionRenewed?: (session: RelaySession) => void;
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

// ─── React-safety gate (Server Action fallback only) ─────────────────────────

/**
 * Resolved by `markReactMounted()`, which `LoggerBootstrapClient` calls from a
 * `useEffect`. Until then, dispatching a Server Action would be a state update
 * against a Router that has not committed yet.
 *
 * The `useEffect` here is internal to the library and does not weaken the
 * zero-hook promise — that promise is about what *consumers* have to write.
 */
let markMounted: () => void = () => {};
const reactMounted: Promise<void> = new Promise<void>((resolve) => {
  markMounted = resolve;
});

/** Called once by the bootstrap component after it mounts. */
export function markReactMounted(): void {
  markMounted();
}

/**
 * Wait for React to mount, but never hang forever: an app that renders the
 * provider server-side and never hydrates (or a runtime with no effects) would
 * otherwise stall the queue and let the buffer grow unbounded.
 */
async function waitForReactMount(): Promise<void> {
  await Promise.race([reactMounted, sleep(5_000)]);
}

/**
 * Set once the relay URL answers 404 — the app never mounted the route
 * handler. Remembered per page load so we stop paying for a doomed round-trip
 * on every batch.
 */
let routeHandlerMissing = false;

/** Ensures the "you forgot the route handler" guidance is printed only once. */
let warnedRouteMissing = false;

/** Test seam — resets the module-level transport state. */
export function _resetTransportState(): void {
  routeHandlerMissing = false;
  warnedRouteMissing = false;
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
    // `error.properties` is a redaction surface in its own right: error
    // subclasses routinely carry the request that produced them, headers
    // included. It must be redacted *here*, client-side, for the same
    // reason `data` is — so a token never leaves the browser at all, rather
    // than being caught on arrival.
    error: entry.error ? redactError(entry.error, redactKeys) : undefined,
  };
}

/**
 * Redact an error's own properties, following `cause` and
 * `AggregateError.errors` — a secret is just as exposed three links down a
 * cause chain as it is at the top.
 */
function redactError(
  error: SerializedError,
  redactKeys: (string | RegExp)[],
  depth = 0,
): SerializedError {
  if (depth > 5) return { name: error.name, message: error.message };
  return {
    ...error,
    properties: error.properties
      ? (redact(sanitiseData(error.properties), redactKeys) as Record<string, unknown>)
      : undefined,
    cause: error.cause ? redactError(error.cause, redactKeys, depth + 1) : undefined,
    errors: error.errors?.map((inner) => redactError(inner, redactKeys, depth + 1)),
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
 * Returns a promise that resolves when the relay succeeds, or when the batch
 * is rejected *permanently* (a 4xx — retrying a forged/expired token or an
 * over-size body will never start working, so the batch is dropped and the
 * caller is told the transport is done with it).
 *
 * Rejects only when every transport failed transiently after MAX_RETRIES —
 * that is the signal `ClientQueue` uses to re-enqueue the batch and try again
 * later. This function used to swallow that case and resolve, which made the
 * queue's re-enqueue branch unreachable: a batch lost to an offline window or
 * a restarting dev server was silently dropped despite the retry machinery
 * being right there.
 */
export async function relayEntries(
  entries: LogEntry[],
  opts: ClientTransportOptions,
): Promise<void> {
  if (entries.length === 0) return;

  const redactKeys = opts.redactKeys ?? [];
  const sanitised = entries.map((e) => sanitiseEntry(e, redactKeys));

  // ── Path 1: Signed API Route — the React-free default ─────────────────────
  if (!routeHandlerMissing) {
    const outcome = await sendViaFetch(sanitised, opts);

    // Delivered, or permanently rejected (a forged/expired token or an
    // over-size body will not start working on retry) — either way, done.
    if (outcome === 'ok' || outcome === 'rejected') return;

    if (outcome === 'missing') {
      routeHandlerMissing = true;
      warnRouteHandlerMissing(opts);
    }
    // 'missing', 'expired' or 'failed' → fall through to the Server Action.
  }

  // ── Path 2: Server Action fallback ────────────────────────────────────────
  if (opts.serverAction) {
    if (await sendViaServerAction(sanitised, opts)) return;
  } else if (routeHandlerMissing) {
    // Nothing left to try, and the condition is permanent — drop the batch
    // rather than making the queue retry into a 404 three more times.
    return;
  }

  devWarn(opts.debug, 'All relay attempts exhausted — handing the batch back to the queue.');
  throw new Error('[logger] relay failed: all transports exhausted');
}

type FetchOutcome = 'ok' | 'rejected' | 'missing' | 'expired' | 'failed';

/**
 * Adopt a renewed session if the relay returned one.
 *
 * Deliberately best-effort: a body that isn't JSON, or is JSON without a
 * session, is the normal case and must not turn a delivered batch into a
 * failure.
 */
async function adoptRenewedSession(
  res: Response,
  opts: ClientTransportOptions,
): Promise<void> {
  if (!opts.onSessionRenewed) return;
  try {
    const body = (await res.json()) as RelayResponse;
    if (body?.session?.token && body.session.issuedAt) {
      opts.onSessionRenewed(body.session);
    }
  } catch {
    // No body, or not JSON. The batch still landed.
  }
}

async function sendViaFetch(
  sanitised: LogEntry[],
  opts: ClientTransportOptions,
): Promise<FetchOutcome> {
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
        method: 'POST',
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

      if (res.ok) {
        await adoptRenewedSession(res, opts);
        return 'ok';
      }

      // The route handler isn't mounted at all — a setup problem, not a
      // transient one. Distinct from a rejection so the caller can switch
      // transports permanently instead of retrying.
      if (res.status === 404) return 'missing';

      // The session token is stale or invalid. Retrying the fetch cannot help
      // — the token will not get younger — but the Server Action can, because
      // it is authenticated by Next's own action reference and carries no
      // token of ours. It also returns a freshly minted session, which is how
      // a tab that sat idle past the validity window heals itself instead of
      // going quiet forever.
      if (res.status === 401) {
        devWarn(opts.debug, 'Session token rejected — trying the Server Action to re-establish one.');
        return 'expired';
      }

      // Rate limited. Transient by definition, so let the queue retry after
      // its own backoff rather than dropping the batch.
      if (res.status === 429) return 'failed';

      // Non-retriable HTTP errors (malformed body, disallowed origin).
      if (res.status === 400 || res.status === 403) {
        devWarn(opts.debug, `Relay rejected with ${res.status} — dropping batch.`);
        return 'rejected';
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

  return 'failed';
}

/** Returns true if the batch was delivered. */
async function sendViaServerAction(
  sanitised: LogEntry[],
  opts: ClientTransportOptions,
): Promise<boolean> {
  const serverAction = opts.serverAction;
  if (!serverAction) return false;

  // Never dispatch an action before the Router has committed — see the file
  // header. This is the difference between a working fallback and
  // "Can't perform a React state update on a component that hasn't mounted yet".
  await waitForReactMount();

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const result = await serverAction(sanitised);
      // The action runs server-side with the signing secret, so it can hand
      // back a valid session. This is what lets a tab whose token aged out
      // return to the cheap fetch transport instead of paying the router cost
      // for the rest of its life.
      if (result?.session?.token && result.session.issuedAt) {
        opts.onSessionRenewed?.(result.session);
      }
      return true;
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
  return false;
}

function warnRouteHandlerMissing(opts: ClientTransportOptions): void {
  if (warnedRouteMissing) return;
  warnedRouteMissing = true;
  if (process.env.NODE_ENV !== 'development') return;

  console.warn(
    `[logger] No route handler found at ${opts.relayUrl} (404). Falling back ` +
      'to the relay Server Action, which dispatches through the Next.js ' +
      'router on every call and is therefore slower and noisier.\n' +
      'Create app/api/log-relay/route.ts:\n\n' +
      "  export { POST } from '@developerehsan/nextjs-logger/relay/route-handler';\n",
  );
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
