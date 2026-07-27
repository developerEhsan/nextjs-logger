/**
 * @file security.ts
 * All cryptographic operations for the relay endpoint.
 *
 * Threat model:
 *  ① External attackers trying to write arbitrary logs to stdout   → blocked by session-token HMAC.
 *  ② Replay of a captured token after it has expired               → blocked by session max-age window.
 *  ③ Cross-origin abuse from attacker-controlled pages             → blocked by origin allowlist (browser callers only, see validateOrigin).
 *  ④ Log injection (ANSI escape codes, newline injection)          → sanitised before printing.
 *  ⑤  Oversized payloads (DoS via large entry bodies)              → rejected by size guard.
 *
 * We use the Web Crypto API (crypto.subtle) so the same code runs on
 * both the Node.js runtime and the Edge Runtime without any native addon.
 *
 * Signing model — bearer session token, not per-payload HMAC:
 * The client never holds `relaySecret`, so it is cryptographically unable
 * to sign `entries` itself. What actually happens is:
 *   1. The server mints a token once per page load: `sign(secret, "session."+issuedAt)`.
 *   2. The client attaches that same token + issuedAt to every relay call
 *      (fetch, retries, and the sendBeacon unload path all reuse it — there
 *      is nothing session-specific about *how* the request was sent).
 *   3. The server re-derives `sign(secret, "session."+issuedAt)` and compares
 *      it to the token in constant time, and separately checks `issuedAt` is
 *      within `SESSION_MAX_AGE_MS`.
 * This authenticates "this request came from a page the server rendered
 * within the session window," not "these exact entries are byte-for-byte
 * unmodified" — that stronger guarantee isn't achievable without shipping
 * the secret to the browser, which the whole design deliberately avoids.
 * Entry *content* safety instead comes from structural validation below
 * plus sanitisation at write time (sanitiseMessage/sanitiseData).
 */

import { LogEntry, RelayPayload } from "../core/types";


// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum accepted age of a session token in milliseconds. */
export const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

/** How far into the future an `issuedAt` may claim to be (clock skew tolerance). */
const CLOCK_SKEW_MS = 5_000;

/** Maximum number of entries accepted per relay request. */
const MAX_ENTRIES_PER_REQUEST = 100;

/** Maximum byte size of the JSON-serialised payload body. */
const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB

// ─── HMAC helpers ─────────────────────────────────────────────────────────────

/** Import a raw secret string as a CryptoKey for HMAC-SHA256. */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,       // not extractable
    ['sign', 'verify'],
  );
}

/** Produce a hex-encoded HMAC-SHA256 of `data` under `secret`. */
export async function sign(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time hex comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Session token ────────────────────────────────────────────────────────────

/**
 * Canonical signing input for a session token: a fixed prefix + the ISO
 * timestamp the token was issued at. Deliberately does NOT include
 * `entries` — the client cannot produce that HMAC (see file header), so
 * a signature scheme that requires it can never actually verify.
 */
function buildSessionSigningInput(issuedAt: string): string {
  return `session.${issuedAt}`;
}

/** Mint a session token. Called once server-side per page load. */
export async function mintSessionToken(
  secret: string,
  issuedAt: string,
): Promise<string> {
  return sign(secret, buildSessionSigningInput(issuedAt));
}

/**
 * Fraction of `SESSION_MAX_AGE_MS` after which a still-valid token should be
 * proactively replaced.
 */
const SESSION_RENEW_AFTER = 0.5;

/**
 * Should the relay hand back a freshly minted token with this response?
 *
 * A token is minted once, when `LoggerProvider` renders, and then lives as
 * long as the tab does. Nothing ever replaced it, so a tab left open past
 * `SESSION_MAX_AGE_MS` (6h) started failing verification and every subsequent
 * browser log was silently dropped — the same shape of quiet, delayed failure
 * as the other bugs this library has shipped.
 *
 * Rolling renewal fixes it without adding an unauthenticated mint endpoint:
 * you must already present a valid token to be given the next one, so this
 * grants no capability a caller did not already have. An idle tab that misses
 * the window entirely is caught by the Server Action fallback, which carries
 * its own fresh token back.
 */
export function shouldRenewSession(issuedAt: string, now: number = Date.now()): boolean {
  const age = now - new Date(issuedAt).getTime();
  return Number.isFinite(age) && age > SESSION_MAX_AGE_MS * SESSION_RENEW_AFTER;
}

/** Mint a token for right now. Returns the pair the client must resend. */
export async function mintFreshSession(
  secret: string,
): Promise<{ token: string; issuedAt: string }> {
  const issuedAt = new Date().toISOString();
  return { token: await mintSessionToken(secret, issuedAt), issuedAt };
}

// ─── Payload verification (server-side only) ──────────────────────────────────

export class RelaySecurityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_ORIGIN'
      | 'MISSING_FIELDS'
      | 'PAYLOAD_TOO_LARGE'
      | 'TOO_MANY_ENTRIES'
      | 'TIMESTAMP_EXPIRED'
      | 'INVALID_SIGNATURE'
      | 'INVALID_ENTRY',
  ) {
    super(message);
    this.name = 'RelaySecurityError';
  }
}

