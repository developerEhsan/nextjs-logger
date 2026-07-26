/**
 * @file relay/server-action.ts
 * Server Action variant of the relay transport.
 *
 * Why prefer this over the API route:
 *  • No CORS / origin header dance — Server Actions are POSTed through
 *    Next.js's own RSC "Flight" protocol, which already includes its own
 *    CSRF protections (Origin header check + same-origin enforcement)
 *    built into Next.js 16 itself.
 *  • Slightly less overhead than a manual fetch() to a JSON API route.
 *  • Automatically tree-shaken out of the client bundle except for the
 *    small reference stub React serialises — the actual implementation
 *    never ships to the browser.
 *
 * Usage — in your bootstrap component (see provider.tsx), import this
 * Server Action and pass it into `initClientLogger({ serverAction })`.
 * Because Server Actions must be defined in a file with the 'use server'
 * directive and can only be imported (not re-exported as plain values)
 * into Client Components, we keep this isolated in its own module.
 *
 * Security note: Server Actions still pass through arbitrary serialisable
 * arguments, so this function performs the SAME verification rigor as the
 * API route — origin checking is implicit (Next.js verifies the action's
 * encrypted reference token came from a page it rendered), but we still
 * apply structural validation and payload-size guards defensively, since
 * defense-in-depth matters more than trusting a single layer.
 */

'use server';

import type { LogEntry } from '../core/types';
import { writeBatchToTerminal } from '../transport/server';
import { getConfig } from '../core/logger';
import { sanitiseData } from '../security/index';

const MAX_ENTRIES_PER_CALL = 100;
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

function debugLog(message: string): void {
  if (process.env.LOGGER_DEBUG_RELAY === '1') {
    console.warn(`[logger relay:action] ${message}`);
  }
}

/**
 * The Server Action invoked by the client queue.
 * Next.js automatically attaches CSRF protection to this endpoint —
 * it can only be invoked from a page/action reference that the server
 * itself rendered, which is a strictly stronger guarantee than a public
 * HTTP endpoint.
 */
export async function relayLogEntries(entries: LogEntry[]): Promise<void> {
  // Read lazily (not at module scope) via the shared accessor in
  // core/logger.ts so this stays in sync with `configureLogger()` and
  // with the API route handler — see the note there for why building an
  // independent config here used to silently diverge.
  const config = getConfig();

  // Structural / size guard — identical rigor to the API route, because
  // we never assume the framework-level CSRF protection is sufficient
  // on its own (defense in depth).
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES_PER_CALL) {
    debugLog(`rejected: invalid batch (array=${Array.isArray(entries)}, length=${entries?.length})`);
    throw new Error('Invalid log batch.');
  }

  const sanitised: LogEntry[] = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !VALID_LEVELS.has((entry as LogEntry).level) ||
      typeof (entry as LogEntry).message !== 'string'
    ) {
      continue; // skip malformed entries rather than failing the whole batch
    }
    sanitised.push({
      ...entry,
      message: entry.message.slice(0, 4096),
      data: entry.data !== undefined ? sanitiseData(entry.data) : undefined,
    });
  }

  if (sanitised.length > 0) {
    writeBatchToTerminal(sanitised, {
      prettyPrint: config.prettyPrint,
      redactKeys: config.redactKeys,
      transports: config.transports,
    });
  }
}
