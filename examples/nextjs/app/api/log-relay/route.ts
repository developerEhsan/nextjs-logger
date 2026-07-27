/**
 * @file app/api/log-relay/route.ts
 * The relay fallback transport (used automatically if the Server Action
 * path isn't available, or as a retry fallback after 3 failed Server
 * Action attempts). Every defensive check — session-token verification,
 * origin allowlisting, payload size/entry-count limits, structural
 * validation — lives inside the package; this file is intentionally a
 * one-liner.
 *
 * Set LOGGER_DEBUG_RELAY=1 in .env.local to have rejected requests log
 * *why* they were rejected to this terminal (never to the client).
 */
export { POST } from '@developerehsan/nextjs-logger/relay/route-handler';
