/**
 * @file config.ts
 * Default configuration and runtime-specific overrides.
 *
 * Design decisions:
 *  - debug/info use throttle (high volume, low urgency → smooth the firehose).
 *  - warn  uses debounce  (consolidate bursts into a single meaningful flush).
 *  - error/fatal use rateLimit (hard cap — server must never be flooded).
 */

import type { LoggerConfig, PacerPolicy, LogLevel } from './types';
import { getNodeBuffer } from '../utils/node-globals';

// ─── Default redaction ────────────────────────────────────────────────────────

/** Common secret-shaped field names, redacted from `data` by default. */
export const DEFAULT_REDACT_KEYS: (string | RegExp)[] = [
  'password',
  'pass',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'creditCard',
  'credit_card',
  'ssn',
  /token$/i,
  /secret$/i,
];

// ─── Per-level Pacer defaults ────────────────────────────────────────────────

/**
 * These are intentionally conservative.
 * Applications override them via `createLogger({ pacerPolicies: { ... } })`.
 */
export const DEFAULT_PACER_POLICIES: Record<LogLevel, PacerPolicy> = {
  debug: {
    strategy: 'throttle',
    windowMs: 500, // At most one flush per 500 ms for debug noise
  },
  info: {
    strategy: 'throttle',
    windowMs: 300, // Slightly tighter for info — more actionable
  },
  warn: {
    strategy: 'debounce',
    waitMs: 200, // Wait for a 200 ms quiet period, then flush the batch
  },
  error: {
    strategy: 'rateLimit',
    limit: 10,          // Max 10 relay calls per window
    windowMs: 5_000,    // 5-second window
    windowType: 'sliding',
  },
  fatal: {
    strategy: 'rateLimit',
    limit: 3,           // Fatals are rare — 3 per 10 s max
    windowMs: 10_000,
    windowType: 'sliding',
  },
};

// ─── Environment helpers ──────────────────────────────────────────────────────

/** Returns true when running inside a Node.js process (server / Edge Runtime). */
export const isServer = (): boolean =>
  typeof window === 'undefined';

/** Returns true when Next.js NODE_ENV is 'development'. */
export const isDev = (): boolean =>
  process.env.NODE_ENV === 'development';

/** Returns true when running in the Edge Runtime (no Node.js built-ins). */
export const isEdgeRuntime = (): boolean =>
  typeof process !== 'undefined' &&
  (process.env.NEXT_RUNTIME === 'edge');

// ─── Relay secret bootstrap ──────────────────────────────────────────────────

/**
 * Derive the relay secret at module initialization time.
 *
 * Priority chain:
 *  1. LOGGER_RELAY_SECRET env var (set by the operator in production).
 *  2. Fallback: a value derived from NEXTAUTH_SECRET / APP_SECRET — both
 *     server-only secrets that never reach the client bundle.
 *  3. Development-only hard-coded warning value.
 *
 * Deliberately does NOT fall back to NEXT_PUBLIC_APP_URL (or any other
 * NEXT_PUBLIC_* value): those are shipped verbatim into the client
 * JavaScript bundle, so deriving the "secret" from one would let anyone
 * read the page source and reconstruct it themselves — silently defeating
 * the entire relay authentication model. The secret is intentionally NOT
 * exposed via NEXT_PUBLIC_* env vars; the client receives only a signed,
 * time-scoped session token, never the raw secret.
 */
/**
 * UTF-8-safe base64 encoding without relying on the Node `Buffer` global,
 * so this works identically on the Edge Runtime and other non-Node
 * runtimes (Cloudflare Workers, etc.) that don't polyfill `Buffer`.
 * Falls back to `Buffer` when present since it's marginally cheaper on Node.
 */
