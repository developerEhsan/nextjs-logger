/**
 * @file security/__tests__/hardening.test.ts
 *
 * Covers controls the threat model *claimed* but did not implement, plus the
 * ones added alongside them. Each block names the gap it closes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sanitiseMessage,
  sanitiseData,
  redact,
  isOriginAllowed,
  shouldRenewSession,
  SESSION_MAX_AGE_MS,
} from '../index';
import { checkRateLimit, clientKeyFromHeaders, _resetRateLimit } from '../rate-limit';
import { writeToTerminal } from '../../transport/server';
import type { LogEntry } from '../../core/types';

describe('log injection — newlines', () => {
  /**
   * The file header listed "newline injection → sanitised before printing" as
   * a blocked threat, but the implementation only stripped `\r`. A relayed
   * message could therefore print a second line that looked exactly like a
   * genuine log entry.
   */
  it('escapes newlines instead of letting them forge a second log line', () => {
    const forged = 'looks fine\n01:02:03 [FATAL] credentials rotated';
    const out = sanitiseMessage(forged);

    expect(out).not.toContain('\n');
    // Escaped, not deleted — the content stays auditable.
    expect(out).toContain('\\n');
    expect(out).toContain('credentials rotated');
  });

  it('handles CR, LF and CRLF alike', () => {
    expect(sanitiseMessage('a\rb\nc\r\nd')).toBe('a\\nb\\nc\\nd');
  });
});

describe('log injection — terminal escape sequences', () => {
  it('strips CSI colour codes', () => {
    expect(sanitiseMessage('\x1B[31mred\x1B[0m')).toBe('red');
  });

  /**
   * The original pattern only matched CSI (`ESC [ … letter`), so these three
   * families reached the terminal untouched.
   */
  it('strips OSC sequences that can rewrite the terminal title', () => {
    expect(sanitiseMessage('\x1B]0;pwned\x07safe')).toBe('safe');
  });

  it('strips a bare ESC and terminal-reset sequences', () => {
    expect(sanitiseMessage('\x1Bcreset')).not.toContain('\x1B');
    expect(sanitiseMessage('a\x1Bb')).not.toContain('\x1B');
  });

  it('strips remaining control bytes including NUL and backspace', () => {
    expect(sanitiseMessage('a\x00b\x08c\x7Fd')).toBe('abcd');
  });
});

describe('log injection — context fields', () => {
  /**
   * `verifyPayload` only checks that `context` is an object, and the pretty
   * formatter interpolated its strings verbatim. That made `namespace` a
   * second injection point which bypassed all the message hardening.
   */
  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return chunks.join('');
  }

  const hostileEntry: LogEntry = {
    level: 'info',
    message: 'hello',
    context: {
      runtime: 'client',
      timestamp: '2026-07-27T01:02:03.000Z',
      sequence: 0,
      namespace: 'evil\n01:02:03 [FATAL] forged',
      caller: '\x1B[31mred',
      requestId: 'id\x00\x1B]0;title\x07',
    },
  };

  it('cannot forge a second terminal line through context.namespace', () => {
    const out = captureStdout(() =>
      writeToTerminal(hostileEntry, { prettyPrint: true, redactKeys: [] }),
    );

    // Exactly one line: the trailing newline the writer appends, and no other.
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    expect(out).toContain('\\n01:02:03 [FATAL] forged');
  });

  it('strips escape sequences from caller and requestId in the printed line', () => {
    const out = captureStdout(() =>
      writeToTerminal(hostileEntry, { prettyPrint: true, redactKeys: [] }),
    );

    expect(out).toContain('(red)');
    // The OSC sequence is removed whole — payload included — so the injected
    // window title never reaches the terminal as text either.
    expect(out).toContain('req:id');
    expect(out).not.toContain('title');
    expect(out).not.toContain('\x1B]0;');
  });

  it('keeps the JSON format single-line and escaped too', () => {
    const out = captureStdout(() =>
      writeToTerminal(hostileEntry, { prettyPrint: false, redactKeys: [] }),
    );

    expect(out.trimEnd().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed.namespace).not.toContain('\n');
    expect(parsed.caller).toBe('red');
  });
});