/**
 * Validate the Origin / Referer header against the allowlist.
 *
 * Note: a caller that omits both headers entirely (trivial for any non-browser
 * HTTP client, e.g. `curl`) skips this check by design — it exists to stop
 * *browser*-driven cross-origin abuse (where the browser attaches these
 * headers itself and a page can't forge them), not to authenticate arbitrary
 * scripted clients. The session-token check below is the real gate against
 * those; treat origin allowlisting as defense-in-depth, not the primary control.
 */
export function validateOrigin(
  originHeader: string | null,
  refererHeader: string | null,
  allowedOrigins: string[],
): void {
  // Server-to-server calls have no origin (e.g. Server Actions fallback)
  if (!originHeader && !refererHeader) return;

  const requestOrigin = originHeader ?? (() => {
    try { return new URL(refererHeader!).origin; } catch { return null; }
  })();

  if (!requestOrigin) {
    throw new RelaySecurityError(
      'Could not determine request origin.',
      'INVALID_ORIGIN',
    );
  }

  if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
    throw new RelaySecurityError(
      `Origin "${requestOrigin}" is not in the allowed list.`,
      'INVALID_ORIGIN',
    );
  }
}

/**
 * Exact match, plus support for the `scheme://host:*` any-port form that
 * `buildAllowedOrigins()` emits for loopback in development.
 *
 * The wildcard is only ever a *port* wildcard on a host the allowlist named
 * explicitly — it can never widen to another host, so a dev entry cannot
 * accidentally admit `http://localhost.evil.com`.
 */
export function isOriginAllowed(requestOrigin: string, allowedOrigins: string[]): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed === requestOrigin) return true;

    if (allowed.endsWith(':*')) {
      const prefix = allowed.slice(0, -1); // keep the trailing ':'
      if (
        requestOrigin.startsWith(prefix) &&
        /^\d+$/.test(requestOrigin.slice(prefix.length))
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Full server-side verification of a relay payload. */
export async function verifyPayload(
  payload: unknown,
  rawBodyBytes: number,
  secret: string,
  allowedOrigins: string[],
  originHeader: string | null,
  refererHeader: string | null,
): Promise<LogEntry[]> {
  // ① Origin check
  validateOrigin(originHeader, refererHeader, allowedOrigins);

  // ② Size guard — prevent memory exhaustion before JSON parsing
  if (rawBodyBytes > MAX_PAYLOAD_BYTES) {
    throw new RelaySecurityError(
      `Payload too large: ${rawBodyBytes} bytes (max ${MAX_PAYLOAD_BYTES}).`,
      'PAYLOAD_TOO_LARGE',
    );
  }

  // ③ Structural check
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('entries' in payload) ||
    !('token' in payload) ||
    !('issuedAt' in payload)
  ) {
    throw new RelaySecurityError(
      'Relay payload missing required fields: entries, token, issuedAt.',
      'MISSING_FIELDS',
    );
  }

  const { entries, token, issuedAt } = payload as RelayPayload;

  // ④ Entry count guard
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES_PER_REQUEST) {
    throw new RelaySecurityError(
      `Entry count exceeds limit: ${entries?.length ?? 0} (max ${MAX_ENTRIES_PER_REQUEST}).`,
      'TOO_MANY_ENTRIES',
    );
  }

  // ⑤ Session freshness — bounds how long a leaked token stays usable, and
  // rejects a claimed issue time that's implausibly in the future.
  const tokenAge = Date.now() - new Date(issuedAt).getTime();
  if (isNaN(tokenAge) || tokenAge > SESSION_MAX_AGE_MS || tokenAge < -CLOCK_SKEW_MS) {
    throw new RelaySecurityError(
      `Session token is stale or invalid: issued ${issuedAt} (age: ${tokenAge}ms).`,
      'TIMESTAMP_EXPIRED',
    );
  }

  // ⑥ Token verification — constant-time. Authenticates that this request
  // carries a token this server minted (see file header for what this does
  // and does not guarantee about `entries`).
  const expected = await sign(secret, buildSessionSigningInput(issuedAt));
  if (!timingSafeEqual(token, expected)) {
    throw new RelaySecurityError(
      'Session token mismatch. Request may have been tampered with.',
      'INVALID_SIGNATURE',
    );
  }

  // ⑦ Per-entry structural validation (prevent log injection via crafted entries)
  const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !VALID_LEVELS.has((entry as LogEntry).level) ||
      typeof (entry as LogEntry).message !== 'string' ||
      typeof (entry as LogEntry).context !== 'object'
    ) {
      throw new RelaySecurityError(
        `Invalid log entry structure: ${JSON.stringify(entry)}`,
        'INVALID_ENTRY',
      );
    }
  }

  return entries as LogEntry[];
}

