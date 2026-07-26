/**
 * @file relay/route-handler.ts
 * Drop-in Next.js 16 Route Handler for the relay fallback transport.
 *
 * Usage — create `app/api/__log/route.ts` in your Next.js app containing:
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

import { NextRequest, NextResponse } from 'next/server';
import { verifyPayload, RelaySecurityError } from '../security/index';
import { writeBatchToTerminal } from '../transport/server';
import { getConfig } from '../core/logger';

// Route handlers in Next.js 16 run on the Node.js runtime by default,
// which is required here since we use Node's crypto-backed HMAC verify
// (Web Crypto is available on Edge too, but stick to Node for stdout access).
export const runtime = 'nodejs';

// Logging endpoints must never be statically cached or pre-rendered.
export const dynamic = 'force-dynamic';

/**
 * Set LOGGER_DEBUG_RELAY=1 to have rejected relay requests log *why* they
 * were rejected to the server terminal (never to the client response —
 * the 4xx returned to the browser stays generic either way). Useful when
 * diagnosing a misconfigured secret/origin without guessing blind.
 */
function debugLog(message: string): void {
  if (process.env.LOGGER_DEBUG_RELAY === '1') {
    console.warn(`[logger relay] ${message}`);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Read the config lazily, per request, via the shared accessor in
  // core/logger.ts rather than building an independent copy here — this is
  // the same physical module (and thus the same mutable state) that
  // `configureLogger()` updates from the app's main entry point, so
  // settings like `prettyPrint`/`redactKeys` stay consistent between
  // directly-written server logs and client-relayed ones.
  const config = getConfig();

  try {
    // Defensive content-length check before even reading the body
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (contentLength > 256 * 1024) {
      debugLog(`rejected: content-length ${contentLength} exceeds 256KB cap`);
      return NextResponse.json(
        { ok: false, error: 'Payload too large' },
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
      request.headers.get('origin'),
      request.headers.get('referer'),
    );

    writeBatchToTerminal(entries, {
      prettyPrint: config.prettyPrint,
      redactKeys: config.redactKeys,
      transports: config.transports,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    if (err instanceof RelaySecurityError) {
      // Security rejections return a generic 4xx — we deliberately do NOT
      // leak which specific check failed, to avoid helping an attacker
      // iterate toward a valid forged payload.
      debugLog(`rejected: ${err.code} — ${err.message}`);
      const status =
        err.code === 'PAYLOAD_TOO_LARGE' ? 413 :
        err.code === 'INVALID_ORIGIN' ? 403 :
        401;
      return NextResponse.json({ ok: false }, { status });
    }

    // Malformed JSON or unexpected error — do not write anything to the
    // terminal, do not echo internals back to the client.
    debugLog(`rejected: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}

/**
 * Explicitly reject every other HTTP method.
 * Next.js will 405 automatically for unexported methods, but being
 * explicit here documents intent and guards against future framework
 * changes to that default behaviour.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false }, { status: 405 });
}