describe('prototype pollution', () => {
  /**
   * `sanitiseData`'s docblock claimed a JSON round-trip stripped prototype
   * pollution. It does not: `JSON.parse` happily creates an *own* `__proto__`
   * key.
   */
  it('drops __proto__ keys rather than carrying them through', () => {
    const payload = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    const clean = sanitiseData(payload) as Record<string, unknown>;

    expect(clean.a).toBe(1);
    expect(Object.keys(clean)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('redact() creates own data properties for dangerous key names', () => {
    const input = JSON.parse('{"__proto__":"x","password":"hunter2"}');
    const out = redact(input, ['password']) as Record<string, unknown>;

    expect(out.password).toBe('[REDACTED]');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('origin allowlist', () => {
  /**
   * The dev allowlist used to hardcode :3000/:3001. Next moves to the next
   * free port when 3000 is taken, and browsers send `Origin` on same-origin
   * POSTs — so a dev server on :3002 got a 403 and all browser logs vanished,
   * with a deliberately-generic error body giving no hint why.
   */
  it('accepts any loopback port in development via the :* form', () => {
    const allowed = ['http://localhost:*', 'http://127.0.0.1:*'];
    expect(isOriginAllowed('http://localhost:3002', allowed)).toBe(true);
    expect(isOriginAllowed('http://localhost:54321', allowed)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', allowed)).toBe(true);
  });

  it('never lets the port wildcard widen to another host', () => {
    const allowed = ['http://localhost:*'];
    expect(isOriginAllowed('http://localhost.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://localhost:3000', allowed)).toBe(false);
  });

  it('still requires an exact match for non-wildcard entries', () => {
    expect(isOriginAllowed('https://app.example.com', ['https://app.example.com'])).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', ['https://app.example.com'])).toBe(false);
  });
});

describe('relay rate limiting', () => {
  beforeEach(_resetRateLimit);

  /**
   * The client-side Pacer was described as the flood protection for this
   * endpoint. It throttles our own queue — the one caller guaranteed not to
   * abuse it. An attacker POSTs directly, and the session token is readable
   * by anyone who can load the page.
   */
  it('allows traffic up to the limit and rejects beyond it', () => {
    const policy = { limit: 3, windowMs: 1000 };
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('1.2.3.4', policy, 0).allowed).toBe(true);
    }
    const blocked = checkRateLimit('1.2.3.4', policy, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('buckets keys independently', () => {
    const policy = { limit: 1, windowMs: 1000 };
    expect(checkRateLimit('a', policy, 0).allowed).toBe(true);
    expect(checkRateLimit('b', policy, 0).allowed).toBe(true);
    expect(checkRateLimit('a', policy, 0).allowed).toBe(false);
  });

  it('opens a new window once the old one elapses', () => {
    const policy = { limit: 1, windowMs: 1000 };
    expect(checkRateLimit('a', policy, 0).allowed).toBe(true);
    expect(checkRateLimit('a', policy, 500).allowed).toBe(false);
    expect(checkRateLimit('a', policy, 1001).allowed).toBe(true);
  });

  it('derives a key from forwarding headers, falling back to a shared bucket', () => {
    expect(clientKeyFromHeaders(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })))
      .toBe('9.9.9.9');
    expect(clientKeyFromHeaders(new Headers({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    // No header: everyone shares one bucket, which still bounds total volume.
    expect(clientKeyFromHeaders(new Headers())).toBe('unknown');
  });
});

describe('rolling session renewal', () => {
  it('renews only after the halfway mark of the validity window', () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000).toISOString();
    const old = new Date(now - SESSION_MAX_AGE_MS * 0.75).toISOString();

    expect(shouldRenewSession(fresh, now)).toBe(false);
    expect(shouldRenewSession(old, now)).toBe(true);
  });

  it('does not renew on an unparseable issuedAt', () => {
    expect(shouldRenewSession('not-a-date', Date.now())).toBe(false);
  });
});