// ─── Log injection sanitisation ───────────────────────────────────────────────

/**
 * Escape sequences a terminal will interpret.
 *
 * The previous pattern was `/\x1B\[[0-9;]*[a-zA-Z]/g`, which only covers CSI
 * (`ESC [ … letter`). That leaves the other families through:
 *   • OSC   — `ESC ] 0 ; text BEL` can rewrite the terminal's window title
 *   • Fe    — `ESC c` is a full terminal reset
 *   • nF    — `ESC ( B` and friends switch character sets
 * All of them are reachable from a relayed log message, so match the families
 * rather than just the common one.
 */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?|[@-Z\\-_]|[ -/]*[0-~])/g;

/**
 * C0/C7 control characters, excluding `\t` (0x09), `\n` (0x0A) and `\r` (0x0D)
 * — those are handled separately below so they can be *escaped* rather than
 * silently deleted.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Neutralise anything in a caller-supplied string that could corrupt terminal
 * output or forge log lines.
 *
 * Newlines are **escaped to a literal `\n`, not stripped**. The threat model at
 * the top of this file has always claimed newline injection was blocked, but
 * the original implementation only removed `\r` — so a relayed message
 * containing a real `\n` could print a second, entirely attacker-controlled
 * line that looked exactly like a genuine log entry:
 *
 *   log.info("ok\n01:02:03 [FATAL] database credentials rotated")
 *
 * Escaping rather than deleting keeps the information visible (you can still
 * read what was sent) while making it impossible to fabricate a line prefix.
 * Genuinely multi-line content belongs in `data`, where JSON encoding escapes
 * it for the same reason.
 */
export function sanitiseMessage(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, '')          // terminal escape sequences
    .replace(CONTROL_CHARS_RE, '')        // remaining control bytes (incl. lone ESC, NUL)
    .replace(/\t/g, '  ')                 // tabs can fake column alignment
    .replace(/\r\n|\r|\n/g, '\\n')        // escape — never forge a new line
    .slice(0, 4096);                      // hard message length cap
}

/**
 * Same neutralisation as `sanitiseMessage`, with a tighter cap, for the short
 * `context` strings interpolated into a formatted line (namespace, caller,
 * requestId, timestamp).
 *
 * These are just as attacker-influenced as `message` on the relay path —
 * `verifyPayload` only checks that `context` is an object — but the terminal
 * formatter used to interpolate them raw, so `namespace` was an unguarded
 * second injection point that bypassed all the hardening above.
 */
export function sanitiseField(raw: string, maxLength = 256): string {
  return sanitiseMessage(raw).slice(0, maxLength);
}

/**
 * Keys that must never be carried through as own properties: assigning them
 * while rebuilding an object can walk the prototype chain instead of creating
 * a plain data property.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-sanitise structured data by JSON round-tripping.
 *
 * This rejects non-serialisable values (functions, `undefined`, circular refs)
 * and drops prototype-polluting keys. The prototype part is not free: a bare
 * `JSON.parse(JSON.stringify(x))` happily produces an object with an *own*
 * `__proto__` key, which the docblock here used to claim was stripped. The
 * reviver below actually does it.
 */
export function sanitiseData(raw: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(raw), function reviver(key, value) {
      return UNSAFE_KEYS.has(key) ? undefined : value;
    });
  } catch {
    return '[unserializable data]';
  }
}

// ─── Redaction ───────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';

function keyMatches(key: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((p) =>
    typeof p === 'string' ? p.toLowerCase() === key.toLowerCase() : p.test(key),
  );
}

/**
 * Deep-walk `data` (assumed already JSON-safe, i.e. post `sanitiseData`) and
 * replace the value of any object key matching `patterns` with `[REDACTED]`.
 * Case-insensitive for string patterns; arrays are walked but never treated
 * as key matches themselves.
 */
export function redact(data: unknown, patterns: (string | RegExp)[]): unknown {
  if (!patterns.length) return data;

  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const next = keyMatches(key, patterns) ? REDACTED : walk(val);
        // `out[key] = …` would hit the inherited `__proto__` setter for that
        // key name, silently reparenting `out` instead of storing the value —
        // so a `__proto__` field would vanish from the output rather than being
        // redacted or printed. defineProperty always creates an own data
        // property. (`sanitiseData` normally strips these first, but `redact`
        // is exported and must be safe on its own.)
        Object.defineProperty(out, key, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  return walk(data);
}
