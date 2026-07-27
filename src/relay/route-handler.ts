/**
 * @file relay/route-handler.ts
 * Drop-in Next.js 16 Route Handler for the relay fallback transport.
 *
 * Usage — create `app/api/log-relay/route.ts` in your Next.js app containing:
 *
 *   export { POST } from '@developerehsan/nextjs-logger/relay/route-handler';
 *
 * This is the ONLY network-facing surface of the entire library, which is
 * why every defensive check lives here: origin validation, HMAC signature
 * verification, replay-window enforcement, payload size limits, and
 * per-entry structural validation. A request that fails ANY check is
 * rejected with a 4xx and NOTHING is written to the terminal — this is
 * the boundary that guarantees "outside users can never log into the
 * terminal."
 */

import {
  verifyPayload,
  RelaySecurityError,
  mintSessionToken,
  shouldRenewSession,
} from "../security/index";
import { checkRateLimit, clientKeyFromHeaders } from "../security/rate-limit";
import { writeBatchToTerminal } from "../transport/server";
import { getConfig } from "../core/logger";
import { sourceMapsEnabled } from "../core/config";
import type { RelayPayload, RelayResponse } from "../core/types";

// Route handlers in Next.js 16 run on the Node.js runtime by default,
// which is required here since we use Node's crypto-backed HMAC verify
// (Web Crypto is available on Edge too, but stick to Node for stdout access).
export const runtime = "nodejs";

// Logging endpoints must never be statically cached or pre-rendered.
export const dynamic = "force-dynamic";

/**
 * Set LOGGER_DEBUG_RELAY=1 to have rejected relay requests log *why* they
 * were rejected to the server terminal (never to the client response —
 * the 4xx returned to the browser stays generic either way). Useful when
 * diagnosing a misconfigured secret/origin without guessing blind.
 */
function debugLog(message: string): void {
  if (process.env.LOGGER_DEBUG_RELAY === "1") {
    console.warn(`[logger relay] ${message}`);
  }
}

export async function POST(request: Request) {
  // Read the config lazily, per request, via the shared accessor in
  // core/logger.ts rather than building an independent copy here — this is
  // the same physical module (and thus the same mutable state) that
  // `configureLogger()` updates from the app's main entry point, so
  // settings like `prettyPrint`/`redactKeys` stay consistent between
  // directly-written server logs and client-relayed ones.
  const config = getConfig();

  try {
    // ── Rate limit, before any parsing work ──────────────────────────────
    // Runs first because it is the cheapest check and the one that matters
    // most under load. The client-side Pacer does NOT protect this endpoint:
    // it throttles our own queue, and an attacker simply doesn't use it. The
    // session token is readable from the page HTML by anyone who can load the
    // page, so a valid token is not a scarce resource — this cap is what
    // bounds what a holder of one can actually do.
    if (config.relayRateLimit !== false) {
      const key = clientKeyFromHeaders(request.headers);
      const { allowed, retryAfterSeconds } = checkRateLimit(
        key,
        config.relayRateLimit,
      );
      if (!allowed) {
        debugLog(`rejected: rate limit exceeded for key ${key}`);
        return Response.json(
          { ok: false },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfterSeconds) },
          },
        );
      }

      // The shared (typically Redis) limiter, if one is configured. Runs
      // second so the free in-memory check absorbs an obvious flood without
      // a network round trip, and so a burst that a single instance can
      // reject never touches Redis at all. It fails open by contract — see
      // `security/rate-limit-redis.ts`.
      if (config.relayRateLimitAsync) {
        const shared = await config.relayRateLimitAsync(
          key,
          config.relayRateLimit,
        );
        if (!shared.allowed) {
          debugLog(`rejected: shared rate limit exceeded for key ${key}`);
          return Response.json(
            { ok: false },
            {
              status: 429,
              headers: { "Retry-After": String(shared.retryAfterSeconds) },
            },
          );
        }
      }
    }

    // Defensive content-length check before even reading the body
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 256 * 1024) {
      debugLog(`rejected: content-length ${contentLength} exceeds 256KB cap`);
      return Response.json(
        { ok: false, error: "Payload too large" },
        { status: 413 },
      );
    }

    const rawBody = await request.text();
    const payload = JSON.parse(rawBody);

    const entries = await verifyPayload(
      payload,
      rawBody.length,
      config.relaySecret,
      config.allowedOrigins,
      request.headers.get("origin"),
      request.headers.get("referer"),
    );

    writeBatchToTerminal(entries, {
      prettyPrint: config.prettyPrint,
      redactKeys: config.redactKeys,
      transports: config.transports,
      // This is the path that matters most for source maps: every frame in
      // a relayed browser stack is a minified chunk offset until it's
      // mapped. See LoggerConfig.sourceMaps.
      resolveSourceMaps: sourceMapsEnabled(config),
    });

    // Rolling session renewal. Past the halfway mark of the validity window,
    // hand back a fresh token so a long-lived tab never silently ages out.
    // This grants nothing new — the caller had to present a valid token to
    // reach this line — which is why it is safe to do here rather than
    // exposing a public mint endpoint.
    const body: RelayResponse = { ok: true };
    if (shouldRenewSession((payload as RelayPayload).issuedAt)) {
      const issuedAt = new Date().toISOString();
      body.session = {
        token: await mintSessionToken(config.relaySecret, issuedAt),
        issuedAt,
      };
    }

    return Response.json(body, { status: 200 });
  } catch (err) {
    if (err instanceof RelaySecurityError) {
      // Security rejections return a generic 4xx — we deliberately do NOT
      // leak which specific check failed, to avoid helping an attacker
      // iterate toward a valid forged payload.
      debugLog(`rejected: ${err.code} — ${err.message}`);
      const status =
        err.code === "PAYLOAD_TOO_LARGE"
          ? 413
          : err.code === "INVALID_ORIGIN"
          ? 403
          : 401;
      return Response.json({ ok: false }, { status });
    }

    // Malformed JSON or unexpected error — do not write anything to the
    // terminal, do not echo internals back to the client.
    debugLog(
      `rejected: unexpected error — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return Response.json({ ok: false }, { status: 400 });
  }
}

/**
 * Explicitly reject every other HTTP method.
 * Next.js will 405 automatically for unexported methods, but being
 * explicit here documents intent and guards against future framework
 * changes to that default behaviour.
 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: false }, { status: 405 });
}