function toBase64Utf8(input: string): string {
  const NodeBuffer = getNodeBuffer();
  if (NodeBuffer) {
    return NodeBuffer.from(input, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function deriveRelaySecret(): string {
  const explicit = process.env.LOGGER_RELAY_SECRET;
  if (explicit && explicit.length >= 32) return explicit;

  const fallback = process.env.NEXTAUTH_SECRET || process.env.APP_SECRET;

  if (fallback && fallback.length >= 32) {
    console.warn(
      '[logger] ⚠️  LOGGER_RELAY_SECRET not set — deriving the relay secret ' +
      'from NEXTAUTH_SECRET/APP_SECRET instead. Set LOGGER_RELAY_SECRET to a ' +
      'dedicated 32+ character secret to avoid coupling log-relay auth to an ' +
      'unrelated secret\'s lifecycle.',
    );
    // Cheap deterministic derivation — good enough for non-crypto relay auth.
    // Uses a Buffer-free base64 encoding so this also works unmodified on
    // the Edge Runtime and other non-Node runtimes (e.g. Cloudflare
    // Workers) that don't polyfill the Node `Buffer` global.
    return toBase64Utf8(`logger:${fallback}`).slice(0, 64);
  }

  if (isDev()) {
    console.warn(
      '[logger] ⚠️  No LOGGER_RELAY_SECRET set. ' +
      'Using a weak development-only secret. ' +
      'Set LOGGER_RELAY_SECRET in production.',
    );
    return 'dev-only-secret-32-chars-minimum!!';
  }

  throw new Error(
    '[logger] LOGGER_RELAY_SECRET must be set in production. ' +
    'Minimum 32 characters.',
  );
}

// ─── Allowed origins ─────────────────────────────────────────────────────────

/** Build the list of origins that may call the relay endpoint. */
export function buildAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Always allow same-origin (undefined origin in same-site requests)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      origins.push(new URL(appUrl).origin);
    } catch {
      // ignore malformed URL
    }
  }

  // Allow additional custom origins via comma-separated env var
  const extra = process.env.LOGGER_ALLOWED_ORIGINS;
  if (extra) {
    extra.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .forEach((o) => origins.push(o));
  }

  // In development, always allow localhost variants
  if (isDev()) {
    origins.push(
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
    );
  }

  return [...new Set(origins)]; // deduplicate
}

// ─── Default config factory ───────────────────────────────────────────────────

/**
 * Construct a LoggerConfig with production-safe defaults.
 * Callers may override any field via `createLogger(partialConfig)`.
 */
export function buildDefaultConfig(
  overrides: Partial<LoggerConfig> = {},
): LoggerConfig {
  const cfg: LoggerConfig = {
    minLevel: isDev() ? 'debug' : 'info',
    pacerPolicies: { ...DEFAULT_PACER_POLICIES, ...overrides.pacerPolicies },
    // Placeholder — replaced below by a lazy getter (or the override, if
    // one was given) so importing/creating a logger never eagerly derives
    // (and potentially throws for) a secret that a relay-less app never
    // needs. See the lazy `relaySecret` getter below.
    relaySecret: '__client__',
    maxQueueSize: 500,
    prettyPrint: isDev(),
    allowedOrigins: buildAllowedOrigins(),
    ...overrides,
    // Merged rather than spread-overwritten so overrides *add* redact
    // patterns instead of silently disabling the sensible defaults.
    redactKeys: [...DEFAULT_REDACT_KEYS, ...(overrides.redactKeys ?? [])],
  };

  // `relaySecret` is derived lazily, on first read, rather than eagerly
  // here. Eager derivation used to run at *module import time* (via the
  // `log` singleton's `buildDefaultConfig()` call) and at every
  // `createLogger()` call — meaning an app that only ever calls
  // `log.info()` server-side (and never wires up the client relay) would
  // still crash on import/instantiation in production if
  // `LOGGER_RELAY_SECRET` wasn't set, since `deriveRelaySecret()` throws
  // in that case. Deferring the derivation to first access means the
  // secret (and its potential throw) is only ever touched by code paths
  // that actually relay/verify a token — LoggerProvider, the route
  // handler, and the Server Action — exactly the code that needs it.
  if (overrides.relaySecret === undefined) {
    let cached: string | undefined;
    Object.defineProperty(cfg, 'relaySecret', {
      enumerable: true,
      configurable: true,
      get(): string {
        if (cached === undefined) {
          cached = isServer() ? deriveRelaySecret() : '__client__';
        }
        return cached;
      },
    });
  }

  return cfg;
}
