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

  if (!allowedOrigins.includes(requestOrigin)) {
    throw new RelaySecurityError(
      `Origin "${requestOrigin}" is not in the allowed list.`,
      'INVALID_ORIGIN',
    );
  }
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

/** Strip ANSI escape codes from a string. */
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

/** Strip dangerous characters that could corrupt terminal output or inject fake lines. */
export function sanitiseMessage(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, '')         // strip ANSI escapes
    .replace(/\r/g, '')                  // strip carriage returns
    .replace(/\x00/g, '')               // strip null bytes
    .slice(0, 4096);                     // hard message length cap
}

/**
 * Deep-sanitise structured data by JSON round-tripping.
 * This rejects non-serialisable values (functions, undefined, circular refs)
 * and strips prototype pollution attempts.
 */
export function sanitiseData(raw: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(raw));
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
        out[key] = keyMatches(key, patterns) ? REDACTED : walk(val);
      }
      return out;
    }
    return value;
  }

  return walk(data);
}
